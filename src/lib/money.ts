// ============================================================
// 定点金额与汇率换算：全程整数/BigInt，杜绝浮点误差
// 币种小数位与汇率精度均由输入口径决定，不在代码里写死
// ============================================================

/** 解析十进制文本为最小货币单位整数；非法输入返回 null（调用方计入拒绝行） */
export function parseMinor(text: string, minorUnit: number): number | null {
  if (text === undefined || text === null) return null;
  const cleaned = String(text).replace(/[,，\s]/g, '');
  if (cleaned === '' || !/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const neg = cleaned.startsWith('-');
  const unsigned = neg ? cleaned.slice(1) : cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  const [intPart, fracPart = ''] = unsigned.split('.');
  if (fracPart.length > minorUnit) {
    // 超出币种小数位的输入不静默截断，交给上层拒绝
    if (Number(fracPart.slice(minorUnit)) !== 0) return null;
  }
  const frac = (fracPart + '0'.repeat(minorUnit)).slice(0, minorUnit);
  const value = Number(`${intPart}${frac}`);
  if (!Number.isSafeInteger(value)) return null;
  return neg ? -value : value;
}

/** 最小单位整数 -> 展示文本（千分位，按币种小数位还原，保留符号） */
export function formatMinor(amountMinor: number, minorUnit: number): string {
  const neg = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const divisor = 10 ** minorUnit;
  const intPart = Math.floor(abs / divisor);
  const fracPart = abs % divisor;
  const intText = intPart.toLocaleString('en-US');
  const fracText = minorUnit > 0 ? `.${String(fracPart).padStart(minorUnit, '0')}` : '';
  return `${neg ? '-' : ''}${intText}${fracText}`;
}

export function formatSigned(amountMinor: number, minorUnit: number, code = ''): string {
  const sign = amountMinor > 0 ? '+' : '';
  return `${sign}${formatMinor(amountMinor, minorUnit)}${code ? ` ${code}` : ''}`;
}

/** 半入整除（BigInt） */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  const neg = numerator < 0n;
  const abs = neg ? -numerator : numerator;
  const q = abs / denominator;
  const r = abs % denominator;
  const result = r * 2n >= denominator ? q + 1n : q;
  return neg ? -result : result;
}

/** 把汇率文本放大 10^rateScale 倍成整数；非法返回 null */
export function parseRateScaled(rateText: string, rateScale: number): bigint | null {
  const cleaned = rateText.replace(/[,，\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [intPart, fracPart = ''] = cleaned.split('.');
  const frac = (fracPart + '0'.repeat(rateScale)).slice(0, rateScale);
  if (fracPart.length > rateScale && Number(fracPart.slice(rateScale)) !== 0) return null;
  try {
    return BigInt(`${intPart}${frac}`);
  } catch {
    return null;
  }
}

/**
 * 服务日汇率换算（单行口径）：
 * standardMinor = round(amountMinor * rate * 10^targetMinor / 10^fromMinor)
 * 汇率精度由 rateScale 固定，全部 BigInt 定点运算。
 */
export function convertMinor(
  amountMinor: number,
  fromMinorUnit: number,
  rateText: string,
  rateScale: number,
  targetMinorUnit: number,
): number | null {
  const rateScaled = parseRateScaled(rateText, rateScale);
  if (rateScaled === null) return null;
  const numerator = BigInt(amountMinor) * rateScaled * 10n ** BigInt(targetMinorUnit);
  const denominator = 10n ** BigInt(rateScale) * 10n ** BigInt(fromMinorUnit);
  const result = divHalfUp(numerator, denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(result);
}

/**
 * 汇总舍入差额（单独列示，不把尾差塞给任一活动）：
 * 先逐行换算再求和 与 先汇总再换算 之差。
 */
export function roundingDiff(
  lineAmountsMinor: number[],
  fromMinorUnit: number,
  rateText: string,
  rateScale: number,
  targetMinorUnit: number,
): { lineConverted: number[]; sumOfLines: number; convertedOfSum: number; diff: number } | null {
  const lineConverted: number[] = [];
  for (const amt of lineAmountsMinor) {
    const v = convertMinor(amt, fromMinorUnit, rateText, rateScale, targetMinorUnit);
    if (v === null) return null;
    lineConverted.push(v);
  }
  const sumOfLines = lineConverted.reduce((a, b) => a + b, 0);
  const sumAmount = lineAmountsMinor.reduce((a, b) => a + b, 0);
  const convertedOfSum = convertMinor(sumAmount, fromMinorUnit, rateText, rateScale, targetMinorUnit);
  if (convertedOfSum === null) return null;
  return { lineConverted, sumOfLines, convertedOfSum, diff: convertedOfSum - sumOfLines };
}

/**
 * 按基点占比把整数总额分配到多行（估算口径）：
 * 严格守恒——最后一行承接整数尾差，总额不变。
 */
export function allocateByBps(totalMinor: number, weightsBps: number[]): number[] {
  const totalBps = weightsBps.reduce((a, b) => a + b, 0);
  if (totalBps <= 0) return weightsBps.map(() => 0);
  const out: number[] = [];
  let allocated = 0;
  weightsBps.forEach((w, i) => {
    if (i === weightsBps.length - 1) {
      out.push(totalMinor - allocated);
    } else {
      const part = Math.floor((totalMinor * w) / totalBps);
      out.push(part);
      allocated += part;
    }
  });
  return out;
}

export function sumMinor(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
