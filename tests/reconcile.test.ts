import { describe, expect, it } from 'vitest';
import { initialInputs, followup } from './helpers';
import { buildReconcileRun, deriveMappingIntervals, partitionKeyString } from '@/engine/reconcile';
import { decideIngestion } from '@/engine/dedup';
import { checkInvariant } from '@/engine/versions';
import type { ReconcileRun } from '@/types/domain';

function buildV1(): ReconcileRun {
  const { billRows, activityRows, fxRows } = initialInputs();
  return buildReconcileRun({
    runId: 'RUN-1', version: 1, createdBy: 'U-1001', createdAt: '2026-11-04T00:00:00.000Z',
    trigger: 'initial', fxVersion: 'FX-2026-11A', billRows, ingestDecisions: [],
    activityRows, fxRows, mappings: deriveMappingIntervals(activityRows), closedPartitionKeys: [],
  });
}

const key = (accountId: string, day: string, ccy: string) => `${accountId}|${day}|${ccy}`;

describe('首次核平运行：原生账户/日期粒度', () => {
  const run = buildV1();

  it('覆盖 3 个账户 × 3 个账单日共 9 个分区', () => {
    expect(run.accountDays).toHaveLength(9);
    expect(new Set(run.accountDays.map((d) => d.currency))).toEqual(new Set(['CNY', 'USD', 'JPY']));
  });

  it('可核验拆分确认活动级；无拆分余额留待核；占比分配强制估算', () => {
    const confirmed = run.campaignLines.filter((l) => l.status === 'confirmed');
    const estimated = run.campaignLines.filter((l) => l.status === 'estimated');
    const pending = run.campaignLines.filter((l) => l.status === 'pending_allocation');
    expect(confirmed.map((l) => `${l.accountId}:${l.campaignId}`).sort()).toEqual(
      ['ACC-CN-01:C-CN-A', 'ACC-CN-01:C-CN-B', 'ACC-US-02:C-US-A'],
    );
    expect(estimated.map((l) => l.campaignId)).toEqual(['C-CN-F', 'C-CN-G']);
    expect(estimated.every((l) => l.estimated)).toBe(true);
    // 估算行金额按 7000/3000 基点分配 800 元
    expect(estimated.find((l) => l.campaignId === 'C-CN-F')!.amountMinor).toBe(560000);
    expect(estimated.find((l) => l.campaignId === 'C-CN-G')!.amountMinor).toBe(240000);
    expect(pending.length).toBeGreaterThan(0);
  });

  it('活动已确认 + 未归属余额严格回到账户日更正后金额（整数守恒）', () => {
    expect(checkInvariant(run)).toBe(true);
    const cn1101 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-CN-01', '2026-11-01', 'CNY'))!;
    expect(cn1101.correctedMinor).toBe(1500000);
    expect(cn1101.unassignedMinor).toBe(500000); // 托管费无拆分
  });

  it('跨币种：服务日汇率逐账户换算，USD 分行产生 1 分舍入差额且单独列示', () => {
    const us1101 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-01', 'USD'))!;
    expect(us1101.standardCorrectedMinor).toBe(854815);
    const us1102 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-02', 'USD'))!;
    expect(us1102.roundingDiffMinor).toBe(1); // 尾差不塞给任何活动
    const jp1101 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-JP-03', '2026-11-01', 'JPY'))!;
    expect(jp1101.standardCorrectedMinor).toBe(573876); // 120000 JPY
  });

  it('五类行级比较：已相等 / 来源缺失 / 真实金额差异 均被区分', () => {
    const statuses = run.comparisons.map((c) => c.status);
    expect(statuses).toContain('equal');
    expect(statuses).toContain('source_missing');
    expect(statuses).toContain('amount_diff');
    const diff = run.comparisons.find((c) => c.status === 'amount_diff')!;
    expect(diff.leftAmountMinor! - diff.rightAmountMinor!).toBe(2000); // 500.00 vs 480.00 USD
    const missing = run.comparisons.find((c) => c.status === 'source_missing')!;
    expect(missing.accountId).toBe('ACC-JP-03');
  });

  it('不平分区产生阻断，禁止标记已核清；差异可追到来源行与汇率版本', () => {
    expect(run.blockers.length).toBeGreaterThan(0);
    const usBlocker = run.blockers.find((b) => b.includes('ACC-US-02|2026-11-03'));
    expect(usBlocker).toContain('不平');
    const us1103 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-03', 'USD'))!;
    expect(us1103.accountBalanced).toBe(false);
    expect(us1103.fxRateVersion).toBe('FX-2026-11A');
    expect(us1103.sourceRowIds.length).toBeGreaterThan(0);
  });

  it('日内活动迁移是软警告：活动级待分配，账户级核平仍可独立完成', () => {
    const cn1103 = run.accountDays.find((d) => partitionKeyString(d) === key('ACC-CN-01', '2026-11-03', 'CNY'))!;
    expect(cn1103.accountBalanced).toBe(true);
    expect(cn1103.unassignedMinor).toBe(300000);
    expect(run.warnings.some((w) => w.includes('PL-CN-9') && w.includes('日内活动迁移'))).toBe(true);
    const lines = run.campaignLines.filter((l) => partitionKeyString(l) === key('ACC-CN-01', '2026-11-03', 'CNY'));
    expect(lines.every((l) => l.status === 'pending_allocation' && l.basis === 'midday_switch')).toBe(true);
  });

  it('派生的映射区间保留切换前后两段', () => {
    const { activityRows } = initialInputs();
    const intervals = deriveMappingIntervals(activityRows).filter((m) => m.placementKey === 'PL-CN-9');
    expect(intervals.map((m) => m.campaignId)).toEqual(['C-CN-C', 'C-CN-D']);
  });
});

describe('版本演进：更正只重开受影响分区，其余月结分区继续有效', () => {
  const v1 = buildV1();
  const correction = followup('platform-bill-jp-correction.csv').billRows;
  const { billRows, activityRows, fxRows } = initialInputs();
  const reopened = [key('ACC-JP-03', '2026-11-01', 'JPY')];

  const v2 = buildReconcileRun({
    runId: 'RUN-2', version: 2, createdBy: 'U', createdAt: 'x', trigger: 'correction',
    fxVersion: 'FX-2026-11A', billRows: [...billRows, ...correction], ingestDecisions: [],
    activityRows, fxRows, mappings: deriveMappingIntervals(activityRows),
    previousRun: v1, reopenedKeys: reopened, closedPartitionKeys: [],
  });

  it('JP 11-01 按修订后金额重算（120000 -> 118000）', () => {
    const jp = v2.accountDays.find((d) => partitionKeyString(d) === key('ACC-JP-03', '2026-11-01', 'JPY'))!;
    expect(jp.correctedMinor).toBe(118000);
    expect(jp.carriedFromRunId).toBeUndefined();
  });

  it('未受影响分区整体继承旧版本并留痕', () => {
    const cn = v2.accountDays.find((d) => partitionKeyString(d) === key('ACC-CN-01', '2026-11-01', 'CNY'))!;
    expect(cn.carriedFromRunId).toBe('RUN-1');
    const carried = v2.accountDays.filter((d) => d.carriedFromRunId === 'RUN-1');
    expect(carried.length).toBe(8);
    expect(v2.status).toBe('reopened');
  });

  it('同额重复件与换号重复候选形成重复候选比较，且金额不二次累加', () => {
    const dups = followup('platform-bill-reimport-duplicates.csv').billRows;
    const decisions = decideIngestion(billRows, dups);
    expect(decisions.every((d) => d.kind === 'duplicate')).toBe(true);
    const v3 = buildReconcileRun({
      runId: 'RUN-3', version: 3, createdBy: 'U', createdAt: 'x', trigger: 'reimport',
      fxVersion: 'FX-2026-11A', billRows, ingestDecisions: decisions.map((d) => ({ kind: d.kind, incoming: d.incoming, reason: d.reason })),
      activityRows, fxRows, mappings: deriveMappingIntervals(activityRows),
      previousRun: v2, reopenedKeys: [key('ACC-CN-01', '2026-11-01', 'CNY')], closedPartitionKeys: [],
    });
    expect(v3.comparisons.filter((c) => c.status === 'duplicate_candidate')).toHaveLength(2);
    const cn1101 = v3.accountDays.find((d) => partitionKeyString(d) === key('ACC-CN-01', '2026-11-01', 'CNY'))!;
    expect(cn1101.correctedMinor).toBe(1500000); // 未被重复件翻倍
  });

  it('迟到部分贷项关联原账单行，作为后续调整且不减少其他活动费用', () => {
    const credit = followup('platform-bill-late-credit.csv').billRows;
    expect(credit[0].linkedDocNo).toBe('B-US-2002');
    const v4 = buildReconcileRun({
      runId: 'RUN-4', version: 4, createdBy: 'U', createdAt: 'x', trigger: 'late_credit',
      fxVersion: 'FX-2026-11A', billRows: [...billRows, ...correction, ...credit], ingestDecisions: [],
      activityRows, fxRows, mappings: deriveMappingIntervals(activityRows),
      previousRun: v2, reopenedKeys: [key('ACC-US-02', '2026-11-02', 'USD')], closedPartitionKeys: [],
    });
    const us1102 = v4.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-02', 'USD'))!;
    expect(us1102.creditMinor).toBe(-10000);
    expect(us1102.correctedMinor).toBe(70000); // 800 - 100
    // 其他账户分区继承，金额纹丝不动
    const cn1101 = v4.accountDays.find((d) => partitionKeyString(d) === key('ACC-CN-01', '2026-11-01', 'CNY'))!;
    expect(cn1101.correctedMinor).toBe(1500000);
  });

  it('汇率修订只重开服务日汇率实际变化的分区，新旧标准金额差额可复核', () => {
    const fxB = followup('fx-rates-FX-2026-11B.json').fxRows;
    const v5 = buildReconcileRun({
      runId: 'RUN-5', version: 5, createdBy: 'U', createdAt: 'x', trigger: 'fx_revision',
      fxVersion: 'FX-2026-11B', billRows, ingestDecisions: [],
      activityRows, fxRows: [...fxRows, ...fxB], mappings: deriveMappingIntervals(activityRows),
      previousRun: v1, reopenedKeys: [key('ACC-US-02', '2026-11-02', 'USD')], closedPartitionKeys: [],
    });
    const us1102 = v5.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-02', 'USD'))!;
    expect(us1102.standardCorrectedMinor).toBe(570400); // 800 USD @7.13
    const us1101 = v5.accountDays.find((d) => partitionKeyString(d) === key('ACC-US-02', '2026-11-01', 'USD'))!;
    expect(us1101.carriedFromRunId).toBe('RUN-1'); // 汇率未变，继承
    expect(v5.accountDays.find((d) => partitionKeyString(d) === key('ACC-JP-03', '2026-11-01', 'JPY'))!.carriedFromRunId).toBe('RUN-1');
  });
});
