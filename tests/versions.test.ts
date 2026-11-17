import { describe, expect, it } from 'vitest';
import { initialInputs, followup, makeBill } from './helpers';
import { buildReconcileRun, deriveMappingIntervals, partitionKeyString } from '@/engine/reconcile';
import {
  applyConfirmationState, buildAdjustmentVouchers, confirmPartition,
  previewBillChange, previewFxRevision, previewMappingChange,
} from '@/engine/versions';
import type { Confirmation, PartitionKey } from '@/types/domain';

function buildV1() {
  const { billRows, activityRows, fxRows } = initialInputs();
  return buildReconcileRun({
    runId: 'RUN-1', version: 1, createdBy: 'U-1001', createdAt: '2026-11-04T00:00:00.000Z',
    trigger: 'initial', fxVersion: 'FX-2026-11A', billRows, ingestDecisions: [],
    activityRows, fxRows, mappings: deriveMappingIntervals(activityRows), closedPartitionKeys: [],
  });
}

const p = (accountId: string, billDay: string, currency: string): PartitionKey => ({ accountId, billDay, currency });

describe('分级确认：账户总额与活动归属相互独立', () => {
  const run = buildV1();
  const cn1101 = p('ACC-CN-01', '2026-11-01', 'CNY');

  it('无阻断分区可确认账户总额；活动缺口不阻断账户确认', () => {
    const r = confirmPartition({ run, level: 'account', partition: cn1101, confirmedBy: 'U-2001', confirmedAt: 't', existingConfirmations: [] });
    expect(r.ok).toBe(true);
    expect(r.confirmation!.level).toBe('account');
  });

  it('有阻断的分区禁止任何确认（不平不得核清）', () => {
    const us1103 = p('ACC-US-02', '2026-11-03', 'USD');
    const r = confirmPartition({ run, level: 'account', partition: us1103, confirmedBy: 'U', confirmedAt: 't', existingConfirmations: [] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('禁止标记已核清');
  });

  it('待分配活动不能确认活动级，但账户级仍可完成', () => {
    const cn1103 = p('ACC-CN-01', '2026-11-03', 'CNY');
    const blocked = confirmPartition({ run, level: 'campaign', partition: cn1103, campaignId: 'C-CN-C', confirmedBy: 'U', confirmedAt: 't', existingConfirmations: [] });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('待分配');
    const accountOk = confirmPartition({ run, level: 'account', partition: cn1103, confirmedBy: 'U', confirmedAt: 't', existingConfirmations: [] });
    expect(accountOk.ok).toBe(true);
  });

  it('可核验活动可确认；估算行也可确认但带估算口径', () => {
    const ok = confirmPartition({ run, level: 'campaign', partition: cn1101, campaignId: 'C-CN-A', confirmedBy: 'U', confirmedAt: 't', existingConfirmations: [] });
    expect(ok.ok).toBe(true);
  });

  it('同版本同层级重复确认被拒绝', () => {
    const c: Confirmation = {
      confirmationId: 'x', runId: run.runId, level: 'account', partition: cn1101,
      confirmedBy: 'U', confirmedAt: 't', status: 'confirmed',
    };
    const r = confirmPartition({ run, level: 'account', partition: cn1101, confirmedBy: 'U', confirmedAt: 't', existingConfirmations: [c] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已确认');
  });

  it('汇率修订与确认并发且新旧差额不一致 -> 转复核，不得直接通过', () => {
    const r = confirmPartition({
      run, level: 'account', partition: cn1101, confirmedBy: 'U', confirmedAt: 't',
      fxReview: { oldDiffMinor: 10, newDiffMinor: 12 }, existingConfirmations: [],
    });
    expect(r.ok).toBe(true);
    expect(r.confirmation!.status).toBe('requires_rereview');
  });

  it('可核平分区全部确认后进入 account_confirmed；存在阻断时不得 fully_confirmed（不平禁止核清）', () => {
    const confirmations: Confirmation[] = [];
    for (const d of run.accountDays.filter((x) => x.accountBalanced)) {
      const c = confirmPartition({ run, level: 'account', partition: p(d.accountId, d.billDay, d.currency), confirmedBy: 'U', confirmedAt: 't', existingConfirmations: confirmations });
      if (c.confirmation) confirmations.push(c.confirmation);
    }
    for (const l of run.campaignLines.filter((x) => x.status !== 'pending_allocation')) {
      const c = confirmPartition({ run, level: 'campaign', partition: p(l.accountId, l.billDay, l.currency), campaignId: l.campaignId, confirmedBy: 'U', confirmedAt: 't', existingConfirmations: confirmations });
      if (c.confirmation) confirmations.push(c.confirmation);
    }
    const updated = applyConfirmationState(run, confirmations);
    expect(updated.status).toBe('account_confirmed'); // 2 个阻断分区未确认，不能整体核清
    expect(updated.accountDays.find((d) => !d.accountBalanced)!.accountConfirmed).toBe(false);
  });

  it('无阻断的最小运行两级确认后可 fully_confirmed', () => {
    const bill = makeBill({
      accountId: 'ACC-CN-01', currency: 'CNY', billDay: '2026-11-01', sourceDocNo: 'D1',
      amountMinor: 100000, summary: 's1',
      splits: [{ campaignId: 'C1', amountMinor: 100000, verifiable: true, shareBps: null }],
    });
    const activity = [{
      rowId: 'A1', batchId: 'BAT-X', accountId: 'ACC-CN-01', campaignId: 'C1', campaignName: '活动1',
      placementKey: 'P1', day: '2026-11-01', hourStart: '2026-11-01T00:00:00+08:00', hourEnd: '2026-11-02T00:00:00+08:00',
      timezone: 'Asia/Shanghai', currency: 'CNY', spendMinor: 100000, raw: {},
    }];
    const mini = buildReconcileRun({
      runId: 'RUN-M', version: 1, createdBy: 'U', createdAt: 't', trigger: 'initial',
      fxVersion: 'FX-2026-11A', billRows: [bill], ingestDecisions: [],
      activityRows: activity, fxRows: [], mappings: [], closedPartitionKeys: [],
    });
    expect(mini.blockers).toHaveLength(0);
    const confirmations: Confirmation[] = [];
    for (const lvl of ['account', 'campaign'] as const) {
      const c = confirmPartition({
        run: mini, level: lvl, partition: p('ACC-CN-01', '2026-11-01', 'CNY'),
        campaignId: lvl === 'campaign' ? 'C1' : undefined,
        confirmedBy: 'U', confirmedAt: 't', existingConfirmations: confirmations,
      });
      if (c.confirmation) confirmations.push(c.confirmation);
    }
    expect(applyConfirmationState(mini, confirmations).status).toBe('fully_confirmed');
  });
});

describe('影响预览与调整凭证', () => {
  const v1 = buildV1();
  const { billRows, fxRows } = initialInputs();

  it('账单变更预览只圈定对应账户日与来源行', () => {
    const credit = followup('platform-bill-late-credit.csv').billRows;
    const preview = previewBillChange(v1, credit);
    expect(preview.partitions).toEqual([p('ACC-US-02', '2026-11-02', 'USD')]);
    expect(preview.sourceRowIds.length).toBeGreaterThan(1);
  });

  it('汇率修订预览给出逐分区新旧差额；未变化分区不列入复核', () => {
    const fxB = followup('fx-rates-FX-2026-11B.json').fxRows;
    const preview = previewFxRevision(v1, fxRows, [...fxRows, ...fxB], 'FX-2026-11B');
    expect(preview.reviewRequired).toHaveLength(1);
    expect(preview.reviewRequired[0].partition.accountId).toBe('ACC-US-02');
    expect(preview.reviewRequired[0].diff).toBe(524);
  });

  it('映射更正预览区分未结账重开与已付款转凭证', () => {
    const { activityRows } = initialInputs();
    const intervals = deriveMappingIntervals(activityRows);
    const preview = previewMappingChange(v1, intervals, activityRows);
    expect(preview.closedPartitions).toHaveLength(0);
    expect(preview.partitions.length).toBeGreaterThan(0);
  });

  it('已结账分区的迟到贷项生成调整凭证，关联原账单行；未结账分区不生成', () => {
    const credit = followup('platform-bill-late-credit.csv').billRows;
    const openDays = v1.accountDays;
    expect(buildAdjustmentVouchers({
      kind: 'late_credit', runId: 'RUN-2', createdAt: 't', incoming: credit,
      previousDays: openDays, fxRows, fxVersion: 'FX-2026-11A', note: '迟到贷项',
    })).toHaveLength(0);

    const closedDays = v1.accountDays.map((d) =>
      partitionKeyString(d) === 'ACC-US-02|2026-11-02|USD' ? { ...d, closed: true } : d);
    const vouchers = buildAdjustmentVouchers({
      kind: 'late_credit', runId: 'RUN-2', createdAt: 't', incoming: credit,
      previousDays: closedDays, fxRows, fxVersion: 'FX-2026-11A', note: '迟到贷项',
    });
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].amountMinor).toBe(-10000);
    expect(vouchers[0].postedToClosedPartition).toBe(true);
    expect(vouchers[0].linkedBillRowIds).toContain(credit[0].rowId);
  });

  it('修改一个账户不会改变其他账户的核平结果（账户隔离）', () => {
    const correction = followup('platform-bill-jp-correction.csv').billRows;
    const before = v1.accountDays.filter((d) => d.accountId !== 'ACC-JP-03').map((d) => [partitionKeyString(d), d.correctedMinor, d.standardCorrectedMinor]);
    const v2 = buildReconcileRun({
      runId: 'RUN-2', version: 2, createdBy: 'U', createdAt: 'x', trigger: 'correction',
      fxVersion: 'FX-2026-11A', billRows: [...billRows, ...correction], ingestDecisions: [],
      activityRows: initialInputs().activityRows, fxRows, mappings: deriveMappingIntervals(initialInputs().activityRows),
      previousRun: v1, reopenedKeys: ['ACC-JP-03|2026-11-01|JPY'], closedPartitionKeys: [],
    });
    const after = v2.accountDays.filter((d) => d.accountId !== 'ACC-JP-03').map((d) => [partitionKeyString(d), d.correctedMinor, d.standardCorrectedMinor]);
    expect(after).toEqual(before);
    // 重算分区不携带继承标记
    expect(v2.accountDays.find((d) => partitionKeyString(d) === 'ACC-JP-03|2026-11-01|JPY')!.carriedFromRunId).toBeUndefined();
  });
});
