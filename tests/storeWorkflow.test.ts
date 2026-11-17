import { beforeEach, describe, expect, it } from 'vitest';

// node 环境下为 zustand persist 提供最小 localStorage 桩
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

import { useAppStore, selectBillRows } from '@/store/useAppStore';
import { partitionKeyString } from '@/engine/reconcile';
import { SAMPLE_FILES } from '@/data/sampleFiles';

const sample = (fileName: string) => SAMPLE_FILES.find((s) => s.fileName === fileName)!;

describe('对账全链路（导入 → 受理 → 运行 → 确认 → 结账 → 调整 → 汇率修订）', () => {
  beforeEach(() => {
    useAppStore.getState().resetDemo();
  });

  it('初始三文件经解析管线成为受理账批次', () => {
    const s = useAppStore.getState();
    expect(s.batches).toHaveLength(3);
    expect(selectBillRows(s.batches).length).toBe(10);
    expect(s.runs).toHaveLength(0);
  });

  it('V1 首次核平：9 分区、2 阻断、1 日内迁移警告、守恒成立', () => {
    const run = useAppStore.getState().createRun('initial');
    expect(run.version).toBe(1);
    expect(run.accountDays).toHaveLength(9);
    expect(run.blockers.length).toBe(2);
    expect(run.warnings.some((w) => w.includes('日内活动迁移'))).toBe(true);
    for (const d of run.accountDays) {
      const assigned = run.campaignLines
        .filter((l) => partitionKeyString(l) === partitionKeyString(d) && l.status !== 'pending_allocation')
        .reduce((a, l) => a + l.amountMinor, 0);
      expect(assigned + d.unassignedMinor).toBe(d.correctedMinor);
    }
  });

  it('重复导入：两条均判为重复件，V2 含 2 条重复候选比较且金额不翻倍', () => {
    useAppStore.getState().createRun('initial');
    const outcome = useAppStore.getState().importSample(sample('platform-bill-reimport-duplicates.csv'));
    expect(outcome.duplicateCount).toBe(2);
    expect(outcome.acceptedCount).toBe(0);
    const v2 = useAppStore.getState().createRun('reimport');
    expect(v2.comparisons.filter((c) => c.status === 'duplicate_candidate')).toHaveLength(2);
    const cn = v2.accountDays.find((d) => partitionKeyString(d) === 'ACC-CN-01|2026-11-01|CNY')!;
    expect(cn.correctedMinor).toBe(1500000);
  });

  it('同号更正件：V3 只重开 JP 分区，其余分区继承且状态为 reopened', () => {
    useAppStore.getState().createRun('initial');
    const outcome = useAppStore.getState().importSample(sample('platform-bill-jp-correction.csv'));
    expect(outcome.revisionCount).toBe(1);
    const v3 = useAppStore.getState().createRun('correction');
    expect(v3.status).toBe('reopened');
    const jp = v3.accountDays.find((d) => partitionKeyString(d) === 'ACC-JP-03|2026-11-01|JPY')!;
    expect(jp.correctedMinor).toBe(118000);
    expect(jp.carriedFromRunId).toBeUndefined();
    const carried = v3.accountDays.filter((d) => d.carriedFromRunId);
    expect(carried.length).toBe(8);
  });

  it('分级确认：阻断分区被拒；平衡分区可确认并结账', () => {
    useAppStore.getState().createRun('initial');
    const blocked = useAppStore.getState().confirm({
      level: 'account', partition: { accountId: 'ACC-US-02', billDay: '2026-11-03', currency: 'USD' },
    });
    expect(blocked.ok).toBe(false);
    const ok = useAppStore.getState().confirm({
      level: 'account', partition: { accountId: 'ACC-US-02', billDay: '2026-11-02', currency: 'USD' },
    });
    expect(ok.ok).toBe(true);
    const closed = useAppStore.getState().closePartition({ accountId: 'ACC-US-02', billDay: '2026-11-02', currency: 'USD' });
    expect(closed.ok).toBe(true);
    const again = useAppStore.getState().closePartition({ accountId: 'ACC-US-02', billDay: '2026-11-02', currency: 'USD' });
    expect(again.ok).toBe(false);
  });

  it('已结账分区的迟到贷项：分区不回改，生成调整凭证关联原账单行', () => {
    useAppStore.getState().createRun('initial');
    useAppStore.getState().confirm({ level: 'account', partition: { accountId: 'ACC-US-02', billDay: '2026-11-02', currency: 'USD' } });
    useAppStore.getState().closePartition({ accountId: 'ACC-US-02', billDay: '2026-11-02', currency: 'USD' });
    useAppStore.getState().importSample(sample('platform-bill-late-credit.csv'));
    const run = useAppStore.getState().createRun('late_credit');
    const day = run.accountDays.find((d) => partitionKeyString(d) === 'ACC-US-02|2026-11-02|USD')!;
    expect(day.closed).toBe(true);
    expect(day.carriedFromRunId).toBeDefined();
    const vouchers = useAppStore.getState().adjustments;
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].kind).toBe('late_credit');
    expect(vouchers[0].amountMinor).toBe(-10000);
    expect(vouchers[0].postedToClosedPartition).toBe(true);
  });

  it('汇率修订：切版本后仅 USD 11-02 重开，标准金额变化且其他分区继承', () => {
    useAppStore.getState().createRun('initial');
    useAppStore.getState().importSample(sample('fx-rates-FX-2026-11B.json'));
    useAppStore.getState().setFxVersion('FX-2026-11B');
    const run = useAppStore.getState().createRun('fx_revision');
    expect(run.fxVersion).toBe('FX-2026-11B');
    const us1102 = run.accountDays.find((d) => partitionKeyString(d) === 'ACC-US-02|2026-11-02|USD')!;
    expect(us1102.standardCorrectedMinor).toBe(570400);
    expect(us1102.carriedFromRunId).toBeUndefined();
    const us1101 = run.accountDays.find((d) => partitionKeyString(d) === 'ACC-US-02|2026-11-01|USD')!;
    expect(us1101.carriedFromRunId).toBeDefined();
  });

  it('字段对应可保存复用', () => {
    const mapping = useAppStore.getState().saveMapping({
      name: '测试账单对应', kind: 'bill', columns: { accountId: '账户编号', amount: '金额' },
    });
    expect(useAppStore.getState().mappings.some((m) => m.mappingId === mapping.mappingId)).toBe(true);
  });
});
