import { describe, expect, it } from 'vitest';
import {
  buildActivityRows, buildBillRows, buildFxRows, parseCsv, suggestMapping,
} from '@/engine/parse';
import { decideIngestion, effectiveBillRows } from '@/engine/dedup';
import { makeBill } from './helpers';

const BILL_MAPPING = {
  accountId: '账户编号', currency: '币种', billDay: '账单日', sourceDocNo: '来源编号',
  revisionNo: '修订号', summary: '行摘要', lineType: '行类型', amount: '金额',
  campaignId: '活动标识', splitAmount: '拆分金额', shareBps: '活动占比基点', verifiable: '可核验标记',
};

describe('CSV 解析与字段对应建议', () => {
  it('RFC4180 引号、转义与 CRLF', () => {
    const p = parseCsv('a,b\r\n"x,y","q""z"\r\n1,2');
    expect(p.headers).toEqual(['a', 'b']);
    expect(p.rows[0]).toEqual({ a: 'x,y', b: 'q"z' });
    expect(p.rows[1]).toEqual({ a: '1', b: '2' });
  });

  it('按中文别名自动建议字段对应', () => {
    const p = parseCsv('账户编号,账单日,金额\nACC-CN-01,2026-11-01,1.00');
    const m = suggestMapping('bill', p.headers);
    expect(m.accountId).toBe('账户编号');
    expect(m.billDay).toBe('账单日');
    expect(m.amount).toBe('金额');
  });
});

describe('账单行构建与拒绝行', () => {
  it('合法行受理并按币种小数位解析；多拆分金额守恒', () => {
    const csv = '账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额,活动标识,拆分金额,可核验标记\n' +
      'ACC-CN-01,CNY,2026-11-01,B1,1,s,charge,100.00,C1;C2,60.00;40.00,true;true';
    const built = buildBillRows(parseCsv(csv), 'BAT-T1', BILL_MAPPING);
    expect(built.rejected).toHaveLength(0);
    expect(built.accepted[0].amountMinor).toBe(10000);
    expect(built.accepted[0].splits.map((s) => s.amountMinor)).toEqual([6000, 4000]);
    expect(built.accepted[0].splits.every((s) => s.verifiable)).toBe(true);
  });

  it('拆分合计不等于行金额 -> 拒绝，不静默改数', () => {
    const csv = '账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额,活动标识,拆分金额\n' +
      'ACC-CN-01,CNY,2026-11-01,B1,1,s,charge,100.00,C1;C2,60.00;39.00';
    const built = buildBillRows(parseCsv(csv), 'BAT-T1', BILL_MAPPING);
    expect(built.accepted).toHaveLength(0);
    expect(built.rejected[0].reason).toContain('不等于行金额');
  });

  it('账户币种不符、非法日期、坏金额均被拒绝并保留原始行', () => {
    const csv = '账户编号,币种,账单日,来源编号,金额\n' +
      'ACC-CN-01,USD,2026-11-01,B1,10.00\n' +
      'ACC-CN-01,CNY,2026-13-01,B2,10.00\n' +
      'ACC-CN-01,CNY,2026-11-01,B3,bad\n' +
      'ACC-XX-99,CNY,2026-11-01,B4,10.00';
    const built = buildBillRows(parseCsv(csv), 'BAT-T1', BILL_MAPPING);
    expect(built.accepted).toHaveLength(0);
    expect(built.rejected).toHaveLength(4);
    expect(built.rejected[0].raw['来源编号']).toBe('B1');
  });

  it('活动行缺少带偏移的明细时间 -> 拒绝（跨时区拆日前提）', () => {
    const csv = '账户编号,活动标识,投放位标识,投放日,小时起点,小时终点,币种,小时消耗\n' +
      'ACC-CN-01,C1,P1,2026-11-03,2026-11-03 00:00,2026-11-03 12:00,CNY,10.00';
    const mapping = {
      accountId: '账户编号', campaignId: '活动标识', placementKey: '投放位标识', day: '投放日',
      hourStart: '小时起点', hourEnd: '小时终点', currency: '币种', spend: '小时消耗',
    };
    const built = buildActivityRows(parseCsv(csv), 'BAT-T1', mapping);
    expect(built.rejected).toHaveLength(1);
    expect(built.rejected[0].reason).toContain('ISO-8601');
  });

  it('汇率超精度与缺版本被拒绝', () => {
    const csv = '汇率版本,源币种,目标币种,服务日,汇率\nFX-1,USD,CNY,2026-11-01,7.1234578\n,USD,CNY,2026-11-01,7.1';
    const mapping = { rateVersion: '汇率版本', fromCurrency: '源币种', toCurrency: '目标币种', serviceDay: '服务日', rate: '汇率' };
    const built = buildFxRows(parseCsv(csv), 'BAT-T1', mapping);
    expect(built.accepted).toHaveLength(0);
    expect(built.rejected).toHaveLength(2);
  });
});

describe('账单受理：重复件 / 修订候选', () => {
  const existing = [
    makeBill({ accountId: 'ACC-CN-01', currency: 'CNY', billDay: '2026-11-01', sourceDocNo: 'B-CN-1001', amountMinor: 1000000, summary: '搜索广告-1101', revisionNo: 1 }),
    makeBill({ accountId: 'ACC-CN-01', currency: 'CNY', billDay: '2026-11-01', sourceDocNo: 'B-CN-1002', amountMinor: 500000, summary: '信息流托管费-1101', revisionNo: 1 }),
  ];

  it('同额同号 -> 同额重复件，不二次入账', () => {
    const dup = makeBill({ ...existing[0], rowId: 'NEW1' });
    const [d] = decideIngestion(existing, [dup]);
    expect(d.kind).toBe('duplicate');
  });

  it('换号但业务键与金额相同 -> 重复候选', () => {
    const otherDoc = makeBill({ ...existing[1], rowId: 'NEW2', sourceDocNo: 'B-CN-1099' });
    const [d] = decideIngestion(existing, [otherDoc]);
    expect(d.kind).toBe('duplicate');
    expect(d.reason).toContain('换号重传');
  });

  it('同号金额改变 -> 修订候选，既不丢弃也不相加', () => {
    const rev = makeBill({ ...existing[0], rowId: 'NEW3', amountMinor: 980000, revisionNo: 2 });
    const [d] = decideIngestion(existing, [rev]);
    expect(d.kind).toBe('revision_candidate');
  });

  it('修订链只保留最高修订号为生效行，旧行留痕', () => {
    const rows = [
      makeBill({ accountId: 'ACC-JP-03', currency: 'JPY', billDay: '2026-11-01', sourceDocNo: 'D1', amountMinor: 120000, revisionNo: 1, rowId: 'r1' }),
      makeBill({ accountId: 'ACC-JP-03', currency: 'JPY', billDay: '2026-11-01', sourceDocNo: 'D1', amountMinor: 118000, revisionNo: 2, rowId: 'r2', lineType: 'correction' }),
    ];
    const { effective, superseded } = effectiveBillRows(rows);
    expect(effective).toHaveLength(1);
    expect(effective[0].amountMinor).toBe(118000);
    expect(superseded[0].revisionNo).toBe(1);
  });
});
