// ============================================================
// 示例输入文件（CSV / JSON 原文）
// 覆盖验收场景：同额重复件、同号更正件、日内活动迁移、跨币种舍入、贷项迟到、
// 账户隔离、可核验拆分、消耗占比估算、未归属余额、口径不同、来源缺失。
// 注意：种子数据同样经由 parse 管线导入，并非写死的对账结果。
// ============================================================

export interface SampleFile {
  kind: 'bill' | 'activity' | 'fx';
  fileName: string;
  format: 'csv' | 'json';
  text: string;
  /** 预置字段对应（标准字段 -> 列名），可在页面修改后另存 */
  mapping: Record<string, string>;
  description: string;
}

// ---------------- 初始三文件：账单 / 活动 / 汇率 ----------------

const BILL_INITIAL_CSV = `账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额,活动标识,拆分金额,活动占比基点,可核验标记
ACC-CN-01,CNY,2026-11-01,B-CN-1001,1,搜索广告-1101,charge,10000.00,C-CN-A;C-CN-B,6000.00;4000.00,6000;4000,true;true
ACC-CN-01,CNY,2026-11-01,B-CN-1002,1,信息流托管费-1101,charge,5000.00,,,,
ACC-CN-01,CNY,2026-11-02,B-CN-1003,1,搜索广告-1102,charge,8000.00,C-CN-F;C-CN-G,,7000;3000,false;false
ACC-CN-01,CNY,2026-11-03,B-CN-1004,1,搜索广告-1103,charge,3000.00,,,,
ACC-US-02,USD,2026-11-01,B-US-2001,1,display-nov1,charge,1200.00,C-US-A,1200.00,10000,true
ACC-US-02,USD,2026-11-02,B-US-2002,1,display-nov2-am,charge,250.55,,,,
ACC-US-02,USD,2026-11-02,B-US-2003,1,display-nov2-pm,charge,549.45,,,,
ACC-US-02,USD,2026-11-03,B-US-2005,1,display-nov3,charge,500.00,,,,
ACC-JP-03,JPY,2026-11-01,B-JP-3001,1,dsp-1101,charge,120000,,,,
ACC-JP-03,JPY,2026-11-02,B-JP-3002,1,dsp-1102,charge,60000,,,,`;

const ACTIVITY_INITIAL_CSV = `账户编号,活动标识,活动名称,投放位标识,投放日,小时起点,小时终点,时区,币种,小时消耗
ACC-CN-01,C-CN-A,春季大促-搜索词A,PL-CN-1,2026-11-01,2026-11-01T00:00:00+08:00,2026-11-01T08:00:00+08:00,Asia/Shanghai,CNY,2000.00
ACC-CN-01,C-CN-A,春季大促-搜索词A,PL-CN-1,2026-11-01,2026-11-01T08:00:00+08:00,2026-11-02T00:00:00+08:00,Asia/Shanghai,CNY,4000.00
ACC-CN-01,C-CN-B,品牌词-B,PL-CN-2,2026-11-01,2026-11-01T09:00:00+08:00,2026-11-01T18:00:00+08:00,Asia/Shanghai,CNY,4000.00
ACC-CN-01,C-CN-E,托管信息流-E,PL-CN-5,2026-11-01,2026-11-01T10:00:00+08:00,2026-11-01T20:00:00+08:00,Asia/Shanghai,CNY,5000.00
ACC-CN-01,C-CN-F,复投计划-F,PL-CN-7,2026-11-02,2026-11-02T00:00:00+08:00,2026-11-02T16:00:00+08:00,Asia/Shanghai,CNY,5600.00
ACC-CN-01,C-CN-G,长尾计划-G,PL-CN-8,2026-11-02,2026-11-02T08:00:00+08:00,2026-11-03T00:00:00+08:00,Asia/Shanghai,CNY,2400.00
ACC-CN-01,C-CN-C,午前活动-C,PL-CN-9,2026-11-03,2026-11-03T00:00:00+08:00,2026-11-03T12:00:00+08:00,Asia/Shanghai,CNY,1800.00
ACC-CN-01,C-CN-D,午后活动-D,PL-CN-9,2026-11-03,2026-11-03T12:00:00+08:00,2026-11-04T00:00:00+08:00,Asia/Shanghai,CNY,1200.00
ACC-US-02,C-US-A,us-search-A,PL-US-1,2026-11-01,2026-11-01T00:00:00-07:00,2026-11-02T00:00:00-07:00,America/Los_Angeles,USD,1200.00
ACC-US-02,C-US-B,us-display-B,PL-US-2,2026-11-02,2026-11-02T00:00:00-08:00,2026-11-02T12:00:00-08:00,America/Los_Angeles,USD,250.55
ACC-US-02,C-US-B,us-display-B,PL-US-2,2026-11-02,2026-11-02T12:00:00-08:00,2026-11-03T00:00:00-08:00,America/Los_Angeles,USD,549.45
ACC-US-02,C-US-C,us-native-C,PL-US-3,2026-11-03,2026-11-03T00:00:00-08:00,2026-11-04T00:00:00-08:00,America/Los_Angeles,USD,480.00
ACC-JP-03,C-JP-A,jp-feed-A,PL-JP-1,2026-11-01,2026-11-01T00:00:00+09:00,2026-11-02T00:00:00+09:00,Asia/Tokyo,JPY,120000
ACC-JP-03,C-JP-B,jp-feed-B,PL-JP-2,2026-11-02,2026-11-02T20:00:00Z,2026-11-02T23:00:00Z,Asia/Tokyo,JPY,60000
ACC-JP-03,C-JP-C,jp-feed-C,PL-JP-3,2026-11-03,2026-11-03T00:00:00+09:00,2026-11-04T00:00:00+09:00,Asia/Tokyo,JPY,30000`;

const FX_INITIAL_CSV = `汇率版本,源币种,目标币种,服务日,汇率,发布时间
FX-2026-11A,USD,CNY,2026-11-01,7.123457,2026-11-02T09:00:00+08:00
FX-2026-11A,USD,CNY,2026-11-02,7.123457,2026-11-03T09:00:00+08:00
FX-2026-11A,USD,CNY,2026-11-03,7.123457,2026-11-04T09:00:00+08:00
FX-2026-11A,JPY,CNY,2026-11-01,0.047823,2026-11-02T09:00:00+08:00
FX-2026-11A,JPY,CNY,2026-11-02,0.047823,2026-11-03T09:00:00+08:00
FX-2026-11A,JPY,CNY,2026-11-03,0.047823,2026-11-04T09:00:00+08:00`;

// ---------------- 后续到达文件 ----------------

/** 同额重复件 + 换号重复候选：均不得二次入账 */
const BILL_REIMPORT_CSV = `账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额
ACC-CN-01,CNY,2026-11-01,B-CN-1001,1,搜索广告-1101,charge,10000.00
ACC-CN-01,CNY,2026-11-01,B-CN-1099,1,信息流托管费-1101,charge,5000.00`;

/** 同号更正件：修订号 1->2、金额改变，形成修订候选而非重复件，只重开 JP 11-01 */
const BILL_CORRECTION_CSV = `账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额
ACC-JP-03,JPY,2026-11-01,B-JP-3001,2,dsp-1101,correction,118000`;

/** 迟到部分贷项：关联原账单行，作为后续调整，不冲减其他活动 */
const BILL_LATE_CREDIT_CSV = `账户编号,币种,账单日,来源编号,修订号,行摘要,行类型,金额,关联原单号
ACC-US-02,USD,2026-11-02,B-US-2004,1,partial-credit-nov2,credit,-100.00,B-US-2002`;

/** 汇率修订（JSON 格式）：仅 USD 11-02 服务日汇率变化，触发新旧差额复核 */
const FX_REVISION_JSON = `[
  {"汇率版本":"FX-2026-11B","源币种":"USD","目标币种":"CNY","服务日":"2026-11-01","汇率":"7.123457","发布时间":"2026-11-05T09:00:00+08:00"},
  {"汇率版本":"FX-2026-11B","源币种":"USD","目标币种":"CNY","服务日":"2026-11-02","汇率":"7.130000","发布时间":"2026-11-05T09:00:00+08:00"},
  {"汇率版本":"FX-2026-11B","源币种":"USD","目标币种":"CNY","服务日":"2026-11-03","汇率":"7.123457","发布时间":"2026-11-05T09:00:00+08:00"},
  {"汇率版本":"FX-2026-11B","源币种":"JPY","目标币种":"CNY","服务日":"2026-11-01","汇率":"0.047823","发布时间":"2026-11-05T09:00:00+08:00"},
  {"汇率版本":"FX-2026-11B","源币种":"JPY","目标币种":"CNY","服务日":"2026-11-02","汇率":"0.047823","发布时间":"2026-11-05T09:00:00+08:00"},
  {"汇率版本":"FX-2026-11B","源币种":"JPY","目标币种":"CNY","服务日":"2026-11-03","汇率":"0.047823","发布时间":"2026-11-05T09:00:00+08:00"}
]`;

const BILL_MAPPING: Record<string, string> = {
  accountId: '账户编号', currency: '币种', billDay: '账单日', sourceDocNo: '来源编号',
  revisionNo: '修订号', summary: '行摘要', lineType: '行类型', amount: '金额',
  campaignId: '活动标识', splitAmount: '拆分金额', shareBps: '活动占比基点',
  verifiable: '可核验标记', linkedDocNo: '关联原单号',
};

const ACTIVITY_MAPPING: Record<string, string> = {
  accountId: '账户编号', campaignId: '活动标识', campaignName: '活动名称',
  placementKey: '投放位标识', day: '投放日', hourStart: '小时起点', hourEnd: '小时终点',
  timezone: '时区', currency: '币种', spend: '小时消耗',
};

const FX_MAPPING: Record<string, string> = {
  rateVersion: '汇率版本', fromCurrency: '源币种', toCurrency: '目标币种',
  serviceDay: '服务日', rate: '汇率', appliedAt: '发布时间',
};

export const SAMPLE_FILES: SampleFile[] = [
  {
    kind: 'bill', fileName: 'platform-bill-2026-11-initial.csv', format: 'csv',
    text: BILL_INITIAL_CSV, mapping: BILL_MAPPING,
    description: '初始平台账单：3 个账户/3 个币种，含可核验拆分、占比估算、无拆分行',
  },
  {
    kind: 'activity', fileName: 'internal-activity-hourly.csv', format: 'csv',
    text: ACTIVITY_INITIAL_CSV, mapping: ACTIVITY_MAPPING,
    description: '内部小时投放：含 11-03 同投放位日内迁移、JP 跨时区日历日错位行',
  },
  {
    kind: 'fx', fileName: 'fx-rates-FX-2026-11A.csv', format: 'csv',
    text: FX_INITIAL_CSV, mapping: FX_MAPPING,
    description: '服务日汇率版本 FX-2026-11A（USD/JPY -> CNY）',
  },
  {
    kind: 'bill', fileName: 'platform-bill-reimport-duplicates.csv', format: 'csv',
    text: BILL_REIMPORT_CSV, mapping: BILL_MAPPING,
    description: '重复导入：一条同额同号重复件、一条换号重复候选',
  },
  {
    kind: 'bill', fileName: 'platform-bill-jp-correction.csv', format: 'csv',
    text: BILL_CORRECTION_CSV, mapping: BILL_MAPPING,
    description: '同号更正件：B-JP-3001 修订号 2，金额 120000 -> 118000 JPY',
  },
  {
    kind: 'bill', fileName: 'platform-bill-late-credit.csv', format: 'csv',
    text: BILL_LATE_CREDIT_CSV, mapping: BILL_MAPPING,
    description: '迟到部分贷项：B-US-2004 关联原单 B-US-2002，-100.00 USD',
  },
  {
    kind: 'fx', fileName: 'fx-rates-FX-2026-11B.json', format: 'json',
    text: FX_REVISION_JSON, mapping: FX_MAPPING,
    description: '汇率修订版本 FX-2026-11B（JSON）：仅 USD 2026-11-02 改为 7.130000',
  },
];

export const INITIAL_SAMPLE_FILES = SAMPLE_FILES.slice(0, 3);
export const FOLLOWUP_SAMPLE_FILES = SAMPLE_FILES.slice(3);
