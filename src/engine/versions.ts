// ============================================================
// 版本演进、调整凭证与分级确认（纯规则，状态由 store 承载）
// - 修改映射/补入贷项/替换汇率：先预览受影响来源行与账户日，再产生新运行；
// - 部分退款/贷项晚到：关联原账单行，作为后续调整，不减少其他活动已确认费用；
// - 整日更正只重开受影响且未结账分区；已结账分区生成调整凭证；
// - 映射更正仅重开未结账分区，已付款部分生成调整凭证；
// - 汇率修订与财务确认并发：要求复核新旧差额，确认标记 requires_rereview；
// - 财务可分别确认账户总额与活动归属，单一映射缺口不卡住整月已核账单。
// ============================================================

import type {
  AccountDayResult,
  ActivityHourRow,
  AdjustmentKind,
  AdjustmentVoucher,
  BillRow,
  Confirmation,
  FxRateRow,
  MappingInterval,
  PartitionKey,
  ReconcileRun,
} from '@/types/domain';
import { FX_RATE_SCALE, STANDARD_CURRENCY } from '@/lib/constants';
import { convertMinor, sumMinor } from '@/lib/money';
import { effectiveBillRows } from '@/engine/dedup';
import { lookupRate } from '@/engine/fx';
import { partitionKeyString } from '@/engine/reconcile';

export interface AffectedPreview {
  partitions: PartitionKey[];
  sourceRowIds: string[];
  reasons: string[];
}

function partitionsOfBillRows(rows: BillRow[]): PartitionKey[] {
  const seen = new Set<string>();
  const out: PartitionKey[] = [];
  for (const r of rows) {
    const p: PartitionKey = { accountId: r.accountId, billDay: r.billDay, currency: r.currency };
    const k = partitionKeyString(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

/** 预览补入账单行（迟到贷项/更正件）影响的来源行与账户日 */
export function previewBillChange(previousRun: ReconcileRun, incoming: BillRow[]): AffectedPreview {
  const reasons: string[] = [];
  const rowIds = new Set<string>();
  for (const r of incoming) {
    if (r.lineType === 'credit') {
      reasons.push(`[${r.accountId} ${r.billDay}] 迟到贷项/部分退款 ${r.sourceDocNo}，将关联原账单行作为后续调整`);
    } else if (r.lineType === 'correction') {
      reasons.push(`[${r.accountId} ${r.billDay}] 平台更正 ${r.sourceDocNo}，仅重开该账户日分区`);
    } else {
      reasons.push(`[${r.accountId} ${r.billDay}] 新账单行 ${r.sourceDocNo}`);
    }
    rowIds.add(r.rowId);
    // 关联同账户日的旧来源行（调整不影响其他账户日）
    for (const d of previousRun.accountDays) {
      if (d.accountId === r.accountId && d.billDay === r.billDay && d.currency === r.currency) {
        d.sourceRowIds.forEach((id) => rowIds.add(id));
      }
    }
  }
  return { partitions: partitionsOfBillRows(incoming), sourceRowIds: [...rowIds], reasons };
}

/** 预览映射更正影响：只重开未结账分区；已付款分区转调整凭证 */
export function previewMappingChange(
  previousRun: ReconcileRun,
  nextMappings: MappingInterval[],
  activityRows: ActivityHourRow[],
): AffectedPreview & { closedPartitions: PartitionKey[] } {
  const affectedAccounts = new Set(nextMappings.map((m) => m.accountId));
  const touched: PartitionKey[] = [];
  const closedPartitions: PartitionKey[] = [];
  const rowIds = new Set<string>();
  for (const d of previousRun.accountDays) {
    if (!affectedAccounts.has(d.accountId)) continue;
    const p: PartitionKey = { accountId: d.accountId, billDay: d.billDay, currency: d.currency };
    if (d.closed) {
      closedPartitions.push(p);
    } else {
      touched.push(p);
    }
    d.sourceRowIds.forEach((id) => rowIds.add(id));
  }
  for (const a of activityRows) {
    if (affectedAccounts.has(a.accountId)) rowIds.add(a.rowId);
  }
  return {
    partitions: touched,
    closedPartitions,
    sourceRowIds: [...rowIds],
    reasons: [
      `映射更正重开 ${touched.length} 个未结账分区；${closedPartitions.length} 个已付款分区不回改，改走调整凭证`,
    ],
  };
}

/** 预览汇率替换影响：所有使用该币种、该版本的账户日，并与既有确认做新旧差额复核 */
export function previewFxRevision(
  previousRun: ReconcileRun,
  oldFxRows: FxRateRow[],
  nextFxRows: FxRateRow[],
  nextVersion: string,
): AffectedPreview & { reviewRequired: Array<{ partition: PartitionKey; oldStandard: number; newStandard: number; diff: number }> } {
  const currencies = new Set(nextFxRows.map((r) => r.fromCurrency));
  const partitions: PartitionKey[] = [];
  const reviewRequired: Array<{ partition: PartitionKey; oldStandard: number; newStandard: number; diff: number }> = [];
  const rowIds = new Set<string>();
  for (const d of previousRun.accountDays) {
    if (!currencies.has(d.currency) || d.currency === STANDARD_CURRENCY) continue;
    const p: PartitionKey = { accountId: d.accountId, billDay: d.billDay, currency: d.currency };
    partitions.push(p);
    d.sourceRowIds.forEach((id) => rowIds.add(id));
    const oldRate = lookupRate(oldFxRows, d.currency, d.billDay, previousRun.fxVersion);
    const newRate = lookupRate(nextFxRows, d.currency, d.billDay, nextVersion);
    if (oldRate.rateText && newRate.rateText) {
      const oldStd = d.standardCorrectedMinor;
      const newStd = convertMinor(d.correctedMinor, minorUnit(d.currency), newRate.rateText, FX_RATE_SCALE, 2) ?? 0;
      if (oldStd !== newStd) {
        reviewRequired.push({ partition: p, oldStandard: oldStd, newStandard: newStd, diff: newStd - oldStd });
      }
    }
  }
  return {
    partitions,
    sourceRowIds: [...rowIds],
    reviewRequired,
    reasons: reviewRequired.length
      ? [`汇率修订导致 ${reviewRequired.length} 个已确认分区标准金额变化，必须复核新旧差额后才能继续确认`]
      : ['汇率替换未产生标准金额差异'],
  };
}

function minorUnit(currency: string): number {
  return currency === 'JPY' ? 0 : 2;
}

/**
 * 为已结账分区生成调整凭证（迟到贷项/更正/映射/汇率四类）。
 * 关键口径：贷项只冲减其关联原账单行所属分区，不减少其他活动的已确认费用。
 */
export function buildAdjustmentVouchers(input: {
  kind: AdjustmentKind;
  runId: string;
  createdAt: string;
  incoming: BillRow[];
  previousDays: AccountDayResult[];
  fxRows: FxRateRow[];
  fxVersion: string;
  note: string;
}): AdjustmentVoucher[] {
  const vouchers: AdjustmentVoucher[] = [];
  const { effective } = effectiveBillRows(input.incoming);
  for (const row of effective) {
    const day = input.previousDays.find(
      (d) => d.accountId === row.accountId && d.billDay === row.billDay && d.currency === row.currency && d.closed,
    );
    if (!day) continue;
    const fx = lookupRate(input.fxRows, row.currency, row.billDay, input.fxVersion);
    const standard = row.currency === STANDARD_CURRENCY
      ? row.amountMinor
      : convertMinor(row.amountMinor, minorUnit(row.currency), fx.rateText || '1', FX_RATE_SCALE, 2) ?? 0;
    vouchers.push({
      voucherId: `VCH-${row.rowId}`,
      kind: input.kind,
      createdAt: input.createdAt,
      accountId: row.accountId,
      billDay: row.billDay,
      currency: row.currency,
      amountMinor: row.amountMinor,
      standardMinor: standard,
      // 关联原账单行：调整可追溯，不波及其他活动
      linkedBillRowIds: [row.rowId, ...day.sourceRowIds],
      runId: input.runId,
      note: input.note,
      postedToClosedPartition: true,
    });
  }
  return vouchers;
}

export interface ConfirmInput {
  run: ReconcileRun;
  level: 'account' | 'campaign';
  partition: PartitionKey;
  campaignId?: string;
  confirmedBy: string;
  confirmedAt: string;
  /** 汇率修订与确认并发场景的复核差额 */
  fxReview?: { oldDiffMinor: number; newDiffMinor: number };
  existingConfirmations: Confirmation[];
}

/**
 * 分级确认规则：
 * - 存在 blockers 的分区禁止任何确认；
 * - 账户确认与活动确认相互独立：活动映射缺口不阻断账户总额确认；
 * - 活动级只允许 confirmed/estimated 口径，pending_allocation 不能确认；
 * - 汇率并发差额非零时要求复核（requires_rereview），不自动通过。
 */
export function confirmPartition(input: ConfirmInput): { ok: boolean; confirmation?: Confirmation; message: string } {
  const key = partitionKeyString(input.partition);
  const day = input.run.accountDays.find((d) => partitionKeyString(d) === key);
  if (!day) return { ok: false, message: '分区不存在于本运行版本' };
  if (input.run.blockers.some((b) => b.startsWith(`[${key}]`))) {
    return { ok: false, message: '该分区日账/活动/总账不平或输入缺失，禁止标记已核清' };
  }
  if (input.level === 'campaign') {
    if (!input.campaignId) return { ok: false, message: '活动级确认必须指定活动' };
    const line = input.run.campaignLines.find(
      (l) => partitionKeyString(l) === key && l.campaignId === input.campaignId,
    );
    if (!line) return { ok: false, message: '活动行不存在' };
    if (line.status === 'pending_allocation') {
      return { ok: false, message: '该活动为待分配（平台凭证不可拆/日内迁移），不能确认活动级金额；账户级核平仍可单独完成' };
    }
  }
  const duplicate = input.existingConfirmations.find(
    (c) => c.runId === input.run.runId && c.level === input.level &&
      partitionKeyString(c.partition) === key && c.campaignId === input.campaignId,
  );
  if (duplicate) return { ok: false, message: '本版本该层级已确认，请勿重复操作' };

  const requiresRereview = !!input.fxReview && input.fxReview.oldDiffMinor !== input.fxReview.newDiffMinor;
  const confirmation: Confirmation = {
    confirmationId: `CFM-${input.run.runId}-${input.level}-${key}-${input.campaignId ?? 'ALL'}`.replace(/[^a-zA-Z0-9-]/g, '_'),
    runId: input.run.runId,
    level: input.level,
    partition: input.partition,
    campaignId: input.campaignId,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt,
    status: requiresRereview ? 'requires_rereview' : 'confirmed',
    oldDiffMinor: input.fxReview?.oldDiffMinor,
    newDiffMinor: input.fxReview?.newDiffMinor,
    note: requiresRereview ? '汇率修订与确认并发：新旧差额不一致，已转复核' : undefined,
  };
  return requiresRereview
    ? { ok: true, confirmation, message: '已记录确认但因汇率并发差额转复核，复核通过前不得结账' }
    : { ok: true, confirmation, message: input.level === 'account' ? '账户总额已确认（活动归属可独立处理）' : '活动归属已确认' };
}

/** 汇总运行内确认结果，回写账户日的两级确认标记与运行状态 */
export function applyConfirmationState(run: ReconcileRun, confirmations: Confirmation[]): ReconcileRun {
  const mine = confirmations.filter((c) => c.runId === run.runId && c.status === 'confirmed');
  const accountDays = run.accountDays.map((d) => {
    const key = partitionKeyString(d);
    const accountConfirmed = mine.some((c) => c.level === 'account' && partitionKeyString(c.partition) === key);
    const campaignConfirmed = (() => {
      const lines = run.campaignLines.filter((l) => partitionKeyString(l) === key && l.status !== 'pending_allocation');
      if (lines.length === 0) return false;
      return lines.every((l) =>
        mine.some((c) => c.level === 'campaign' && partitionKeyString(c.partition) === key && c.campaignId === l.campaignId),
      );
    })();
    return { ...d, accountConfirmed, campaignConfirmed };
  });
  // 只在可核平分区间上统计；单一映射缺口/阻断不会卡住其他已核账单
  const balancedDays = accountDays.filter((d) => d.accountBalanced);
  const allAccount = balancedDays.every((d) => d.accountConfirmed);
  const allCampaign = balancedDays.every((d) => d.campaignConfirmed || d.unassignedMinor === d.correctedMinor);
  // 全部已确认还要求不存在阻断：不平分区禁止标记已核清
  const status = allAccount && allCampaign && run.blockers.length === 0
    ? 'fully_confirmed'
    : allAccount
      ? 'account_confirmed'
      : run.status === 'reopened' ? 'reopened' : 'open';
  return { ...run, accountDays, status };
}

/** 工具：活动行守恒校验（报告页与测试共用） */
export function checkInvariant(run: ReconcileRun): boolean {
  for (const d of run.accountDays) {
    const assigned = sumMinor(
      run.campaignLines
        .filter((l) => l.accountId === d.accountId && l.billDay === d.billDay && l.currency === d.currency && l.status !== 'pending_allocation')
        .map((l) => l.amountMinor),
    );
    if (assigned + d.unassignedMinor !== d.correctedMinor) return false;
    if (!d.invariantHeld) return false;
  }
  return true;
}
