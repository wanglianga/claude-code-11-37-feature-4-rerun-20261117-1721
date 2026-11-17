// 多币种金额与时间展示工具（金额为各币种最小单位整数）
import { CURRENCIES, STANDARD_CURRENCY } from '@/lib/constants';
import { formatMinor } from '@/lib/money';

export function minorUnitOf(code: string): number {
  return CURRENCIES.find((c) => c.code === code)?.minorUnit ?? 2;
}

export function formatAmount(amountMinor: number, currency: string): string {
  return `${formatMinor(amountMinor, minorUnitOf(currency))} ${currency}`;
}

/** 标准币（CNY，单位：分）展示 */
export function formatStandard(cents: number): string {
  return `¥${formatMinor(cents, 2)}`;
}

export function formatSigned(amountMinor: number, currency: string): string {
  const sign = amountMinor > 0 ? '+' : '';
  return `${sign}${formatAmount(amountMinor, currency)}`;
}

export function formatPercent(bps: number | null): string {
  if (bps === null) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatDateTime(iso: string, timezone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
  };
  try {
    return new Intl.DateTimeFormat('zh-CN', opts).format(d);
  } catch {
    return iso;
  }
}

export function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

export { STANDARD_CURRENCY };
