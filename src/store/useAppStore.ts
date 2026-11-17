import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ActivityHourRow,
  AdjustmentVoucher,
  BillRow,
  Confirmation,
  DatasetKind,
  FieldMapping,
  FxRateRow,
  ImportBatch,
  MappingInterval,
  PartitionKey,
  ReconcileRun,
  RunTrigger,
} from '@/types/domain';
import {
  buildActivityRows,
  buildBillRows,
  buildFxRows,
  parseCsv,
  parseJsonFile,
} from '@/engine/parse';
import { decideIngestion } from '@/engine/dedup';
import { buildReconcileRun, deriveMappingIntervals, partitionKeyString } from '@/engine/reconcile';
import {
  applyConfirmationState,
  buildAdjustmentVouchers,
  confirmPartition,
} from '@/engine/versions';
import { INITIAL_SAMPLE_FILES, type SampleFile } from '@/data/sampleFiles';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface ImportOutcome {
  batchId: string;
  kind: DatasetKind;
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  revisionCount: number;
  messages: string[];
}

interface AppState {
  currentUserId: string;
  batches: ImportBatch[];
  mappings: FieldMapping[];
  runs: ReconcileRun[];
  adjustments: AdjustmentVoucher[];
  confirmations: Confirmation[];
  mappingOverrides: MappingInterval[];
  closedPartitionKeys: string[];
  fxVersion: string;

  switchUser: (userId: string) => void;
  saveMapping: (input: { name: string; kind: DatasetKind; columns: Record<string, string>; constants?: Record<string, string> }) => FieldMapping;
  importSample: (sample: SampleFile) => ImportOutcome;
  importFile: (input: {
    kind: DatasetKind;
    fileName: string;
    format: 'csv' | 'json';
    text: string;
    columns: Record<string, string>;
    constants?: Record<string, string>;
  }) => ImportOutcome;
  setFxVersion: (version: string) => void;
  createRun: (trigger: RunTrigger, note?: string) => ReconcileRun;
  confirm: (input: {
    level: 'account' | 'campaign';
    partition: PartitionKey;
    campaignId?: string;
    fxReview?: { oldDiffMinor: number; newDiffMinor: number };
  }) => { ok: boolean; message: string };
  closePartition: (partition: PartitionKey) => { ok: boolean; message: string };
  applyMappingFix: (intervals: MappingInterval[]) => void;
  resetDemo: () => void;
}

function allRows<T extends { batchId: string }>(batches: ImportBatch[], pick: (b: ImportBatch) => T[]): T[] {
  return batches.flatMap(pick);
}

export function selectBillRows(batches: ImportBatch[]): BillRow[] {
  return allRows(batches, (b) => b.billRows);
}
export function selectActivityRows(batches: ImportBatch[]): ActivityHourRow[] {
  return allRows(batches, (b) => b.activityRows);
}
export function selectFxRows(batches: ImportBatch[]): FxRateRow[] {
  return allRows(batches, (b) => b.fxRows);
}

function seedInitialBatches(): ImportBatch[] {
  const batches: ImportBatch[] = [];
  for (const sample of INITIAL_SAMPLE_FILES) {
    // 复用与用户导入完全相同的管线，种子数据不享受任何特殊待遇
    importInto(batches, {
      kind: sample.kind,
      fileName: sample.fileName,
      format: sample.format,
      text: sample.text,
      columns: sample.mapping,
    });
  }
  return batches;
}

interface ImportArgs {
  kind: DatasetKind;
  fileName: string;
  format: 'csv' | 'json';
  text: string;
  columns: Record<string, string>;
  constants?: Record<string, string>;
}

function importInto(prevBatches: ImportBatch[], args: ImportArgs): ImportOutcome {
  const batchId = uid('BAT');
  const parsed = args.format === 'csv' ? parseCsv(args.text) : parseJsonFile(args.text);
  const messages: string[] = [];
  let billRows: BillRow[] = [];
  let activityRows: ActivityHourRow[] = [];
  let fxRows: FxRateRow[] = [];
  let rejected = parsed.rows.length === 0
    ? [{ rowNumber: 0, raw: {}, reason: '文件为空或无有效数据行' }]
    : [];
  let duplicates: ImportBatch['duplicates'] = [];
  let revisionCount = 0;

  if (args.kind === 'bill') {
    const built = buildBillRows(parsed, batchId, args.columns, args.constants);
    rejected = built.rejected;
    const prior = selectBillRows(prevBatches);
    const decisions = decideIngestion(prior, built.accepted);
    const accepted: BillRow[] = [];
    for (const d of decisions) {
      if (d.kind === 'duplicate') {
        duplicates.push({
          rowNumber: 0,
          raw: d.incoming.raw,
          reason: d.reason,
          bill: d.incoming,
          existingRowId: d.existing?.rowId ?? '',
        });
        messages.push(d.reason);
      } else {
        if (d.kind === 'revision_candidate') {
          revisionCount += 1;
          messages.push(d.reason);
        }
        accepted.push(d.incoming);
      }
    }
    billRows = accepted;
  } else if (args.kind === 'activity') {
    const built = buildActivityRows(parsed, batchId, args.columns, args.constants);
    rejected = built.rejected;
    activityRows = built.accepted;
  } else {
    const built = buildFxRows(parsed, batchId, args.columns, args.constants);
    rejected = built.rejected;
    fxRows = built.accepted;
  }

  prevBatches.push({
    batchId,
    kind: args.kind,
    fileName: args.fileName,
    format: args.format,
    importedAt: new Date().toISOString(),
    sourceColumns: parsed.headers,
    totalRows: parsed.rows.length,
    rejected,
    duplicates,
    billRows,
    activityRows,
    fxRows,
  });

  return {
    batchId,
    kind: args.kind,
    totalRows: parsed.rows.length,
    acceptedCount: billRows.length + activityRows.length + fxRows.length,
    rejectedCount: rejected.length,
    duplicateCount: duplicates.length,
    revisionCount,
    messages,
  };
}

const triggerToAdjustmentKind: Record<RunTrigger, AdjustmentVoucher['kind'] | null> = {
  late_credit: 'late_credit',
  correction: 'bill_correction',
  mapping_fix: 'mapping_revision',
  fx_revision: 'fx_revision',
  initial: null,
  reimport: null,
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentUserId: 'U-1001',
      batches: seedInitialBatches(),
      mappings: [],
      runs: [],
      adjustments: [],
      confirmations: [],
      mappingOverrides: [],
      closedPartitionKeys: [],
      fxVersion: 'FX-2026-11A',

      switchUser: (userId) => set({ currentUserId: userId }),

      saveMapping: ({ name, kind, columns, constants }) => {
        const mapping: FieldMapping = {
          mappingId: uid('MAP'),
          name,
          kind,
          columns,
          constants,
          createdAt: new Date().toISOString(),
        };
        set((s) => ({ mappings: [...s.mappings, mapping] }));
        return mapping;
      },

      importSample: (sample) => {
        const outcome = importInto(get().batches, {
          kind: sample.kind,
          fileName: sample.fileName,
          format: sample.format,
          text: sample.text,
          columns: sample.mapping,
        });
        set((s) => ({ batches: [...s.batches] }));
        return outcome;
      },

      importFile: (args) => {
        const outcome = importInto(get().batches, args);
        set((s) => ({ batches: [...s.batches] }));
        return outcome;
      },

      setFxVersion: (version) => set({ fxVersion: version }),

      createRun: (trigger, note) => {
        const state = get();
        const billRows = selectBillRows(state.batches);
        const activityRows = selectActivityRows(state.batches);
        const fxRows = selectFxRows(state.batches);
        const previousRun = state.runs[state.runs.length - 1];
        const runId = uid('RUN');
        const version = (previousRun?.version ?? 0) + 1;
        // 受理判重留痕：新版本只重放"上一运行之后新导入"的账单行，
        // 对照此前已受理行；重复候选进入行级比较，修订候选进入重算。
        const priorBatchIds = new Set(previousRun?.inputBatchIds ?? []);
        const newBillRows = billRows.filter((r) => !priorBatchIds.has(r.batchId));
        const priorBillRows = billRows.filter((r) => priorBatchIds.has(r.batchId));
        const newFxRows = fxRows.filter((r) => !previousRun?.inputBatchIds.includes(r.batchId));
        // 历史批次中的判重留痕在每个新版本都重新生成行级比较
        const duplicateDecisions = state.batches
          .flatMap((b) => b.duplicates)
          .map((d) => ({ kind: 'duplicate' as const, incoming: d.bill, reason: d.reason }));
        const ingestDecisions = [
          ...(previousRun ? decideIngestion(priorBillRows, newBillRows) : []),
          ...duplicateDecisions,
        ];
        // 重开集合：整日更正/贷项/重复件只重开其账户日；汇率修订只重开受影响币种分区；
        // 映射更正重开受影响账户的未结账分区；首次运行全量重算。
        let reopenedKeys: string[] | undefined;
        if (previousRun) {
          if (trigger === 'fx_revision') {
            const currencies = new Set(newFxRows.map((r) => r.fromCurrency));
            reopenedKeys = previousRun.accountDays
              .filter((d) => {
                if (!currencies.has(d.currency)) return false;
                const next = newFxRows.find(
                  (r) => r.fromCurrency === d.currency && r.serviceDay === d.billDay && r.rateVersion === state.fxVersion,
                );
                // 只重开服务日汇率实际变化的分区
                return !!next && next.rateText !== d.fxRateText;
              })
              .map((d) => partitionKeyString(d));
          } else if (trigger === 'mapping_fix') {
            const accounts = new Set(state.mappingOverrides.map((m) => m.accountId));
            reopenedKeys = previousRun.accountDays
              .filter((d) => accounts.has(d.accountId) && !d.closed)
              .map((d) => partitionKeyString(d));
          } else {
            // 已结账（已付款）分区不重开：整体继承，账单变化改由调整凭证承接
            reopenedKeys = [...new Set(newBillRows.map((r) => partitionKeyString(r)))]
              .filter((k) => !state.closedPartitionKeys.includes(k));
          }
        }
        const mappings = [...deriveMappingIntervals(activityRows), ...state.mappingOverrides];
        const run = buildReconcileRun({
          runId,
          version,
          parentRunId: previousRun?.runId,
          createdBy: state.currentUserId,
          createdAt: new Date().toISOString(),
          trigger,
          fxVersion: state.fxVersion,
          billRows,
          ingestDecisions: previousRun ? ingestDecisions : [],
          activityRows,
          fxRows,
          mappings,
          previousRun,
          reopenedKeys,
          closedPartitionKeys: state.closedPartitionKeys,
          note,
        });

        // 已结账分区不回改：为新到达账单行生成调整凭证（迟到贷项/更正/映射/汇率）
        const adjustmentKind = triggerToAdjustmentKind[trigger];
        let newVouchers: AdjustmentVoucher[] = [];
        if (adjustmentKind && previousRun) {
          const incoming = billRows.filter((r) => !previousRun.inputBatchIds.includes(r.batchId));
          newVouchers = buildAdjustmentVouchers({
            kind: adjustmentKind,
            runId,
            createdAt: new Date().toISOString(),
            incoming,
            previousDays: previousRun.accountDays,
            fxRows,
            fxVersion: state.fxVersion,
            note: note ?? trigger,
          });
        }

        set((s) => ({
          runs: [...s.runs, run],
          adjustments: [...s.adjustments, ...newVouchers],
        }));
        return run;
      },

      confirm: ({ level, partition, campaignId, fxReview }) => {
        const state = get();
        const run = state.runs[state.runs.length - 1];
        if (!run) return { ok: false, message: '尚无对账运行' };
        const result = confirmPartition({
          run,
          level,
          partition,
          campaignId,
          confirmedBy: state.currentUserId,
          confirmedAt: new Date().toISOString(),
          fxReview,
          existingConfirmations: state.confirmations,
        });
        if (!result.ok || !result.confirmation) return { ok: false, message: result.message };
        const confirmations = [...state.confirmations, result.confirmation];
        const updatedRun = applyConfirmationState(run, confirmations);
        set((s) => ({
          confirmations,
          runs: s.runs.map((r) => (r.runId === run.runId ? updatedRun : r)),
        }));
        return { ok: true, message: result.message };
      },

      closePartition: (partition) => {
        const key = partitionKeyString(partition);
        const state = get();
        const run = state.runs[state.runs.length - 1];
        const day = run?.accountDays.find((d) => partitionKeyString(d) === key);
        if (!day) return { ok: false, message: '分区不存在' };
        if (!day.accountConfirmed) return { ok: false, message: '账户总额未确认，不能结账' };
        if (state.closedPartitionKeys.includes(key)) return { ok: false, message: '分区已结账' };
        set((s) => ({
          closedPartitionKeys: [...s.closedPartitionKeys, key],
          runs: s.runs.map((r) =>
            r.runId === run.runId
              ? { ...r, accountDays: r.accountDays.map((d) => (partitionKeyString(d) === key ? { ...d, closed: true } : d)) }
              : r,
          ),
        }));
        return { ok: true, message: '分区已结账；后续更正只生成调整凭证，不回改本分区' };
      },

      applyMappingFix: (intervals) => set({ mappingOverrides: intervals }),

      resetDemo: () => {
        const batches = seedInitialBatches();
        set({
          currentUserId: 'U-1001',
          batches,
          mappings: [],
          runs: [],
          adjustments: [],
          confirmations: [],
          mappingOverrides: [],
          closedPartitionKeys: [],
          fxVersion: 'FX-2026-11A',
        });
      },
    }),
    {
      name: 'bill-reconcile-workbench-v1',
      partialize: (s) => ({
        currentUserId: s.currentUserId,
        batches: s.batches,
        mappings: s.mappings,
        runs: s.runs,
        adjustments: s.adjustments,
        confirmations: s.confirmations,
        mappingOverrides: s.mappingOverrides,
        closedPartitionKeys: s.closedPartitionKeys,
        fxVersion: s.fxVersion,
      }),
    },
  ),
);
