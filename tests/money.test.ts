import { describe, expect, it } from 'vitest';
import {
  allocateByBps, convertMinor, formatMinor, parseMinor, parseRateScaled, roundingDiff,
} from '@/lib/money';

describe('定点金额解析与格式化（币种小数位由输入口径决定）', () => {
  it('两位小数币种：CNY/USD 文本转最小单位整数，支持千分位与符号', () => {
    expect(parseMinor('1,200.00', 2)).toBe(120000);
    expect(parseMinor('-100.00', 2)).toBe(-10000);
    expect(parseMinor('100', 2)).toBe(10000);
    expect(formatMinor(120000, 2)).toBe('1,200.00');
    expect(formatMinor(-10000, 2)).toBe('-100.00');
  });

  it('零小数币种 JPY：不得制造小数单位', () => {
    expect(parseMinor('120000', 0)).toBe(120000);
    expect(formatMinor(120000, 0)).toBe('120,000');
  });

  it('超出币种小数位的非零尾数拒绝而非静默截断', () => {
    expect(parseMinor('1.239', 2)).toBeNull();
    expect(parseMinor('1.230', 2)).toBe(123); // 尾零可接受
    expect(parseMinor('abc', 2)).toBeNull();
  });

  it('汇率按输入精度解析为定点整数', () => {
    expect(parseRateScaled('7.123457', 6)).toBe(7123457n);
    expect(parseRateScaled('0.047823', 6)).toBe(47823n);
    expect(parseRateScaled('7.1234578', 6)).toBeNull(); // 超精度拒绝
  });
});

describe('服务日汇率换算与跨币种舍入', () => {
  it('USD 1200.00 @7.123457 -> CNY 8548.15（BigInt 定点半入）', () => {
    expect(convertMinor(120000, 2, '7.123457', 6, 2)).toBe(854815);
  });

  it('JPY 120000（零小数）@0.047823 -> CNY 5738.76', () => {
    expect(convertMinor(120000, 0, '0.047823', 6, 2)).toBe(573876);
  });

  it('本币 1:1 换算不依赖汇率表', () => {
    expect(convertMinor(5000, 2, '1', 6, 2)).toBe(5000);
  });

  it('逐行换算与汇总换算的舍入差额被单独量化，差额只可能为 -1/0/1 分', () => {
    const r = roundingDiff([25055, 54945], 2, '7.123457', 6, 2)!;
    expect(r.sumOfLines).toBe(r.lineConverted[0] + r.lineConverted[1]);
    expect([-1, 0, 1]).toContain(r.diff);
    expect(r.convertedOfSum - r.sumOfLines).toBe(r.diff);
  });
});

describe('按基点占比的整数分配（估算口径守恒）', () => {
  it('尾差由最后一行承接，总额严格不变', () => {
    const parts = allocateByBps(10000, [3333, 3333, 3334]);
    expect(parts).toEqual([3333, 3333, 3334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('零权重返回全零，不产生除零', () => {
    expect(allocateByBps(500, [0, 0])).toEqual([0, 0]);
  });
});
