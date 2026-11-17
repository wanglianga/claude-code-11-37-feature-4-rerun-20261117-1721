import type { AccountSpec, CurrencySpec, RunStatus } from '@/types/domain';

// ---------------- 币种口径（小数位由输入口径登记，不写死在换算逻辑里） ----------------
export const CURRENCIES: CurrencySpec[] = [
  { code: 'CNY', minorUnit: 2, label: '人民币' },
  { code: 'USD', minorUnit: 2, label: '美元' },
  { code: 'JPY', minorUnit: 0, label: '日元' },
  { code: 'EUR', minorUnit: 2, label: '欧元' },
];

export const STANDARD_CURRENCY = 'CNY';
/** 汇率输入精度（定点放大倍数），由汇率输入口径固定 */
export const FX_RATE_SCALE = 6;

export function currencySpec(code: string): CurrencySpec {
  const spec = CURRENCIES.find((c) => c.code === code);
  if (!spec) throw new Error(`未知币种 ${code}`);
  return spec;
}

// ---------------- 账户口径：固定账户币种与时区 ----------------
export const ACCOUNTS: AccountSpec[] = [
  { accountId: 'ACC-CN-01', platform: '星河广告', name: '国内搜索主账户', currency: 'CNY', timezone: 'Asia/Shanghai' },
  { accountId: 'ACC-US-02', platform: 'Aurora Ads', name: '北美展示账户', currency: 'USD', timezone: 'America/Los_Angeles' },
  { accountId: 'ACC-JP-03', platform: 'Sakura DSP', name: '日本信息流账户', currency: 'JPY', timezone: 'Asia/Tokyo' },
];

export function accountSpec(accountId: string): AccountSpec {
  const acc = ACCOUNTS.find((a) => a.accountId === accountId);
  if (!acc) throw new Error(`未知账户 ${accountId}`);
  return acc;
}

// ---------------- 运行状态展示 ----------------
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  open: '待确认',
  account_confirmed: '账户级已确认',
  fully_confirmed: '全部已确认',
  reopened: '已重开',
};

export const RUN_STATUS_COLORS: Record<RunStatus, string> = {
  open: '#8c8c8c',
  account_confirmed: '#1677ff',
  fully_confirmed: '#389e0d',
  reopened: '#d46b08',
};

export const LINE_STATUS_LABELS: Record<string, string> = {
  equal: '已相等',
  source_missing: '来源缺失',
  duplicate_candidate: '重复候选',
  caliber_different: '口径不同',
  amount_diff: '真实金额差异',
};

export const LINE_STATUS_TONE: Record<string, string> = {
  equal: 'green',
  source_missing: 'orange',
  duplicate_candidate: 'purple',
  caliber_different: 'gray',
  amount_diff: 'red',
};

export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  confirmed: '已确认',
  estimated: '估算（消耗占比）',
  pending_allocation: '待分配',
};

export interface AnalystAccount {
  userId: string;
  name: string;
  role: 'analyst' | 'owner';
  description: string;
}

export const USER_ACCOUNTS: AnalystAccount[] = [
  { userId: 'U-1001', name: '林岚', role: 'analyst', description: '财务分析员 A：导入文件、建立字段对应、创建对账运行与调整' },
  { userId: 'U-1002', name: '高航', role: 'analyst', description: '财务分析员 B：补入迟到贷项、修订映射与汇率，产生新版本运行' },
  { userId: 'U-2001', name: '赵明', role: 'owner', description: '财务负责人：分级确认（账户总额/活动归属）、复核并发差额、结账' },
];
