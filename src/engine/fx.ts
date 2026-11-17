// ============================================================
// 服务日汇率：按账户币种 + 服务日选取，禁止用账单平均汇率掩盖单账户差额
// ============================================================

import type { FxRateRow } from '@/types/domain';
import { STANDARD_CURRENCY } from '@/lib/constants';

export interface FxLookupResult {
  row?: FxRateRow;
  rateText: string;
  rateVersion: string;
  /** 本币 -> 标准币为 1:1，不依赖汇率表 */
  identity: boolean;
  missing?: string;
}

/**
 * 选取某账户币种在服务日的汇率：
 * 1) 标准币自身按 1 处理；
 * 2) 精确匹配 (from, to=CNY, serviceDay, version)；
 * 3) 找不到返回 missing，由上层形成阻断，不静默用别的日期/账户汇率。
 */
export function lookupRate(
  rows: FxRateRow[],
  fromCurrency: string,
  serviceDay: string,
  rateVersion: string,
): FxLookupResult {
  if (fromCurrency === STANDARD_CURRENCY) {
    return { rateText: '1', rateVersion: 'identity', identity: true };
  }
  const exact = rows.find(
    (r) =>
      r.fromCurrency === fromCurrency &&
      r.toCurrency === STANDARD_CURRENCY &&
      r.serviceDay === serviceDay &&
      r.rateVersion === rateVersion,
  );
  if (exact) return { row: exact, rateText: exact.rateText, rateVersion: exact.rateVersion, identity: false };
  // 同币种同版本但日期不符，只用于错误提示，不允许替代
  const nearby = rows.filter((r) => r.fromCurrency === fromCurrency && r.rateVersion === rateVersion);
  return {
    rateText: '',
    rateVersion,
    identity: false,
    missing: `缺少 ${fromCurrency}->${STANDARD_CURRENCY} 在 ${serviceDay}（版本 ${rateVersion}）的服务日汇率` +
      (nearby.length ? `；该版本仅有日期 ${nearby.map((r) => r.serviceDay).join('、')}` : ''),
  };
}
