import { useMemo, useState } from 'react';
import { PlayCircle, GitBranch, Eye, AlertOctagon, AlertTriangle } from 'lucide-react';
import { useAppStore, selectFxRows } from '@/store/useAppStore';
import { RUN_STATUS_LABELS, RUN_STATUS_COLORS } from '@/lib/constants';
import { buildBillRows, buildFxRows, parseCsv, parseJsonFile } from '@/engine/parse';
import { previewBillChange, previewFxRevision, previewMappingChange, type AffectedPreview } from '@/engine/versions';

type PreviewData = AffectedPreview & {
  reviewRequired?: Array<{ partition: PartitionKey; oldStandard: number; newStandard: number; diff: number }>;
  closedPartitions?: PartitionKey[];
};
import { deriveMappingIntervals, partitionKeyString } from '@/engine/reconcile';
import { FOLLOWUP_SAMPLE_FILES, type SampleFile } from '@/data/sampleFiles';
import type { PartitionKey, ReconcileRun, RunTrigger } from '@/types/domain';
import { Badge, Drawer, EmptyState, KeyValue, Modal } from '@/components/ui';

interface ScenarioAction {
  key: string;
  label: string;
  trigger: RunTrigger;
  sample: SampleFile;
  fxVersion?: string;
  description: string;
}

const SCENARIOS: ScenarioAction[] = [
  {
    key: 'reimport', label: '导入重复件批次并重算', trigger: 'reimport',
    sample: FOLLOWUP_SAMPLE_FILES[0],
    description: '同额同号重复件 + 换号重复候选：均不二次入账，行级比较标记重复候选',
  },
  {
    key: 'correction', label: '导入 JP 同号更正件并重算', trigger: 'correction',
    sample: FOLLOWUP_SAMPLE_FILES[1],
    description: 'B-JP-3001 修订号 2、金额改变：只重开 ACC-JP-03 / 2026-11-01，其他分区继承旧版本',
  },
  {
    key: 'credit', label: '补入迟到部分贷项并重算', trigger: 'late_credit',
    sample: FOLLOWUP_SAMPLE_FILES[2],
    description: '贷项关联原单 B-US-2002，作为后续调整；不减少其他活动的已确认费用',
  },
  {
    key: 'fx', label: '替换为汇率版本 B 并重算', trigger: 'fx_revision',
    sample: FOLLOWUP_SAMPLE_FILES[3], fxVersion: 'FX-2026-11B',
    description: '仅 USD 2026-11-02 服务日汇率变化：预览新旧标准金额差额并要求复核',
  },
];

export default function RunsPage() {
  const {
    runs, batches, fxVersion, importSample, setFxVersion, createRun, applyMappingFix,
  } = useAppStore();
  const latestRun = runs[runs.length - 1];
  const [pending, setPending] = useState<(ScenarioAction & { preview: PreviewData }) | null>(null);
  const [mappingPreview, setMappingPreview] = useState<AffectedPreview | null>(null);
  const [detailRun, setDetailRun] = useState<ReconcileRun | null>(null);

  const activityBatches = batches.filter((b) => b.kind === 'activity');

  const previewFor = (action: ScenarioAction): PreviewData => {
    const parsed = action.sample.format === 'csv'
      ? parseCsv(action.sample.text)
      : parseJsonFile(action.sample.text);
    if (!latestRun) return { partitions: [], sourceRowIds: [], reasons: ['将创建首个运行版本'] };
    if (action.trigger === 'fx_revision') {
      const built = buildFxRows(parsed, 'PREVIEW', action.sample.mapping);
      const nextRows = [...selectFxRows(batches), ...built.accepted];
      return previewFxRevision(latestRun, selectFxRows(batches), nextRows, action.fxVersion ?? fxVersion);
    }
    const built = buildBillRows(parsed, 'PREVIEW', action.sample.mapping);
    return previewBillChange(latestRun, built.accepted);
  };

  const confirmScenario = () => {
    if (!pending) return;
    importSample(pending.sample);
    if (pending.fxVersion) setFxVersion(pending.fxVersion);
    const run = createRun(pending.trigger, pending.description);
    setPending(null);
    setDetailRun(run);
  };

  const openMappingPreview = () => {
    if (!latestRun) return;
    const activityRows = activityBatches.flatMap((b) => b.activityRows);
    const nextIntervals = deriveMappingIntervals(activityRows);
    setMappingPreview(previewMappingChange(latestRun, nextIntervals, activityRows));
  };

  const confirmMappingFix = () => {
    if (!mappingPreview) return;
    const activityRows = activityBatches.flatMap((b) => b.activityRows);
    applyMappingFix(deriveMappingIntervals(activityRows));
    const run = createRun('mapping_fix', '活动映射更正：重开未结账分区，已付款分区转调整凭证');
    setMappingPreview(null);
    setDetailRun(run);
  };

  const stats = useMemo(() => {
    if (!latestRun) return null;
    return {
      partitions: latestRun.accountDays.length,
      blockers: latestRun.blockers.length,
      warnings: latestRun.warnings.length,
      comparisons: latestRun.comparisons.length,
    };
  }, [latestRun]);

  return (
    <div>
      <div className="grid cols-4">
        <div className="stat"><div className="label">当前汇率版本</div><div className="value" style={{ fontSize: 17 }}>{fxVersion}</div><div className="sub">服务日汇率，按账户币种逐日选取</div></div>
        <div className="stat"><div className="label">运行版本数</div><div className="value">{runs.length}</div><div className="sub">确认与调整均引用具体版本</div></div>
        <div className="stat"><div className="label">当前版本分区</div><div className="value">{stats?.partitions ?? '—'}</div><div className="sub">账户 × 账单日 × 币种</div></div>
        <div className={`stat${stats && stats.blockers > 0 ? ' alert' : ''}`}>
          <div className="label">阻断 / 警告</div>
          <div className="value">{stats?.blockers ?? '—'} / {stats?.warnings ?? '—'}</div>
          <div className="sub">有阻断的分区禁止标记已核清</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <PlayCircle size={16} /> 运行操作
          <span className="hint">任何输入变化都先预览受影响来源行与账户日，再产生新版本；已确认运行仍可打开原始明细</span>
        </div>
        {runs.length === 0 ? (
          <div className="notice info">
            <div>
              初始三文件（账单 / 活动小时 / 汇率）已随演示数据通过同一解析管线导入。
              <div style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => setDetailRun(createRun('initial', '首次核平运行'))}>
                  创建首个对账运行（V1）
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid cols-2">
            {SCENARIOS.map((a) => (
              <div key={a.key} className="card tight" style={{ marginBottom: 0 }}>
                <div style={{ fontWeight: 650, marginBottom: 4 }}>{a.label}</div>
                <div className="small muted" style={{ minHeight: 38 }}>{a.description}</div>
                <div className="small mono" style={{ color: 'var(--text-3)', margin: '6px 0' }}>{a.sample.fileName}</div>
                <button className="sm" onClick={() => setPending({ ...a, preview: previewFor(a) })}>
                  <Eye size={13} style={{ verticalAlign: -2, marginRight: 4 }} />预览影响并生成新版本
                </button>
              </div>
            ))}
            <div className="card tight" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 650, marginBottom: 4 }}>活动映射更正（重开未结账分区）</div>
              <div className="small muted" style={{ minHeight: 38 }}>
                修正投放位→活动映射区间；已结账/已付款分区不回改，改为调整凭证。日内迁移缺平台凭证时活动级仍保持待分配。
              </div>
              <button className="sm" onClick={openMappingPreview} disabled={!latestRun}>
                <GitBranch size={13} style={{ verticalAlign: -2, marginRight: 4 }} />预览映射更正影响
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">运行版本链</div>
        {runs.length === 0 ? <EmptyState text="尚未创建运行" /> : (
          <table>
            <thead>
              <tr><th>版本</th><th>触发原因</th><th>状态</th><th className="num">分区</th><th className="num">阻断</th><th className="num">警告</th><th>父版本</th><th>创建人/时间</th><th></th></tr>
            </thead>
            <tbody>
              {[...runs].reverse().map((r) => (
                <tr key={r.runId}>
                  <td><strong>V{r.version}</strong><div className="muted small mono">{r.runId}</div></td>
                  <td>{triggerLabel(r.trigger)}</td>
                  <td>
                    <Badge tone={toneOf(r.status)} dot>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: RUN_STATUS_COLORS[r.status] }} />
                      {RUN_STATUS_LABELS[r.status]}
                    </Badge>
                  </td>
                  <td className="num">{r.accountDays.length}</td>
                  <td className="num">{r.blockers.length > 0 ? <Badge tone="red">{r.blockers.length}</Badge> : 0}</td>
                  <td className="num">{r.warnings.length > 0 ? <Badge tone="orange">{r.warnings.length}</Badge> : 0}</td>
                  <td className="small">{r.parentRunId ? r.parentRunId.slice(0, 14) + '…' : '—'}</td>
                  <td className="small muted">{r.createdBy} · {r.createdAt.replace('T', ' ').slice(0, 19)}</td>
                  <td><button className="sm" onClick={() => setDetailRun(r)}>打开明细</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={!!pending} title={`影响预览 — ${pending?.label ?? ''}`} onClose={() => setPending(null)} wide
        footer={<>
          <button onClick={() => setPending(null)}>取消</button>
          <button className="primary" onClick={confirmScenario}>确认导入并生成新版本</button>
        </>}>
        {pending && <PreviewBody preview={pending.preview} />}
      </Modal>

      <Modal open={!!mappingPreview} title="映射更正影响预览" onClose={() => setMappingPreview(null)}
        footer={<>
          <button onClick={() => setMappingPreview(null)}>取消</button>
          <button className="primary" onClick={confirmMappingFix}>应用映射更正并生成新版本</button>
        </>}>
        {mappingPreview && <PreviewBody preview={mappingPreview} />}
      </Modal>

      <Drawer open={!!detailRun} title={`运行 V${detailRun?.version ?? ''} 明细`} onClose={() => setDetailRun(null)}>
        {detailRun && (
          <>
            <KeyValue rows={[
              ['运行编号', <span className="mono small">{detailRun.runId}</span>],
              ['触发原因', triggerLabel(detailRun.trigger)],
              ['汇率版本', detailRun.fxVersion],
              ['输入批次', <span className="small">{detailRun.inputBatchIds.join('、')}</span>],
              ['阻断项', detailRun.blockers.length ? <Badge tone="red">{detailRun.blockers.length}</Badge> : '无'],
              ['警告项', detailRun.warnings.length ? <Badge tone="orange">{detailRun.warnings.length}</Badge> : '无'],
            ]} />
            <div className="section-divider" />
            <h4 style={{ marginBottom: 8 }}>受影响/继承分区（{detailRun.accountDays.length}）</h4>
            <table>
              <thead><tr><th>账户</th><th>账单日</th><th>币种</th><th>来源</th><th>确认状态</th></tr></thead>
              <tbody>
                {detailRun.accountDays.map((d) => (
                  <tr key={partitionKeyString(d)}>
                    <td className="small">{d.accountId}</td><td className="mono small">{d.billDay}</td><td>{d.currency}</td>
                    <td>{d.carriedFromRunId ? <Badge tone="gray">继承旧版本</Badge> : <Badge tone="blue">本版重算</Badge>}</td>
                    <td className="small">
                      {d.accountConfirmed ? <Badge tone="green">账户已确认</Badge> : <Badge tone="gray">账户待确认</Badge>}{' '}
                      {d.campaignConfirmed ? <Badge tone="green">活动已确认</Badge> : <Badge tone="gray">活动待确认</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detailRun.blockers.length > 0 && (
              <>
                <div className="section-divider" />
                <h4 style={{ marginBottom: 8 }}><AlertOctagon size={14} style={{ verticalAlign: -2 }} color="var(--danger)" /> 阻断项（不平，禁止核清）</h4>
                {detailRun.blockers.map((b, i) => <div key={i} className="notice error"><AlertTriangle size={14} />{b}</div>)}
              </>
            )}
            {detailRun.warnings.length > 0 && (
              <>
                <div className="section-divider" />
                <h4 style={{ marginBottom: 8 }}><AlertTriangle size={14} style={{ verticalAlign: -2 }} color="var(--warning)" /> 软警告（不阻断账户级核平）</h4>
                {detailRun.warnings.map((w, i) => <div key={i} className="notice warn">{w}</div>)}
              </>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

function PreviewBody({ preview }: { preview: PreviewData }) {
  const review = preview.reviewRequired;
  return (
    <div>
      {preview.reasons.map((r, i) => <div key={i} className="notice info">{r}</div>)}
      <h4 style={{ margin: '10px 0 8px' }}>受影响账户日分区（{preview.partitions.length}）</h4>
      {preview.partitions.length === 0 ? <EmptyState text="无受影响分区" /> : (
        <table>
          <thead><tr><th>账户</th><th>账单日</th><th>币种</th></tr></thead>
          <tbody>
            {preview.partitions.map((p) => (
              <tr key={partitionKeyString(p)}><td className="small">{p.accountId}</td><td className="mono small">{p.billDay}</td><td>{p.currency}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 style={{ margin: '14px 0 8px' }}>受影响来源行（{preview.sourceRowIds.length}）</h4>
      <div className="mono small" style={{ maxHeight: 120, overflow: 'auto', background: 'var(--surface-2)', padding: 8, borderRadius: 8 }}>
        {preview.sourceRowIds.join('、') || '—'}
      </div>
      {review && review.length > 0 && (
        <>
          <h4 style={{ margin: '14px 0 8px' }}>汇率新旧差额复核（标准币分）</h4>
          <table>
            <thead><tr><th>分区</th><th className="num">旧标准金额</th><th className="num">新标准金额</th><th className="num">差额</th></tr></thead>
            <tbody>
              {review.map((x, i) => (
                <tr key={i}>
                  <td className="small">{x.partition.accountId} {x.partition.billDay}</td>
                  <td className="num">{x.oldStandard}</td><td className="num">{x.newStandard}</td>
                  <td className="num" style={{ color: x.diff === 0 ? 'var(--success)' : 'var(--danger)' }}>{x.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {'closedPartitions' in preview && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          已付款分区 {(preview.closedPartitions as PartitionKey[]).length} 个不会回改，将生成调整凭证。
        </div>
      )}
    </div>
  );
}

function triggerLabel(t: RunTrigger): string {
  const map: Record<RunTrigger, string> = {
    initial: '首次核平',
    reimport: '重复导入',
    mapping_fix: '映射更正',
    fx_revision: '汇率修订',
    late_credit: '迟到贷项',
    correction: '平台更正',
  };
  return map[t];
}

function toneOf(status: ReconcileRun['status']): string {
  switch (status) {
    case 'fully_confirmed': return 'green';
    case 'account_confirmed': return 'blue';
    case 'reopened': return 'orange';
    default: return 'gray';
  }
}
