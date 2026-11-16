import type {
  Channel,
  DataSnapshot,
  IdentityLink,
  IngestionJob,
  Order,
  OrderVersion,
  PlatformClickAggregate,
  RefundEvent,
  Touchpoint,
} from '@/types/domain';

// ============================================================
// 样例数据
// 金额单位：分。场景标签直接写在订单 scenarioTag 上，便于验收回查。
// 两个快照：
//   DS-2026-11-01（DV-2026.11.01）—— 首次接入
//   DS-2026-11-05（DV-2026.11.05）—— 迟到退款 R-1006 到达后的新版本
// ============================================================

export const RULE_REVISION_V1 = 'RR-2026-03';
export const RULE_REVISION_V2 = 'RR-2026-04';

export const channels: Channel[] = [
  { channelId: 'C-SEM', name: '品牌搜索', platform: 'Google Ads', mediaType: '搜索' },
  { channelId: 'C-SOCIAL', name: '社交流', platform: 'Meta', mediaType: '社交' },
  { channelId: 'C-DISPLAY', name: '展示广告', platform: 'The Trade Desk', mediaType: '展示' },
  { channelId: 'C-EMAIL', name: 'EDM 邮件', platform: '自有营销云', mediaType: '邮件' },
  { channelId: 'C-ORGANIC', name: '自然流量', platform: '自有', mediaType: '自有' },
];

export const identityLinks: IdentityLink[] = [
  {
    personId: 'P-1001',
    displayName: '李雷（已授权跨设备）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1001', authorized: true, deviceId: 'D-A1' },
      { kind: 'login_id', value: 'login-1001', authorized: true, deviceId: 'D-A2' },
      { kind: 'email_hash', value: 'hash-aa77', authorized: true, deviceId: 'D-A1' },
      { kind: 'device_id', value: 'D-A1', authorized: true, deviceId: 'D-A1' },
      { kind: 'device_id', value: 'D-A2', authorized: true, deviceId: 'D-A2' },
    ],
    note: '登录 ID 在两台设备均完成授权同意，允许跨设备连接旅程。',
  },
  {
    personId: 'P-1002',
    displayName: '韩梅梅（单设备已授权）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1002', authorized: true, deviceId: 'D-B1' },
      { kind: 'device_id', value: 'D-B1', authorized: true, deviceId: 'D-B1' },
    ],
  },
  {
    personId: 'P-1003',
    displayName: '王芳（跨设备未授权）',
    crossDeviceAuthorized: false,
    identifiers: [
      { kind: 'email_hash', value: 'hash-cc33', authorized: true, deviceId: 'D-C1' },
      { kind: 'email_hash', value: 'hash-cc33', authorized: true, deviceId: 'D-C2' },
      { kind: 'device_id', value: 'D-C1', authorized: true, deviceId: 'D-C1' },
      { kind: 'device_id', value: 'D-C2', authorized: true, deviceId: 'D-C2' },
    ],
    note: '两台设备出现相同 email_hash，但缺少跨设备匹配授权；引擎禁止把 D-C1/D-C2 拼成同一旅程。',
  },
  {
    personId: 'P-1005',
    displayName: '周强（已授权跨设备+CRM）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1005', authorized: true, deviceId: 'D-E1' },
      { kind: 'crm_id', value: 'crm-5510', authorized: true, deviceId: 'D-E2' },
      { kind: 'device_id', value: 'D-E1', authorized: true, deviceId: 'D-E1' },
      { kind: 'device_id', value: 'D-E2', authorized: true, deviceId: 'D-E2' },
    ],
    note: 'CRM 匹配授权覆盖手机与平板，可跨设备归并。',
  },
  {
    personId: 'P-1006',
    displayName: '陈静（已授权，无订单级触点）',
    crossDeviceAuthorized: true,
    identifiers: [
      { kind: 'login_id', value: 'login-1006', authorized: true, deviceId: 'D-F1' },
      { kind: 'device_id', value: 'D-F1', authorized: true, deviceId: 'D-F1' },
    ],
  },
];

export const orders: Order[] = [
  {
    orderId: 'O-2001', personId: 'P-1001', deviceId: 'D-A2',
    orderTime: '2026-11-01T06:20:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 129900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3001', 'T-3002', 'T-3003'],
    scenarioTag: '跨设备已授权：手机搜索 → PC 社交 → PC 邮件',
  },
  {
    orderId: 'O-2009', personId: 'P-1001', deviceId: 'D-A1',
    orderTime: '2026-11-02T10:40:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 45900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3004'],
  },
  {
    orderId: 'O-2002', personId: 'P-1002', deviceId: 'D-B1',
    orderTime: '2026-11-01T03:00:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 89900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3005', 'T-3006'],
    scenarioTag: '迟到退款：运行锁定后 R-1006 到达，仅触发新运行',
  },
  {
    orderId: 'O-2003', personId: 'P-1003', deviceId: 'D-C1',
    orderTime: '2026-10-31T12:00:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 59900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3007', 'T-3008'],
    scenarioTag: '跨设备未授权：D-C1 旅程不与 D-C2 合并',
  },
  {
    orderId: 'O-2007', personId: 'P-1003', deviceId: 'D-C2',
    orderTime: '2026-11-01T08:30:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 25900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3009'],
    scenarioTag: '跨设备未授权：相同 email_hash 仍保持独立旅程',
  },
  {
    orderId: 'O-2005', personId: 'P-1005', deviceId: 'D-E2',
    orderTime: '2026-11-01T02:10:00Z', orderTimezone: 'America/Los_Angeles',
    grossAmount: 249900, currency: 'CNY', status: 'refunded_partial',
    touchpointIds: ['T-3010', 'T-3011', 'T-3012', 'T-3013'],
    scenarioTag: '跨时区活动 + 部分退款（黑五全球场，洛杉矶曝光）',
  },
  {
    orderId: 'O-2004', personId: null, deviceId: 'D-X1',
    orderTime: '2026-11-01T20:00:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 39900, currency: 'CNY', status: 'placed',
    touchpointIds: ['T-3014'],
    scenarioTag: '未知来源：无授权人员标识，收入单列不参与渠道分配',
  },
  {
    orderId: 'O-2006', personId: 'P-1006', deviceId: 'D-F1',
    orderTime: '2026-10-31T22:00:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 15900, currency: 'CNY', status: 'placed',
    touchpointIds: [],
    scenarioTag: '无订单标识点击：点击只存在于平台汇总区，订单级触点缺失 → 未知来源',
  },
  {
    orderId: 'O-2008', personId: 'P-1002', deviceId: 'D-B1',
    orderTime: '2026-10-31T16:00:00Z', orderTimezone: 'Asia/Shanghai',
    grossAmount: 7900, currency: 'CNY', status: 'cancelled',
    touchpointIds: ['T-3015'],
    scenarioTag: '已取消订单净额为 0，不参与分配但保留可查记录',
  },
];

export const touchpoints: Touchpoint[] = [
  // O-2001 跨设备旅程（P-1001 已授权）
  { touchpointId: 'T-3001', orderId: 'O-2001', personId: 'P-1001', deviceId: 'D-A1', channelId: 'C-SEM', campaignId: 'CMP-BRAND', campaignName: '品牌词搜索', eventTime: '2026-10-28T09:12:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  { touchpointId: 'T-3002', orderId: 'O-2001', personId: 'P-1001', deviceId: 'D-A2', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', campaignName: '秋季信息流', eventTime: '2026-10-30T13:40:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  { touchpointId: 'T-3003', orderId: 'O-2001', personId: 'P-1001', deviceId: 'D-A2', channelId: 'C-EMAIL', campaignId: 'CMP-EDM', campaignName: '双11 提醒邮件', eventTime: '2026-11-01T05:50:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  // O-2009
  { touchpointId: 'T-3004', orderId: 'O-2009', personId: 'P-1001', deviceId: 'D-A1', channelId: 'C-SEM', campaignId: 'CMP-BRAND', campaignName: '品牌词搜索', eventTime: '2026-11-02T10:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  // O-2002
  { touchpointId: 'T-3005', orderId: 'O-2002', personId: 'P-1002', deviceId: 'D-B1', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', campaignName: '秋季信息流', eventTime: '2026-10-29T02:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  { touchpointId: 'T-3006', orderId: 'O-2002', personId: 'P-1002', deviceId: 'D-B1', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', campaignName: '再营销横幅', eventTime: '2026-10-31T07:30:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  // O-2003（D-C1，未授权跨设备）
  { touchpointId: 'T-3007', orderId: 'O-2003', personId: 'P-1003', deviceId: 'D-C1', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', campaignName: '再营销横幅', eventTime: '2026-10-27T20:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'impression', identityKind: 'email_hash', identityAuthorized: true },
  { touchpointId: 'T-3008', orderId: 'O-2003', personId: 'P-1003', deviceId: 'D-C1', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', campaignName: '秋季信息流', eventTime: '2026-10-30T11:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'email_hash', identityAuthorized: true },
  // O-2007（D-C2，同 email_hash 但不合并）
  { touchpointId: 'T-3009', orderId: 'O-2007', personId: 'P-1003', deviceId: 'D-C2', channelId: 'C-SEM', campaignId: 'CMP-BRAND', campaignName: '品牌词搜索', eventTime: '2026-10-31T09:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'email_hash', identityAuthorized: true },
  // 同一订单在 D-C1 上的触点：因 P-1003 无跨设备授权，引擎必须把它排除在 D-C2 旅程之外
  { touchpointId: 'T-3016', orderId: 'O-2007', personId: 'P-1003', deviceId: 'D-C1', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', campaignName: '再营销横幅', eventTime: '2026-10-30T18:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'impression', identityKind: 'email_hash', identityAuthorized: true },
  // O-2005 跨时区
  { touchpointId: 'T-3010', orderId: 'O-2005', personId: 'P-1005', deviceId: 'D-E1', channelId: 'C-DISPLAY', campaignId: 'CMP-GLOBAL', campaignName: '黑五全球场', eventTime: '2026-10-26T10:00:00Z', eventTimezone: 'America/Los_Angeles', eventType: 'impression', identityKind: 'login_id', identityAuthorized: true },
  { touchpointId: 'T-3011', orderId: 'O-2005', personId: 'P-1005', deviceId: 'D-E1', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', campaignName: '秋季信息流', eventTime: '2026-10-28T15:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
  { touchpointId: 'T-3012', orderId: 'O-2005', personId: 'P-1005', deviceId: 'D-E2', channelId: 'C-SEM', campaignId: 'CMP-BRAND', campaignName: '品牌词搜索', eventTime: '2026-10-30T08:15:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'crm_id', identityAuthorized: true },
  { touchpointId: 'T-3013', orderId: 'O-2005', personId: 'P-1005', deviceId: 'D-E2', channelId: 'C-EMAIL', campaignId: 'CMP-EDM', campaignName: '黑五预售邮件', eventTime: '2026-11-01T01:00:00Z', eventTimezone: 'America/Los_Angeles', eventType: 'click', identityKind: 'crm_id', identityAuthorized: true },
  // O-2004 未知设备（device_id 未授权，无人员标识）
  { touchpointId: 'T-3014', orderId: 'O-2004', personId: null, deviceId: 'D-X1', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', campaignName: '再营销横幅', eventTime: '2026-10-31T19:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'device_id', identityAuthorized: false },
  // O-2008 取消单
  { touchpointId: 'T-3015', orderId: 'O-2008', personId: 'P-1002', deviceId: 'D-B1', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', campaignName: '秋季信息流', eventTime: '2026-10-30T13:00:00Z', eventTimezone: 'Asia/Shanghai', eventType: 'click', identityKind: 'login_id', identityAuthorized: true },
];

export const refundsV1: RefundEvent[] = [
  { refundId: 'R-1005', orderId: 'O-2005', amount: 40000, refundTime: '2026-11-01T09:30:00Z', reason: '部分商品缺货退款', dataVersion: 'DV-2026.11.01' },
];

export const refundsV2: RefundEvent[] = [
  ...refundsV1,
  { refundId: 'R-1006', orderId: 'O-2002', amount: 20000, refundTime: '2026-11-04T08:15:00Z', reason: '价保补差退款（晚于广告回传与运行锁定）', dataVersion: 'DV-2026.11.05' },
];

/** 平台点击汇总：无订单级标识，只能留在平台汇总区 */
export const platformClicks: PlatformClickAggregate[] = [
  { aggId: 'A-01', platform: 'Google Ads', channelId: 'C-SEM', campaignId: 'CMP-BRAND', day: '2026-10-30', clicks: 12000, cost: 380000, hasOrderIdentifier: false, note: '平台仅回传日级汇总，无订单级标识' },
  { aggId: 'A-02', platform: 'Meta', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', day: '2026-10-30', clicks: 8400, cost: 260000, hasOrderIdentifier: false },
  { aggId: 'A-03', platform: 'The Trade Desk', channelId: 'C-DISPLAY', campaignId: 'CMP-BANNER', day: '2026-10-30', clicks: 3100, cost: 120000, hasOrderIdentifier: false },
  { aggId: 'A-04', platform: '自有营销云', channelId: 'C-EMAIL', campaignId: 'CMP-EDM', day: '2026-10-30', clicks: 900, cost: 5000, hasOrderIdentifier: false },
  { aggId: 'A-05', platform: 'Meta', channelId: 'C-SOCIAL', campaignId: 'CMP-FEED', day: '2026-11-01', clicks: 7600, cost: 235000, hasOrderIdentifier: false, note: 'O-2006 的点击只在此汇总中，无法关联到订单' },
];

function jobs(version: string, quarantine: boolean): IngestionJob[] {
  const base: IngestionJob[] = [
    { jobId: `J-${version}-01`, source: '订单中心 API', stream: 'orders', fetchedAt: '2026-11-01T00:05:00Z', recordCount: 9, checksum: 'sha256:9f1c…b2', status: 'success' },
    { jobId: `J-${version}-02`, source: '广告触点回传（订单级）', stream: 'order_touchpoints', fetchedAt: '2026-11-01T00:07:00Z', recordCount: 16, checksum: 'sha256:41ab…7d', status: 'success' },
    { jobId: `J-${version}-03`, source: '平台日级点击汇总', stream: 'platform_click_aggregate', fetchedAt: '2026-11-01T00:09:00Z', recordCount: 5, checksum: 'sha256:77d0…e8', status: 'success', note: '全部缺少订单级标识，路由到平台汇总区' },
    { jobId: `J-${version}-04`, source: '身份授权服务', stream: 'identity', fetchedAt: '2026-11-01T00:03:00Z', recordCount: 5, checksum: 'sha256:c0de…11', status: 'success' },
    { jobId: `J-${version}-05`, source: '退款流水', stream: 'refund', fetchedAt: '2026-11-01T00:11:00Z', recordCount: version === 'v1' ? 1 : 2, checksum: version === 'v1' ? 'sha256:55aa…03' : 'sha256:88bb…19', status: 'success' },
  ];
  if (quarantine) {
    base.push({
      jobId: `J-${version}-06`, source: '第三方 DSP 补传文件', stream: 'order_touchpoints',
      fetchedAt: '2026-11-01T00:13:00Z', recordCount: 0, checksum: 'sha256:err…00', status: 'quarantined',
      note: '缺少订单稳定标识与授权字段，整批隔离，不进入逐单分配',
    });
  }
  return base;
}

/** 净额管线：毛额 − 退款 = 净额（取消单净额为 0） */
export function buildOrderVersions(orderList: Order[], refunds: RefundEvent[], dataVersion: string): OrderVersion[] {
  return orderList.map((o) => {
    const related = refunds.filter((r) => r.orderId === o.orderId);
    const refundedAmount = related.reduce((s, r) => s + r.amount, 0);
    const netAmount = o.status === 'cancelled' ? 0 : Math.max(0, o.grossAmount - refundedAmount);
    const status =
      o.status === 'cancelled'
        ? 'cancelled'
        : refundedAmount >= o.grossAmount
          ? 'refunded_full'
          : refundedAmount > 0
            ? 'refunded_partial'
            : 'placed';
    return {
      orderId: o.orderId,
      dataVersion,
      grossAmount: o.grossAmount,
      refundedAmount,
      netAmount,
      status,
      refundIds: related.map((r) => r.refundId),
    };
  });
}

export const snapshots: DataSnapshot[] = [
  {
    snapshotId: 'DS-2026-11-01',
    dataVersion: 'DV-2026.11.01',
    ruleRevision: RULE_REVISION_V1,
    createdAt: '2026-11-01T00:20:00Z',
    ingestionJobs: jobs('v1', true),
    channels,
    identityLinks,
    orders,
    touchpoints,
    refunds: refundsV1,
    orderVersions: buildOrderVersions(orders, refundsV1, 'DV-2026.11.01'),
    platformClicks,
  },
  {
    snapshotId: 'DS-2026-11-05',
    dataVersion: 'DV-2026.11.05',
    ruleRevision: RULE_REVISION_V2,
    createdAt: '2026-11-05T01:00:00Z',
    ingestionJobs: jobs('v2', false),
    channels,
    identityLinks,
    orders,
    touchpoints,
    refunds: refundsV2,
    orderVersions: buildOrderVersions(orders, refundsV2, 'DV-2026.11.05'),
    platformClicks,
  },
];
