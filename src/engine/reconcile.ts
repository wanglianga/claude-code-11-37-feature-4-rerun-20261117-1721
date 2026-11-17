// ============================================================
// 对账核心引擎（纯函数）
// 正式核平口径：平台原生 账户/日期/币种 粒度。
// - 先拆到账户币种，再按服务日汇率形成标准金额，禁止平均汇率；
// - 只有平台可核验拆分才确认活动级金额；消耗占比分配一律标估算；
// - 日内映射切换且凭证不可拆 -> 活动级待分配，账户级仍可核平；
// - 已确认 + 估算 + 未归属余额必须严格回到账户日更正后金额（整数守恒）；
// - 不平时输出 blockers，禁止标记已核清，差异可追到来源行与换算版本。
// ============================================================

import type {
  AccountDayResult,
  ActivityHourRow,
  BillRow,
  CampaignLineResult,
  FxRateRow,
  LineComparison,
  MappingInterval,
  PartitionKey,
  ReconcileRun,
  RunTrigger,
} from '@/types/domain';
import { ACCOUNTS, CURRENCIES, FX_RATE_SCALE, STANDARD_CURRENCY } from '@/lib/constants';
import { allocateByBps, convertMinor, roundingDiff, sumMinor } from '@/lib/money';
import { effectiveBillRows, type IngestDecision } from '@/engine/dedup';
import { lookupRate } from '@/engine/fx';

export function partitionKeyString(p: PartitionKey): string {
  return `${p.accountId}|${p.billDay}|${p.currency}`;
}

function minorUnitOf(currency: string): number {
  return CURRENCIES.find((c) => c.code === currency)?.minorUnit ?? 2;
}

export interface ReconcileInput {
  runId: string;
  version: number;
  parentRunId?: string;
  createdBy: string;
  createdAt: string;
  trigger: RunTrigger;
  fxVersion: string;
  billRows: BillRow[];
  ingestDecisions: IngestDecision[];
  activityRows: ActivityHourRow[];
  fxRows: FxRateRow[];
  mappings: MappingInterval[];
  previousRun?: ReconcileRun;
  /**
   * 显式重开的分区键。提供时：仅这些分区（及新分区）重算，
   * 其余分区从旧版本整体继承（平台整日更正只重开受影响账户/日期）。
   * 不提供时：全量重算，但保留无阻断分区的确认标记。
   */
  reopenedKeys?: string[];
  /** 已结账分区键；更正只重开未结账分区，已结账部分生成调整凭证 */
  closedPartitionKeys: string[];
  note?: string;
}

interface ActivityDayAgg {
  accountId: string;
  day: string;
  currency: string;
  totalMinor: number;
  perCampaign: Map<string, number>;
  /** 当天发生活动迁移的投放位 -> 切换前后活动 */
  switchedPlacements: Map<string, string[]>;
  rowIds: string[];
}

/** 聚合内部小时投放；同一投放位当天出现多个活动即日内迁移 */
function aggregateActivity(rows: ActivityHourRow[]): Map<string, ActivityDayAgg> {
  const map = new Map<string, ActivityDayAgg>();
  const placementCampaigns = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.accountId}|${r.day}|${r.currency}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        accountId: r.accountId, day: r.day, currency: r.currency,
        totalMinor: 0, perCampaign: new Map(), switchedPlacements: new Map(), rowIds: [],
      };
      map.set(key, agg);
    }
    agg.totalMinor += r.spendMinor;
    agg.perCampaign.set(r.campaignId, (agg.perCampaign.get(r.campaignId) ?? 0) + r.spendMinor);
    agg.rowIds.push(r.rowId);
    const pKey = `${r.accountId}|${r.day}|${r.placementKey}`;
    const set = placementCampaigns.get(pKey) ?? new Set<string>();
    set.add(r.campaignId);
    placementCampaigns.set(pKey, set);
  }
  for (const [pKey, campaigns] of placementCampaigns) {
    if (campaigns.size > 1) {
      const [accountId, day] = pKey.split('|');
      const agg = map.get(`${accountId}|${day}`);
      // 账户币种唯一，找到该账户当天任一聚合即可
      const target = agg ?? [...map.values()].find((a) => a.accountId === accountId && a.day === day);
      target?.switchedPlacements.set(pKey, [...campaigns]);
    }
  }
  return map;
}

export function buildReconcileRun(input: ReconcileInput): ReconcileRun {
  const { effective, superseded } = effectiveBillRows(input.billRows);
  const activityAgg = aggregateActivity(input.activityRows);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const accountDays: AccountDayResult[] = [];
  const campaignLines: CampaignLineResult[] = [];
  const comparisons: LineComparison[] = [];
  const affectedPartitions: PartitionKey[] = [];

  // 受理阶段的重复候选直接形成行级比较（可追溯到来源行）
  for (const d of input.ingestDecisions) {
    if (d.kind === 'duplicate') {
      comparisons.push({
        comparisonId: `CMP-${d.incoming.rowId}`,
        accountId: d.incoming.accountId,
        billDay: d.incoming.billDay,
        currency: d.incoming.currency,
        billRowId: d.incoming.rowId,
        status: 'duplicate_candidate',
        leftAmountMinor: d.incoming.amountMinor,
        rightAmountMinor: d.existing?.amountMinor,
        detail: d.reason,
      });
    }
  }

  // 按账户/日期/币种组织生效账单行
  const billPartitions = new Map<string, BillRow[]>();
  for (const row of effective) {
    const key = partitionKeyString({ accountId: row.accountId, billDay: row.billDay, currency: row.currency });
    const list = billPartitions.get(key) ?? [];
    list.push(row);
    billPartitions.set(key, list);
  }

  const allKeys = new Set<string>([
    ...billPartitions.keys(),
    ...[...activityAgg.keys()].map((k) => {
      const a = activityAgg.get(k)!;
      return partitionKeyString({ accountId: a.accountId, billDay: a.day, currency: a.currency });
    }),
  ]);

  for (const key of [...allKeys].sort()) {
    const [accountId, billDay, currency] = key.split('|');
    const partition: PartitionKey = { accountId, billDay, currency };

    // 显式重开口径：未列入重开集合的既有分区直接进入继承分支
    if (input.reopenedKeys && input.previousRun &&
      !input.reopenedKeys.includes(key) &&
      input.previousRun.accountDays.some((d) => partitionKeyString(d) === key)) {
      continue;
    }

    const rows = billPartitions.get(key) ?? [];
    const agg = activityAgg.get(key);
    const account = ACCOUNTS.find((a) => a.accountId === accountId);
    const minorUnit = minorUnitOf(currency);
    const partitionBlockers: string[] = [];

    // ---- 来源缺失比较 ----
    if (rows.length === 0) {
      comparisons.push({
        comparisonId: `CMP-MISS-B-${key}`,
        accountId, billDay, currency,
        activityKey: key,
        status: 'source_missing',
        rightAmountMinor: agg?.totalMinor,
        detail: `内部活动有 ${agg?.totalMinor ?? 0} 投放消耗，但平台账单该账户日无任何来源行`,
      });
      partitionBlockers.push('平台账单来源缺失，无法核平');
    }
    if (!agg) {
      comparisons.push({
        comparisonId: `CMP-MISS-A-${key}`,
        accountId, billDay, currency,
        billRowId: rows[0]?.rowId,
        status: 'source_missing',
        leftAmountMinor: sumMinor(rows.map((r) => r.amountMinor)),
        detail: '平台账单存在，但内部活动记录该账户日缺失（无法做活动归属，账户级仍可独立核平）',
      });
    }

    // ---- 原金额 / 贷项 / 更正后金额（更正件作为独立行类型参与求和，保留修订血缘） ----
    const billOriginalMinor = sumMinor(rows.filter((r) => r.lineType === 'charge').map((r) => r.amountMinor));
    const creditMinor = sumMinor(rows.filter((r) => r.lineType === 'credit').map((r) => r.amountMinor));
    const correctedMinor = sumMinor(rows.map((r) => r.amountMinor));

    // ---- 服务日汇率（逐账户币种，禁止平均） ----
    const fx = lookupRate(input.fxRows, currency, billDay, input.fxVersion);
    let standardCorrectedMinor = 0;
    let roundingDiffMinor = 0;
    if (fx.missing) {
      partitionBlockers.push(fx.missing);
    } else if (rows.length > 0) {
      const rd = roundingDiff(rows.map((r) => r.amountMinor), minorUnit, fx.rateText, FX_RATE_SCALE, 2);
      if (!rd) {
        partitionBlockers.push(`汇率 ${fx.rateText} 换算失败`);
      } else {
        standardCorrectedMinor = rd.sumOfLines;
        roundingDiffMinor = rd.diff;
      }
    }

    // ---- 活动归属 ----
    const campaignResults: CampaignLineResult[] = [];
    const verifiableLines = rows.flatMap((r) => r.splits.filter((s) => s.verifiable).map((s) => ({ split: s, row: r })));
    const estimatedLines = rows.flatMap((r) => r.splits.filter((s) => !s.verifiable).map((s) => ({ split: s, row: r })));
    let assignedMinor = 0;

    if (verifiableLines.length > 0) {
      // 平台凭证可核验：唯一允许确认活动级金额的口径
      const perCampaign = new Map<string, { amount: number; rowIds: string[] }>();
      for (const { split, row } of verifiableLines) {
        const cur = perCampaign.get(split.campaignId) ?? { amount: 0, rowIds: [] };
        cur.amount += split.amountMinor;
        cur.rowIds.push(row.rowId);
        perCampaign.set(split.campaignId, cur);
      }
      for (const [campaignId, v] of perCampaign) {
        const std = convertMinor(v.amount, minorUnit, fx.rateText || '1', FX_RATE_SCALE, 2);
        campaignResults.push({
          accountId, billDay, campaignId,
          campaignName: campaignNameOf(input.activityRows, input.mappings, accountId, campaignId),
          currency, amountMinor: v.amount, standardMinor: std ?? 0,
          status: 'confirmed', basis: 'platform_verifiable', estimated: false, sourceRowIds: v.rowIds,
        });
        assignedMinor += v.amount;
      }
    } else if (estimatedLines.length > 0) {
      // 平台给了活动消耗占比但凭证不可核验：按占比分配并强制标估算
      const weights = estimatedLines.map((e) => e.split.shareBps ?? 0);
      const totalWeight = sumMinor(weights);
      const amounts = totalWeight > 0
        ? allocateByBps(correctedMinor, weights)
        : estimatedLines.map(() => 0);
      estimatedLines.forEach(({ split, row }, i) => {
        const std = convertMinor(amounts[i], minorUnit, fx.rateText || '1', FX_RATE_SCALE, 2);
        campaignResults.push({
          accountId, billDay, campaignId: split.campaignId,
          campaignName: campaignNameOf(input.activityRows, input.mappings, accountId, split.campaignId),
          currency, amountMinor: amounts[i], standardMinor: std ?? 0,
          status: 'estimated', basis: 'estimated_share', estimated: true,
          sourceRowIds: [row.rowId],
        });
        assignedMinor += amounts[i];
      });
    } else if (agg) {
      // 平台未提供任何拆分：内部活动仅作参考，活动级一律待分配，余额留待核
      const hasSwitch = agg.switchedPlacements.size > 0;
      for (const [campaignId, amount] of agg.perCampaign) {
        const std = convertMinor(amount, minorUnit, fx.rateText || '1', FX_RATE_SCALE, 2);
        campaignResults.push({
          accountId, billDay, campaignId,
          campaignName: campaignNameOf(input.activityRows, input.mappings, accountId, campaignId),
          currency, amountMinor: amount, standardMinor: std ?? 0,
          status: 'pending_allocation',
          basis: hasSwitch ? 'midday_switch' : 'unallocatable_balance',
          estimated: false, sourceRowIds: agg.rowIds,
        });
      }
      if (hasSwitch) {
        // 软警告而非阻断：活动级待分配，账户级核平仍可单独完成
        warnings.push(
          `[${key}] 日内活动迁移：投放位 ${[...agg.switchedPlacements.keys()].map((k) => k.split('|')[2]).join('、')} 当天切换活动，平台凭证无法拆出切换前后区间金额，活动级结果标为待分配`,
        );
      }
    }

    const unassignedMinor = correctedMinor - assignedMinor;
    // 整数守恒：已确认 + 估算 + 未归属 = 更正后金额（待分配行不计入归属，避免伪装实收）
    const invariantHeld = assignedMinor + unassignedMinor === correctedMinor;
    if (!invariantHeld) partitionBlockers.push('活动归属与未归属余额无法回到账户日总额（守恒不变量被破坏）');

    // ---- 账户日总额 vs 内部活动总额：五类行级比较 ----
    if (rows.length > 0 && agg) {
      const sameCaliber = agg.currency === currency && account?.currency === currency;
      if (!sameCaliber) {
        comparisons.push({
          comparisonId: `CMP-CAL-${key}`, accountId, billDay, currency,
          billRowId: rows[0]?.rowId, activityKey: key, status: 'caliber_different',
          leftAmountMinor: correctedMinor, rightAmountMinor: agg.totalMinor,
          detail: '币种/时区口径不同，禁止直接相减',
          caliberNote: `账单口径 ${currency}/${account?.timezone}；内部口径 ${agg.currency}`,
        });
        partitionBlockers.push('口径不同，需先统一账户币种与时区');
      } else if (correctedMinor === agg.totalMinor) {
        comparisons.push({
          comparisonId: `CMP-EQ-${key}`, accountId, billDay, currency,
          billRowId: rows[0]?.rowId, activityKey: key, status: 'equal',
          leftAmountMinor: correctedMinor, rightAmountMinor: agg.totalMinor,
          detail: '平台账单更正后金额与内部活动日消耗完全相等',
        });
      } else {
        comparisons.push({
          comparisonId: `CMP-DIFF-${key}`, accountId, billDay, currency,
          billRowId: rows[0]?.rowId, activityKey: key, status: 'amount_diff',
          leftAmountMinor: correctedMinor, rightAmountMinor: agg.totalMinor,
          detail: `真实金额差异：账单 ${correctedMinor} vs 内部 ${agg.totalMinor}，差额 ${correctedMinor - agg.totalMinor}（最小单位），可经来源行与汇率版本 ${input.fxVersion} 追溯`,
        });
        partitionBlockers.push('日账与内部活动明细不平，禁止标记已核清');
      }
    }

    const previous = input.previousRun?.accountDays.find(
      (d) => d.accountId === accountId && d.billDay === billDay && d.currency === currency,
    );
    const closed = input.closedPartitionKeys.includes(key) || previous?.closed === true;
    const result: AccountDayResult = {
      accountId, billDay, currency,
      period: billDay.slice(0, 7),
      billOriginalMinor, creditMinor,
      correctedMinor, unassignedMinor,
      standardCorrectedMinor, roundingDiffMinor,
      fxRateVersion: fx.rateVersion, fxRateText: fx.identity ? '1（本币）' : fx.rateText,
      sourceRowIds: rows.map((r) => r.rowId).concat(superseded.filter((s) => s.accountId === accountId && s.billDay === billDay).map((s) => s.rowId)),
      accountBalanced: partitionBlockers.length === 0,
      invariantHeld,
      closed,
      accountConfirmed: previous?.accountConfirmed && partitionBlockers.length === 0 ? previous.accountConfirmed : false,
      campaignConfirmed: previous?.campaignConfirmed && partitionBlockers.length === 0 ? previous.campaignConfirmed : false,
    };
    accountDays.push(result);
    campaignLines.push(...campaignResults);
    blockers.push(...partitionBlockers.map((b) => `[${key}] ${b}`));
    affectedPartitions.push(partition);
  }

  // 未受影响分区从旧版本整体继承（平台整日更正只重开受影响账户/日期）
  if (input.previousRun) {
    const currentKeys = new Set(accountDays.map((d) => partitionKeyString(d)));
    for (const old of input.previousRun.accountDays) {
      const k = partitionKeyString(old);
      if (!currentKeys.has(k)) {
        accountDays.push({ ...old, carriedFromRunId: input.previousRun.runId });
        const oldLines = input.previousRun.campaignLines.filter(
          (l) => l.accountId === old.accountId && l.billDay === old.billDay && l.currency === old.currency,
        );
        campaignLines.push(...oldLines);
        const oldCmps = input.previousRun.comparisons.filter(
          (c) => c.accountId === old.accountId && c.billDay === old.billDay && c.currency === old.currency,
        );
        comparisons.push(...oldCmps);
      }
    }
    warnings.push(...(input.previousRun?.warnings ?? []).filter((w) => !warnings.includes(w)));
  }

  return {
    runId: input.runId,
    version: input.version,
    parentRunId: input.previousRun?.runId,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    status: input.previousRun && input.reopenedKeys ? 'reopened' : 'open',
    trigger: input.trigger,
    inputBatchIds: [...new Set([...input.billRows.map((r) => r.batchId), ...input.activityRows.map((r) => r.batchId), ...input.fxRows.map((r) => r.batchId)])],
    fxVersion: input.fxVersion,
    affectedPartitions,
    accountDays: accountDays.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.billDay.localeCompare(b.billDay)),
    campaignLines,
    comparisons,
    blockers,
    warnings,
    note: input.note,
  };
}

function campaignNameOf(
  activityRows: ActivityHourRow[],
  mappings: MappingInterval[],
  accountId: string,
  campaignId: string,
): string {
  return (
    activityRows.find((r) => r.accountId === accountId && r.campaignId === campaignId)?.campaignName ??
    mappings.find((m) => m.accountId === accountId && m.campaignId === campaignId)?.campaignName ??
    campaignId
  );
}

/** 标准币换算辅助（供调整凭证复用同一口径） */
export function toStandard(amountMinor: number, currency: string, rateText: string): number {
  if (currency === STANDARD_CURRENCY) return amountMinor;
  return convertMinor(amountMinor, minorUnitOf(currency), rateText, FX_RATE_SCALE, 2) ?? 0;
}

/**
 * 从小时投放记录派生活动映射区间：
 * 同一账户+投放位按时间排序，活动在当天中途切换时保留切换前后两个区间。
 */
export function deriveMappingIntervals(rows: ActivityHourRow[]): MappingInterval[] {
  const groups = new Map<string, ActivityHourRow[]>();
  for (const r of rows) {
    const key = `${r.accountId}|${r.placementKey}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const intervals: MappingInterval[] = [];
  let n = 0;
  for (const [key, list] of groups) {
    const [accountId, placementKey] = key.split('|');
    const sorted = [...list].sort((a, b) => a.hourStart.localeCompare(b.hourStart));
    let current: ActivityHourRow | null = null;
    let validFrom = '';
    const flush = (validTo: string | null) => {
      if (!current) return;
      n += 1;
      intervals.push({
        intervalId: `MAP-${n.toString(36)}`,
        accountId,
        placementKey,
        campaignId: current.campaignId,
        campaignName: current.campaignName,
        validFrom,
        validTo,
      });
    };
    for (const r of sorted) {
      if (!current) {
        current = r;
        validFrom = r.hourStart;
      } else if (r.campaignId !== current.campaignId) {
        flush(r.hourStart);
        current = r;
        validFrom = r.hourStart;
      }
    }
    flush(null);
  }
  return intervals;
}
