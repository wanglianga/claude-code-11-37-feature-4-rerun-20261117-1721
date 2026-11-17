import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Filter, SearchCheck } from 'lucide-react';
import { useAppStore, selectBillRows } from '@/store/useAppStore';
import {
  CAMPAIGN_STATUS_LABELS, LINE_STATUS_LABELS, RUN_STATUS_LABELS,
} from '@/lib/constants';
import { formatAmount, formatStandard, minorUnitOf } from '@/lib/format';
import { downloadCsv } from '@/lib/export';
import { RequestSeq, simulateAsync } from '@/services/api';
import { partitionKeyString } from '@/engine/reconcile';
import { checkInvariant } from '@/engine/versions';
import type { AccountDayResult, LineComparison } from '@/types/domain';
import type { EChartsOption } from 'echarts';
import EChart from '@/components/EChart';
import { Badge, Drawer, EmptyState, KeyValue, LineStatusBadge } from '@/components/ui';

export default function ReportPage() {
  const { runs, batches, confirmations } = useAppStore();
  const latestRun = runs[runs.length - 1];
  const [runId, setRunId] = useState(latestRun?.runId ?? '');
  const [accountFilter, setAccountFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [staleDropped, setStaleDropped] = useState(0);
  const [drawerDay, setDrawerDay] = useState<AccountDayResult | null>(null);
  const seqRef = useRef(new RequestSeq<{ account: string; status: string; runId: string }>());

  const run = runs.find((r) => r.runId === runId) ?? latestRun;
  const billRows = selectBillRows(batches);

  useEffect(() => {
    if (latestRun && !runId) setRunId(latestRun.runId);
  }, [latestRun, runId]);

  // 快速切换筛选时的竞态保护：旧响应不覆盖新条件
  useEffect(() => {
    let cancelled = false;
    seqRef.current
      .run(() => simulateAsync(() => ({ account: accountFilter, status: statusFilter, runId: run?.runId ?? '' }), 260))
      .then(({ accepted }) => {
        if (cancelled) return;
        if (!accepted) setStaleDropped((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [accountFilter, statusFilter, run?.runId]);

  const days = useMemo(() => {
    if (!run) return [];
    return run.accountDays.filter((d) =>
      (accountFilter === 'ALL' || d.accountId === accountFilter) &&
      (statusFilter === 'ALL' ||
        (statusFilter === 'balanced' && d.accountBalanced) ||
        (statusFilter === 'blocked' && !d.accountBalanced) ||
        (statusFilter === 'unassigned' && d.unassignedMinor !== 0)),
    );
  }, [run, accountFilter, statusFilter]);

  const chartOption = useMemo<EChartsOption>(() => {
    if (!run) return {};
    const accounts = [...new Set(run.accountDays.map((d) => d.accountId))];
    const daysAxis = [...new Set(run.accountDays.map((d) => d.billDay))].sort();
    return {
      color: ['#2f54eb', '#13a8a8', '#722ed1'],
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { fontSize: 12 } },
      grid: { left: 72, right: 24, top: 44, bottom: 40 },
      xAxis: { type: 'category', data: daysAxis, axisLabel: { color: '#5b6675' } },
      yAxis: { type: 'value', name: '标准金额（CNY 分）', axisLabel: { color: '#5b6675' }, splitLine: { lineStyle: { color: '#e4e8ef' } } },
      series: accounts.map((acc) => ({
        name: acc,
        type: 'bar' as const,
        data: daysAxis.map((day) =>
          run.accountDays.find((d) => d.accountId === acc && d.billDay === day)?.standardCorrectedMinor ?? 0,
        ),
      })),
    };
  }, [run]);

  if (!run) {
    return <div className="card"><EmptyState text="请先在「对账运行」页创建首个运行" /></div>;
  }

  const invariant = checkInvariant(run);
  const partitionComparisons = (d: AccountDayResult): LineComparison[] =>
    run.comparisons.filter((c) => c.accountId === d.accountId && c.billDay === d.billDay && c.currency === d.currency);
  const partitionCampaigns = (d: AccountDayResult) =>
    run.campaignLines.filter((l) => l.accountId === d.accountId && l.billDay === d.billDay && l.currency === d.currency);

  const exportAccountDays = () =>
    downloadCsv(
      `account-day-reconcile-V${run.version}.csv`,
      ['账户', '账单日', '币种', '账期', '原金额', '贷项', '更正后金额', '未归属余额', '标准金额(CNY分)', '逐行/汇总舍入差额', '汇率版本', '汇率', '账户核平', '已结账', '账户确认', '活动确认'],
      days.map((d) => [d.accountId, d.billDay, d.currency, d.period, d.billOriginalMinor, d.creditMinor, d.correctedMinor,
        d.unassignedMinor, d.standardCorrectedMinor, d.roundingDiffMinor, d.fxRateVersion, d.fxRateText,
        d.accountBalanced ? '是' : '否', d.closed ? '是' : '否', d.accountConfirmed ? '是' : '否', d.campaignConfirmed ? '是' : '否']),
    );

  const exportCampaigns = () =>
    downloadCsv(
      `campaign-reconciliation-V${run.version}.csv`,
      ['账户', '账单日', '币种', '活动', '原币金额', '标准金额(CNY分)', '状态', '口径', '估算', '来源行'],
      run.campaignLines.map((l) => [l.accountId, l.billDay, l.currency, `${l.campaignId} ${l.campaignName}`,
        l.amountMinor, l.standardMinor, CAMPAIGN_STATUS_LABELS[l.status], l.basis, l.estimated ? '是' : '否', l.sourceRowIds.join(';')]),
    );

  const exportComparisons = () =>
    downloadCsv(
      `line-comparisons-V${run.version}.csv`,
      ['账户', '账单日', '币种', '比较状态', '账单金额', '内部金额', '说明', '口径备注'],
      run.comparisons.map((c) => [c.accountId, c.billDay, c.currency, LINE_STATUS_LABELS[c.status],
        c.leftAmountMinor ?? '', c.rightAmountMinor ?? '', c.detail, c.caliberNote ?? '']),
    );

  return (
    <div>
      <div className="card tight">
        <div className="form-row">
          <label className="field">运行版本
            <select value={run.runId} onChange={(e) => setRunId(e.target.value)}>
              {[...runs].reverse().map((r) => <option key={r.runId} value={r.runId}>V{r.version} · {RUN_STATUS_LABELS[r.status]} · {r.runId.slice(-6)}</option>)}
            </select>
          </label>
          <label className="field"><Filter size={13} /> 账户
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
              <option value="ALL">全部账户</option>
              {[...new Set(run.accountDays.map((d) => d.accountId))].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="field">分区状态
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="ALL">全部</option>
              <option value="balanced">已核平</option>
              <option value="blocked">有阻断</option>
              <option value="unassigned">含未归属余额</option>
            </select>
          </label>
          <div style={{ flex: 1 }} />
          <button className="sm" onClick={exportAccountDays}><Download size={13} style={{ verticalAlign: -2, marginRight: 4 }} />导出账户日</button>
          <button className="sm" onClick={exportCampaigns}><Download size={13} style={{ verticalAlign: -2, marginRight: 4 }} />导出活动归属</button>
          <button className="sm" onClick={exportComparisons}><Download size={13} style={{ verticalAlign: -2, marginRight: 4 }} />导出行级比较</button>
        </div>
        {staleDropped > 0 && (
          <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
            竞态保护：已丢弃 {staleDropped} 个晚到的旧筛选响应，表格始终对应当前筛选条件。
          </div>
        )}
      </div>

      <div className="grid cols-4">
        <div className="stat"><div className="label">账户日分区</div><div className="value">{days.length}</div><div className="sub">账户 × 账单日 × 币种</div></div>
        <div className={`stat${run.blockers.length > 0 ? ' alert' : ''}`}><div className="label">阻断分区</div><div className="value">{new Set(run.blockers.map((b) => b.slice(1, b.indexOf(']')))).size}</div><div className="sub">不平禁止标记已核清</div></div>
        <div className="stat unknown"><div className="label">未归属余额（分区数）</div><div className="value">{run.accountDays.filter((d) => d.unassignedMinor !== 0).length}</div><div className="sub">留待核，不伪装逐活动实收</div></div>
        <div className={`stat${invariant ? '' : ' alert'}`}><div className="label">守恒不变量</div><div className="value" style={{ fontSize: 18 }}>{invariant ? '全部成立' : '被破坏'}</div><div className="sub">已确认+估算+未归属=更正后金额</div></div>
      </div>

      <div className="card">
        <div className="card-title">标准金额对比（服务日汇率换算，CNY 分；逐账户币种选取，无平均汇率）</div>
        <EChart option={chartOption} className="chart-box short" />
      </div>

      <div className="card">
        <div className="card-title">
          <SearchCheck size={16} /> 账户日核平表（正式核平粒度）
          <span className="hint">点击行下钻来源行、活动归属与五类行级比较；数值均来自当前运行输入</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>账户/账单日</th><th>币种</th><th className="num">原金额</th><th className="num">贷项</th>
                <th className="num">更正后</th><th className="num">未归属</th><th className="num">标准金额</th>
                <th className="num">舍入差额</th><th>核平</th><th>确认</th><th>结账</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={partitionKeyString(d)} className="clickable" onClick={() => setDrawerDay(d)}>
                  <td><div className="small">{d.accountId}</div><div className="mono small muted">{d.billDay}</div></td>
                  <td>{d.currency}</td>
                  <td className="num">{formatAmount(d.billOriginalMinor, d.currency)}</td>
                  <td className="num" style={{ color: d.creditMinor < 0 ? 'var(--danger)' : undefined }}>{d.creditMinor ? formatAmount(d.creditMinor, d.currency) : '—'}</td>
                  <td className="num"><strong>{formatAmount(d.correctedMinor, d.currency)}</strong></td>
                  <td className="num">{d.unassignedMinor ? <Badge tone="purple">{formatAmount(d.unassignedMinor, d.currency)}</Badge> : '—'}</td>
                  <td className="num">{formatStandard(d.standardCorrectedMinor)}</td>
                  <td className="num" title="逐行换算合计与汇总换算之差，单独列示不塞给活动">{d.roundingDiffMinor ? <Badge tone="orange">{d.roundingDiffMinor}</Badge> : '0'}</td>
                  <td>{d.accountBalanced ? <Badge tone="green">核平</Badge> : <Badge tone="red">阻断</Badge>}</td>
                  <td className="small">{d.accountConfirmed ? <Badge tone="green">账户</Badge> : <Badge tone="gray">待</Badge>} {d.campaignConfirmed ? <Badge tone="green">活动</Badge> : <Badge tone="gray">待</Badge>}</td>
                  <td>{d.closed ? <Badge tone="blue">已结账</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">行级比较（五类：已相等 / 来源缺失 / 重复候选 / 口径不同 / 真实金额差异）</div>
        <table>
          <thead><tr><th>账户日</th><th>币种</th><th>状态</th><th className="num">账单金额</th><th className="num">内部金额</th><th>说明</th></tr></thead>
          <tbody>
            {run.comparisons.map((c) => (
              <tr key={c.comparisonId}>
                <td className="small">{c.accountId}<div className="mono muted">{c.billDay}</div></td>
                <td>{c.currency}</td>
                <td><LineStatusBadge status={c.status} label={LINE_STATUS_LABELS[c.status]} /></td>
                <td className="num">{c.leftAmountMinor !== undefined ? formatAmount(c.leftAmountMinor, c.currency) : '—'}</td>
                <td className="num">{c.rightAmountMinor !== undefined ? formatAmount(c.rightAmountMinor, c.currency) : '—'}</td>
                <td className="small">{c.detail}{c.caliberNote && <div className="muted">{c.caliberNote}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={!!drawerDay} title={`分区下钻 — ${drawerDay ? partitionKeyString(drawerDay) : ''}`} onClose={() => setDrawerDay(null)}>
        {drawerDay && (
          <>
            <KeyValue rows={[
              ['汇率版本', <span className="mono small">{drawerDay.fxRateVersion}（{drawerDay.fxRateText}）</span>],
              ['更正后金额', formatAmount(drawerDay.correctedMinor, drawerDay.currency)],
              ['标准金额', `${formatStandard(drawerDay.standardCorrectedMinor)}（舍入差额 ${drawerDay.roundingDiffMinor} 分单独列示）`],
              ['未归属余额', formatAmount(drawerDay.unassignedMinor, drawerDay.currency)],
              ['守恒', invariant ? '已确认+估算+未归属 = 更正后金额 ✓' : '不变量被破坏 ✗'],
              ['来源行', <span className="mono small">{drawerDay.sourceRowIds.join('、')}</span>],
            ]} />

            <div className="section-divider" />
            <h4 style={{ marginBottom: 8 }}>活动归属（{partitionCampaigns(drawerDay).length}）</h4>
            {partitionCampaigns(drawerDay).length === 0 ? <EmptyState text="平台未提供活动拆分，余额全部留待核" /> : (
              <table>
                <thead><tr><th>活动</th><th className="num">原币</th><th className="num">标准</th><th>状态/口径</th></tr></thead>
                <tbody>
                  {partitionCampaigns(drawerDay).map((l) => (
                    <tr key={`${l.campaignId}-${l.sourceRowIds.join()}`}>
                      <td className="small">{l.campaignId}<div className="muted">{l.campaignName}</div></td>
                      <td className="num">{formatAmount(l.amountMinor, l.currency)}</td>
                      <td className="num">{formatStandard(l.standardMinor)}</td>
                      <td>
                        <Badge tone={l.status === 'confirmed' ? 'green' : l.status === 'estimated' ? 'orange' : 'purple'}>
                          {CAMPAIGN_STATUS_LABELS[l.status]}
                        </Badge>
                        <div className="muted small">{l.basis}{l.estimated ? '（平台消耗占比分配，整数尾差由末行承接）' : ''}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="section-divider" />
            <h4 style={{ marginBottom: 8 }}>行级比较</h4>
            {partitionComparisons(drawerDay).map((c) => (
              <div key={c.comparisonId} className="notice info" style={{ marginBottom: 8 }}>
                <LineStatusBadge status={c.status} label={LINE_STATUS_LABELS[c.status]} />
                <span className="small" style={{ marginLeft: 8 }}>{c.detail}</span>
              </div>
            ))}

            <div className="section-divider" />
            <h4 style={{ marginBottom: 8 }}>可追溯来源账单行（原始行 + 换算版本）</h4>
            <table>
              <thead><tr><th>来源编号</th><th>修订</th><th>类型</th><th className="num">金额</th><th>摘要</th></tr></thead>
              <tbody>
                {billRows.filter((r) => drawerDay.sourceRowIds.includes(r.rowId)).map((r) => (
                  <tr key={r.rowId}>
                    <td className="mono small">{r.sourceDocNo}{r.linkedDocNo && <div className="muted">关联原单 {r.linkedDocNo}</div>}</td>
                    <td className="num">v{r.revisionNo}</td><td>{r.lineType}</td>
                    <td className="num">{formatAmount(r.amountMinor, r.currency)}</td><td className="small muted">{r.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="section-divider" />
            <h4 style={{ marginBottom: 8 }}>本分区财务确认记录（{confirmations.filter((c) => partitionKeyString(c.partition) === partitionKeyString(drawerDay)).length}）</h4>
            {confirmations.filter((c) => partitionKeyString(c.partition) === partitionKeyString(drawerDay)).map((c) => (
              <div key={c.confirmationId} className="small" style={{ marginBottom: 6 }}>
                <Badge tone={c.status === 'confirmed' ? 'green' : 'orange'}>{c.level === 'account' ? '账户总额确认' : '活动归属确认'}</Badge>
                <span style={{ marginLeft: 8 }}>{c.confirmedBy} · {c.confirmedAt.replace('T', ' ').slice(0, 19)}</span>
                {c.note && <div className="muted">{c.note}（旧差 {c.oldDiffMinor} / 新差 {c.newDiffMinor}）</div>}
              </div>
            ))}
            <div className="muted small" style={{ marginTop: 10 }}>
              币种小数位：{minorUnitOf(drawerDay.currency)} 位（输入口径）；本页只核验费用数据，不执行支付、开票或记账。
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
}
