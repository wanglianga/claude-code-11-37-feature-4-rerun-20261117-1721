// ============================================================
// 广告平台账单对账工作台 —— 领域模型
// 金额一律以"币种最小单位整数"（分/厘等）存储，币种小数位由输入口径确定；
// 展示层按币种规格还原。标准币（CNY）金额同样为整数分。
// ============================================================

export type DatasetKind = 'bill' | 'activity' | 'fx';

/** 币种口径：小数位由输入数据确定（如 JPY=0、USD=2），不写死 */
export interface CurrencySpec {
  code: string;
  minorUnit: number;
  label: string;
}

/** 账户口径：固定账户币种与时区，金额标准化不得跨账户平均汇率 */
export interface AccountSpec {
  accountId: string;
  platform: string;
  name: string;
  currency: string;
  timezone: string;
}

// ---------------- 数据导入与字段对应 ----------------

/** 可保存的字段对应：标准字段名 -> 源文件列名 */
export interface FieldMapping {
  mappingId: string;
  name: string;
  kind: DatasetKind;
  columns: Record<string, string>;
  /** 文件缺少某列时使用的常量值（如整文件固定币种） */
  constants?: Record<string, string>;
  createdAt: string;
}

export interface RejectedRawRow {
  /** 数据行号（1-based，不含表头） */
  rowNumber: number;
  raw: Record<string, string>;
  reason: string;
}

/** 判重留痕：合法但被识别为重复件的行，不参与入账但可在运行中生成行级比较 */
export interface DuplicateRecord {
  rowNumber: number;
  raw: Record<string, string>;
  reason: string;
  bill: BillRow;
  existingRowId: string;
}

export type BillLineType = 'charge' | 'credit' | 'correction';

/** 平台账单行（受理账保存原始行与账期）；金额带符号：费用为正，贷项/退款为负 */
export interface BillRow {
  rowId: string;
  batchId: string;
  /** 账期，默认由账单日派生 YYYY-MM */
  period: string;
  /** 平台来源编号 */
  sourceDocNo: string;
  /** 修订号；同编号新修订号 = 更正件 */
  revisionNo: number;
  accountId: string;
  currency: string;
  /** 平台账单日（账户时区口径）YYYY-MM-DD */
  billDay: string;
  /** 行摘要：与账户、账期共同参与重复判断 */
  summary: string;
  lineType: BillLineType;
  /** 带符号整数，最小货币单位 */
  amountMinor: number;
  /** 贷项/退款关联的原账单来源编号 */
  linkedDocNo?: string;
  /** 平台可核验活动拆分（挂在来源编号下的明细行） */
  splits: BillActivitySplit[];
  raw: Record<string, string>;
}

export interface BillActivitySplit {
  campaignId: string;
  amountMinor: number;
  /** 平台凭证可核验才允许确认活动级金额；false 仅为消耗占比估算 */
  verifiable: boolean;
  /** 占比，基点（10000bps=100%），估算口径留痕 */
  shareBps: number | null;
}

/** 内部活动小时投放记录；只有包含可验证时间才允许跨时区拆日 */
export interface ActivityHourRow {
  rowId: string;
  batchId: string;
  accountId: string;
  campaignId: string;
  campaignName: string;
  /** 内部投放位标识：同一投放位当天映射到多个活动即"日内活动迁移" */
  placementKey: string;
  day: string;
  /** 小时起点/终点，ISO-8601 带偏移，含可验证明细时间 */
  hourStart: string;
  hourEnd: string;
  timezone: string;
  currency: string;
  spendMinor: number;
  raw: Record<string, string>;
}

/** 服务日汇率行；精度以文本保留，换算在 engine/fx 内按定点数处理 */
export interface FxRateRow {
  rowId: string;
  batchId: string;
  rateVersion: string;
  fromCurrency: string;
  toCurrency: string;
  serviceDay: string;
  /** 原始汇率文本，精度由输入口径确定 */
  rateText: string;
  appliedAt: string;
}

export interface ImportBatch {
  batchId: string;
  kind: DatasetKind;
  fileName: string;
  format: 'csv' | 'json';
  importedAt: string;
  sourceColumns: string[];
  totalRows: number;
  mappingId?: string;
  rejected: RejectedRawRow[];
  /** 受理阶段判重命中的同额/换号重复件（解析合法但不二次入账，保留原始行与结构化账单行） */
  duplicates: DuplicateRecord[];
  billRows: BillRow[];
  activityRows: ActivityHourRow[];
  fxRows: FxRateRow[];
}

// ---------------- 行级比较（五类） ----------------

export type LineCompareStatus =
  | 'equal' // 已相等
  | 'source_missing' // 来源缺失
  | 'duplicate_candidate' // 重复候选
  | 'caliber_different' // 口径不同（币种/时区/粒度）
  | 'amount_diff'; // 真实金额差异

export interface LineComparison {
  comparisonId: string;
  accountId: string;
  billDay: string;
  currency: string;
  /** 平台账单行 id */
  billRowId?: string;
  /** 内部活动汇总行 id（活动侧聚合） */
  activityKey?: string;
  status: LineCompareStatus;
  leftAmountMinor?: number;
  rightAmountMinor?: number;
  detail: string;
  caliberNote?: string;
}

// ---------------- 对账运行 ----------------

export interface PartitionKey {
  accountId: string;
  billDay: string;
  currency: string;
}

export type CampaignBasis =
  | 'platform_verifiable' // 平台可核验拆分 -> 可确认
  | 'estimated_share' // 按平台消耗占比分配 -> 估算
  | 'midday_switch' // 日内映射切换且凭证不可拆 -> 待分配
  | 'unallocatable_balance'; // 无法拆分余额 -> 待核

export type CampaignLineStatus = 'confirmed' | 'estimated' | 'pending_allocation';

export interface CampaignLineResult {
  accountId: string;
  billDay: string;
  campaignId: string;
  campaignName: string;
  currency: string;
  amountMinor: number;
  standardMinor: number;
  status: CampaignLineStatus;
  basis: CampaignBasis;
  estimated: boolean;
  sourceRowIds: string[];
}

/** 账户日核平结果：正式核平只在平台原生账户/日期粒度成立 */
export interface AccountDayResult {
  accountId: string;
  billDay: string;
  currency: string;
  period: string;
  /** 原金额（charge 合计） */
  billOriginalMinor: number;
  /** 贷项合计（负数） */
  creditMinor: number;
  /** 更正后金额 = 原金额 + 贷项 + 更正件影响 */
  correctedMinor: number;
  /** 未归属余额：账户日总额中无法可靠归到活动的部分 */
  unassignedMinor: number;
  standardCorrectedMinor: number;
  /** 逐行换算合计与汇总换算之差：单独列示，不塞给任何活动 */
  roundingDiffMinor: number;
  fxRateVersion: string;
  fxRateText: string;
  sourceRowIds: string[];
  accountBalanced: boolean;
  /** 活动已确认 + 估算 + 未归属余额必须回得到账户日更正后金额 */
  invariantHeld: boolean;
  /** 分区是否已结账（已付款）；更正只重开未结账分区，已结账走调整凭证 */
  closed: boolean;
  accountConfirmed: boolean;
  campaignConfirmed: boolean;
  /** 未受影响分区从旧版本整体继承时，记录来源运行；受影响分区重算无此字段 */
  carriedFromRunId?: string;
}

export type RunStatus = 'open' | 'account_confirmed' | 'fully_confirmed' | 'reopened';
export type RunTrigger = 'initial' | 'reimport' | 'mapping_fix' | 'fx_revision' | 'late_credit' | 'correction';

export interface ReconcileRun {
  runId: string;
  /** 同一输入演进的版本序号，财务确认与调整均引用具体版本 */
  version: number;
  parentRunId?: string;
  createdAt: string;
  createdBy: string;
  status: RunStatus;
  trigger: RunTrigger;
  inputBatchIds: string[];
  fxVersion: string;
  affectedPartitions: PartitionKey[];
  accountDays: AccountDayResult[];
  campaignLines: CampaignLineResult[];
  comparisons: LineComparison[];
  /** 不平时的阻断原因；非空则禁止标记已核清 */
  blockers: string[];
  /** 软警告（如日内迁移导致待分配）：不阻断账户级核平与确认 */
  warnings: string[];
  note?: string;
}

// ---------------- 调整凭证与财务确认 ----------------

export type AdjustmentKind = 'late_credit' | 'bill_correction' | 'mapping_revision' | 'fx_revision';

export interface AdjustmentVoucher {
  voucherId: string;
  kind: AdjustmentKind;
  createdAt: string;
  accountId: string;
  billDay: string;
  currency: string;
  /** 带符号金额（最小单位） */
  amountMinor: number;
  standardMinor: number;
  /** 关联原账单行；部分退款/贷项不减少其他活动的已确认费用 */
  linkedBillRowIds: string[];
  /** 引用同一运行版本 */
  runId: string;
  note: string;
  /** 已结账分区只生成调整凭证，不回改旧分区 */
  postedToClosedPartition: boolean;
}

export interface Confirmation {
  confirmationId: string;
  runId: string;
  level: 'account' | 'campaign';
  partition: PartitionKey;
  campaignId?: string;
  confirmedBy: string;
  confirmedAt: string;
  status: 'confirmed' | 'requires_rereview';
  /** 汇率修订与确认并发时，留痕新旧差额 */
  oldDiffMinor?: number;
  newDiffMinor?: number;
  note?: string;
}

/** 日内活动映射区间（切换前后都保留） */
export interface MappingInterval {
  intervalId: string;
  accountId: string;
  placementKey: string;
  campaignId: string;
  campaignName: string;
  validFrom: string;
  validTo: string | null;
}
