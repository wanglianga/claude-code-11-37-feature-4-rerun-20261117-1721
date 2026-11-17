import { useState } from 'react';
import { ReceiptText, BadgeCheck, Lock, ShieldAlert } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { CAMPAIGN_STATUS_LABELS } from '@/lib/constants';
import { formatAmount, formatStandard } from '@/lib/format';
import { partitionKeyString } from '@/engine/reconcile';
import type { AccountDayResult, AdjustmentVoucher, PartitionKey } from '@/types/domain';
import { Badge, EmptyState, KeyValue, Modal } from '@/components/ui';

const ADJUSTMENT_LABELS: Record<AdjustmentVoucher['kind'], string> = {
  late_credit: '迟到贷项/部分退款',
  bill_correction: '平台账单更正',
  mapping_revision: '活动映射更正',
  fx_revision: '汇率修订',
};

export default function AdjustPage() {
  const {
    runs, adjustments, confirmations, confirm, closePartition, currentUserId,
  } = useAppStore();
  const run = runs[runs.length - 1];
  const [target, setTarget] = useState<{ day: AccountDayResult; level: 'account' | 'campaign'; campaignId?: string } | null>(null);
  const [oldDiff, setOldDiff] = useState('0');
  const [newDiff, setNewDiff] = useState('0');
  const [feedback, setFeedback] = useState('');

  if (!run) {
    return <div className="card"><EmptyState text="请先在「对账运行」页创建首个运行" /></div>;
  }

  const blockedKeys = new Set(run.blockers.map((b) => b.slice(1, b.indexOf(']'))));

  const doConfirm = () => {
    if (!target) return;
    const result = confirm({
      level: target.level,
      partition: { accountId: target.day.accountId, billDay: target.day.billDay, currency: target.day.currency } satisfies PartitionKey,
      campaignId: target.campaignId,
      fxReview: { oldDiffMinor: Number(oldDiff) || 0, newDiffMinor: Number(newDiff) || 0 },
    });
    setFeedback(result.message);
    if (result.ok) setTarget(null);
  };

  return (
    <div>
      <div className="grid cols-3">
        <div className="stat"><div className="label">调整凭证</div><div className="value">{adjustments.length}</div><div className="sub">关联原账单行的后续调整</div></div>
        <div className="stat"><div className="label">确认记录</div><div className="value">{confirmations.filter((c) => c.runId === run.runId).length}</div><div className="sub">本版本 V{run.version}</div></div>
        <div className={`stat${run.blockers.length ? ' alert' : ''}`}>
          <div className="label">待复核 / 阻断</div>
          <div className="value">
            {confirmations.filter((c) => c.status === 'requires_rereview').length} / {run.blockers.length}
          </div>
          <div className="sub">不平分区禁止标记已核清</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <BadgeCheck size={16} /> 分级财务确认（账户总额与活动归属相互独立）
          <span className="hint">当前操作人 {currentUserId}；映射缺口不会卡住账户级核平</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>账户日分区</th><th>币种</th><th className="num">更正后金额</th><th className="num">未归属</th>
              <th>核平</th><th>账户确认</th><th>活动确认</th><th>结账</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {run.accountDays.map((d) => {
              const key = partitionKeyString(d);
              const blocked = blockedKeys.has(key);
              return (
                <tr key={key}>
                  <td className="small">{d.accountId}<div className="mono muted">{d.billDay}</div></td>
                  <td>{d.currency}</td>
                  <td className="num">{formatAmount(d.correctedMinor, d.currency)}</td>
                  <td className="num">{d.unassignedMinor ? formatAmount(d.unassignedMinor, d.currency) : '—'}</td>
                  <td>{d.accountBalanced ? <Badge tone="green">核平</Badge> : <Badge tone="red">阻断</Badge>}</td>
                  <td>{d.accountConfirmed ? <Badge tone="green">已确认</Badge> : <Badge tone="gray">待确认</Badge>}</td>
                  <td>{d.campaignConfirmed ? <Badge tone="green">已确认</Badge> : <Badge tone="gray">待确认</Badge>}</td>
                  <td>{d.closed ? <Badge tone="blue">已结账</Badge> : '—'}</td>
                  <td>
                    <div className="pill-row">
                      <button
                        className="sm"
                        disabled={blocked || d.accountConfirmed}
                        title={blocked ? run.blockers.find((b) => b.startsWith(`[${key}]`)) : '账户级核平可独立确认'}
                        onClick={() => { setFeedback(''); setTarget({ day: d, level: 'account' }); setOldDiff('0'); setNewDiff('0'); }}
                      >确认账户总额</button>
                      <button
                        className="sm"
                        disabled={blocked || d.closed}
                        onClick={() => {
                          const r = closePartition({ accountId: d.accountId, billDay: d.billDay, currency: d.currency });
                          setFeedback(r.message);
                        }}
                      ><Lock size={12} style={{ verticalAlign: -1 }} /> 结账</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title">活动级确认（待分配行不可确认；估算行需显式接受偏差）</div>
        <table>
          <thead><tr><th>分区</th><th>活动</th><th className="num">原币金额</th><th className="num">标准金额</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {run.campaignLines.map((l) => {
              const day = run.accountDays.find((d) => partitionKeyString(d) === partitionKeyString(l));
              const blocked = day ? blockedKeys.has(partitionKeyString(day)) : true;
              const done = confirmations.some(
                (c) => c.runId === run.runId && c.level === 'campaign' &&
                  partitionKeyString(c.partition) === partitionKeyString(l) && c.campaignId === l.campaignId,
              );
              return (
                <tr key={`${partitionKeyString(l)}-${l.campaignId}`}>
                  <td className="small">{l.accountId}<div className="mono muted">{l.billDay}</div></td>
                  <td className="small">{l.campaignId}<div className="muted">{l.campaignName}</div></td>
                  <td className="num">{formatAmount(l.amountMinor, l.currency)}</td>
                  <td className="num">{formatStandard(l.standardMinor)}</td>
                  <td><Badge tone={l.status === 'confirmed' ? 'green' : l.status === 'estimated' ? 'orange' : 'purple'}>{CAMPAIGN_STATUS_LABELS[l.status]}</Badge></td>
                  <td>
                    <button
                      className="sm"
                      disabled={blocked || done || l.status === 'pending_allocation'}
                      title={l.status === 'pending_allocation' ? '平台凭证不可拆/日内迁移，活动级待分配，不能确认' : done ? '本版本已确认' : ''}
                      onClick={() => day && setTarget({ day, level: 'campaign', campaignId: l.campaignId })}
                    >{done ? '已确认' : '确认活动归属'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title"><ReceiptText size={16} /> 调整凭证（迟到贷项 / 更正 / 映射 / 汇率）</div>
        {adjustments.length === 0 ? <EmptyState text="暂无调整凭证；对已结账分区的后续更正会自动生成凭证而不回改旧分区" /> : (
          <table>
            <thead>
              <tr><th>凭证</th><th>类型</th><th>账户日</th><th className="num">原币金额</th><th className="num">标准金额</th><th>关联原账单行</th><th>运行版本</th><th>说明</th></tr>
            </thead>
            <tbody>
              {[...adjustments].reverse().map((v) => (
                <tr key={v.voucherId}>
                  <td className="mono small">{v.voucherId}</td>
                  <td><Badge tone="orange">{ADJUSTMENT_LABELS[v.kind]}</Badge></td>
                  <td className="small">{v.accountId}<div className="mono muted">{v.billDay} · {v.currency}</div></td>
                  <td className="num" style={{ color: v.amountMinor < 0 ? 'var(--danger)' : undefined }}>{formatAmount(v.amountMinor, v.currency)}</td>
                  <td className="num">{formatStandard(v.standardMinor)}</td>
                  <td className="mono small" style={{ maxWidth: 220, wordBreak: 'break-all' }}>{v.linkedBillRowIds.join('、')}</td>
                  <td className="small">{v.runId.slice(-8)}</td>
                  <td className="small muted">{v.note}{v.postedToClosedPartition && <div><Badge tone="blue">已结账分区·只调凭证</Badge></div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title"><ShieldAlert size={16} /> 确认与复核留痕</div>
        {confirmations.length === 0 ? <EmptyState text="暂无确认记录" /> : (
          <table>
            <thead><tr><th>运行</th><th>层级</th><th>分区/活动</th><th>确认人</th><th>时间</th><th>状态</th><th>并发差额</th></tr></thead>
            <tbody>
              {[...confirmations].reverse().map((c) => (
                <tr key={c.confirmationId}>
                  <td className="small">{c.runId.slice(-8)}</td>
                  <td>{c.level === 'account' ? '账户总额' : '活动归属'}</td>
                  <td className="small">{partitionKeyString(c.partition)}{c.campaignId ? ` · ${c.campaignId}` : ''}</td>
                  <td>{c.confirmedBy}</td>
                  <td className="small muted">{c.confirmedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td>{c.status === 'confirmed' ? <Badge tone="green">已确认</Badge> : <Badge tone="orange">待复核</Badge>}</td>
                  <td className="num small">{c.oldDiffMinor !== undefined ? `旧 ${c.oldDiffMinor} / 新 ${c.newDiffMinor}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {feedback && <div className="notice info">{feedback}</div>}

      <Modal
        open={!!target}
        title={target?.level === 'account' ? '确认账户总额' : `确认活动归属 · ${target?.campaignId ?? ''}`}
        onClose={() => setTarget(null)}
        footer={<>
          <button onClick={() => setTarget(null)}>取消</button>
          <button className="primary" onClick={doConfirm}>提交确认</button>
        </>}
      >
        {target && (
          <>
            <KeyValue rows={[
              ['分区', partitionKeyString(target.day)],
              ['口径', target.level === 'account'
                ? '账户/日期/币种原生粒度，证据最直接'
                : '可核验拆分可直接确认；估算行确认即表示接受费率/时段偏差；待分配行禁止确认'],
              ['更正后金额', formatAmount(target.day.correctedMinor, target.day.currency)],
              ['未归属余额', formatAmount(target.day.unassignedMinor, target.day.currency)],
            ]} />
            <div className="section-divider" />
            <div className="small muted" style={{ marginBottom: 8 }}>
              汇率修订与确认并发复核（模拟）：若新旧差额不一致，确认将转「待复核」，复核通过前不得结账。
            </div>
            <div className="form-row">
              <label className="field">旧差额（标准币分）<input value={oldDiff} onChange={(e) => setOldDiff(e.target.value)} /></label>
              <label className="field">新差额（标准币分）<input value={newDiff} onChange={(e) => setNewDiff(e.target.value)} /></label>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
