import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { runAttribution } from '@/services/api';
import { snapshots as seedSnapshots } from '@/data/sampleData';
import type {
  AttributionRun,
  BudgetPlan,
  DataSnapshot,
  RunConfig,
  SharedReport,
} from '@/types/domain';

/** 轻量配置校验和：审批/分享时核对来源修订与运行参数 */
export function configChecksum(config: RunConfig): string {
  const raw = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `chk:${(hash >>> 0).toString(16)}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 对比两个快照，生成迟到退款/净额变化清单。迟到判定只看输入血缘，不依赖墙上时钟。 */
export function diffSnapshots(oldSnap: DataSnapshot, newSnap: DataSnapshot) {
  const oldMap = new Map(oldSnap.orderVersions.map((v) => [v.orderId, v]));
  const newOrders: string[] = [];
  const changedOrders: string[] = [];
  const refundedAfterLock: string[] = [];

  for (const nv of newSnap.orderVersions) {
    const ov = oldMap.get(nv.orderId);
    if (!ov) {
      newOrders.push(nv.orderId);
    } else if (ov.netAmount !== nv.netAmount || ov.status !== nv.status) {
      changedOrders.push(nv.orderId);
    }
  }
  // 新快照中存在、但锁定运行所消费的旧快照中不存在的退款，
  // 即运行输入冻结之后才到达的迟到退款（运行锁定后不回改旧图表）。
  for (const r of newSnap.refunds) {
    if (!oldSnap.refunds.some((x) => x.refundId === r.refundId)) {
      refundedAfterLock.push(r.orderId);
    }
  }
  return { newOrders, changedOrders, refundedAfterLock: [...new Set(refundedAfterLock)] };
}

interface AppState {
  currentUserId: string;
  snapshots: DataSnapshot[];
  runs: AttributionRun[];
  sharedReports: SharedReport[];
  budgetPlans: BudgetPlan[];

  switchUser: (userId: string) => void;
  createDraftRun: (input: { snapshotId: string; config: RunConfig }) => string;
  updateDraftConfig: (runId: string, patch: Partial<RunConfig>) => void;
  executeRun: (runId: string) => Promise<void>;
  approveRun: (runId: string, approverId: string) => { ok: boolean; message: string };
  lockRun: (runId: string) => { ok: boolean; message: string };
  createSupersedingRun: (parentRunId: string, newSnapshotId: string) => string | null;
  createSharedReport: (runId: string, title: string, createdBy: string) => { ok: boolean; shareId?: string; message: string };
  revokeSharedReport: (shareId: string) => void;
  saveBudgetPlan: (plan: BudgetPlan) => void;
  resetDemo: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentUserId: 'U-1001',
      snapshots: seedSnapshots,
      runs: [],
      sharedReports: [],
      budgetPlans: [],

      switchUser: (userId) => set({ currentUserId: userId }),

      createDraftRun: ({ snapshotId, config }) => {
        const runId = uid('RUN');
        const analyst = get().currentUserId;
        const snapshot = get().snapshots.find((s) => s.snapshotId === snapshotId);
        const run: AttributionRun = {
          runId,
          snapshotId,
          dataVersion: snapshot?.dataVersion ?? 'unknown',
          analyst,
          createdAt: new Date().toISOString(),
          status: 'draft',
          // 草稿绑定创建时快照的规则修订；后续快照升级不会静默改写草稿
          config: { ...config, ruleRevision: snapshot?.ruleRevision ?? config.ruleRevision },
        };
        set((s) => ({ runs: [...s.runs, run] }));
        return runId;
      },

      updateDraftConfig: (runId, patch) =>
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId && r.status === 'draft' ? { ...r, config: { ...r.config, ...patch } } : r,
          ),
        })),

      executeRun: async (runId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run || (run.status !== 'draft' && run.status !== 'superseded')) return;
        set((s) => ({
          runs: s.runs.map((r) => (r.runId === runId ? { ...r, status: 'running' } : r)),
        }));
        try {
          const results = await runAttribution(run.snapshotId, run.config);
          set((s) => ({
            runs: s.runs.map((r) =>
              r.runId === runId && r.status === 'running'
                ? { ...r, results, status: 'completed' }
                : r,
            ),
          }));
        } catch {
          // 计算失败回退为草稿，允许修正参数重试
          set((s) => ({
            runs: s.runs.map((r) => (r.runId === runId ? { ...r, status: 'draft' } : r)),
          }));
        }
      },

      approveRun: (runId, approverId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run) return { ok: false, message: '运行不存在' };
        if (run.status !== 'completed') return { ok: false, message: '只有已完成运行可提交审批' };
        const snapshot = get().snapshots.find((s) => s.snapshotId === run.snapshotId);
        const revisionMatched = snapshot?.ruleRevision === run.config.ruleRevision;
        const checksum = configChecksum(run.config);
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId
              ? {
                  ...r,
                  approval: {
                    approvedBy: approverId,
                    approvedAt: new Date().toISOString(),
                    sourceRevision: snapshot?.ruleRevision ?? 'unknown',
                    ruleRevision: run.config.ruleRevision,
                    configChecksum: checksum,
                    revisionMatched,
                  },
                }
              : r,
          ),
        }));
        return revisionMatched
          ? { ok: true, message: '审批通过：来源规则修订与运行配置一致' }
          : { ok: false, message: '审批驳回：运行绑定的规则修订与当前快照不一致，请基于新快照重建运行' };
      },

      lockRun: (runId) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run) return { ok: false, message: '运行不存在' };
        if (run.status !== 'completed') return { ok: false, message: '只有已完成运行可锁定' };
        if (!run.approval) return { ok: false, message: '缺少审批记录，不能锁定' };
        if (!run.approval.revisionMatched) return { ok: false, message: '审批修订核对未通过，不能锁定' };
        set((s) => ({
          runs: s.runs.map((r) =>
            r.runId === runId ? { ...r, status: 'locked', lockedAt: new Date().toISOString() } : r,
          ),
        }));
        return { ok: true, message: '运行已锁定，结果与分享快照不可变' };
      },

      createSupersedingRun: (parentRunId, newSnapshotId) => {
        const parent = get().runs.find((r) => r.runId === parentRunId);
        if (!parent || !parent.lockedAt) return null;
        const oldSnap = get().snapshots.find((s) => s.snapshotId === parent.snapshotId);
        const newSnap = get().snapshots.find((s) => s.snapshotId === newSnapshotId);
        if (!oldSnap || !newSnap) return null;
        const runId = uid('RUN');
        const run: AttributionRun = {
          runId,
          snapshotId: newSnapshotId,
          dataVersion: newSnap.dataVersion,
          analyst: get().currentUserId,
          createdAt: new Date().toISOString(),
          status: 'draft',
          config: { ...parent.config, ruleRevision: newSnap.ruleRevision },
          parentRunId,
          changeSummary: diffSnapshots(oldSnap, newSnap),
        };
        set((s) => ({ runs: [...s.runs, run] }));
        return runId;
      },

      createSharedReport: (runId, title, createdBy) => {
        const run = get().runs.find((r) => r.runId === runId);
        if (!run || !run.results) return { ok: false, message: '运行不存在或尚无结果' };
        if (run.status !== 'locked') return { ok: false, message: '只有已锁定运行才能生成共享报告' };
        const shareId = uid('SHARE');
        const report: SharedReport = {
          shareId,
          runId,
          snapshotId: run.snapshotId,
          title,
          createdBy,
          createdAt: new Date().toISOString(),
          status: 'active',
          // 冻结载荷：复制运行结果，后续新运行/新退款不会影响旧分享
          frozen: {
            dataVersion: run.dataVersion,
            ruleRevision: run.config.ruleRevision,
            config: structuredClone(run.config),
            channelSummaries: structuredClone(run.results.channelSummaries),
            orderAttributions: structuredClone(run.results.orderAttributions),
            unknownRevenue: run.results.unknownRevenue,
            totalNetRevenue: run.results.totalNetRevenue,
            totalAllocated: run.results.totalAllocated,
          },
        };
        set((s) => ({ sharedReports: [...s.sharedReports, report] }));
        return { ok: true, shareId, message: '共享报告已生成并冻结' };
      },

      revokeSharedReport: (shareId) =>
        set((s) => ({
          sharedReports: s.sharedReports.map((r) => (r.shareId === shareId ? { ...r, status: 'revoked' } : r)),
        })),

      saveBudgetPlan: (plan) =>
        set((s) => {
          const exists = s.budgetPlans.some((p) => p.planId === plan.planId);
          return {
            budgetPlans: exists
              ? s.budgetPlans.map((p) => (p.planId === plan.planId ? plan : p))
              : [...s.budgetPlans, plan],
          };
        }),

      resetDemo: () => set({ runs: [], sharedReports: [], budgetPlans: [], currentUserId: 'U-1001' }),
    }),
    {
      name: 'attribution-workbench-v1',
      partialize: (s) => ({
        currentUserId: s.currentUserId,
        runs: s.runs,
        sharedReports: s.sharedReports,
        budgetPlans: s.budgetPlans,
      }),
    },
  ),
);
