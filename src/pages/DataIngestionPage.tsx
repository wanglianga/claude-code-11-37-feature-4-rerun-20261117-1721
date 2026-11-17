import { useMemo, useRef, useState } from 'react';
import { Upload, Save, FileDown, AlertTriangle, CopySlash } from 'lucide-react';
import { useAppStore, type ImportOutcome } from '@/store/useAppStore';
import { ACCOUNTS, CURRENCIES } from '@/lib/constants';
import {
  FIELD_CATALOG,
  parseCsv,
  parseJsonFile,
  suggestMapping,
  type FieldDef,
} from '@/engine/parse';
import type { DatasetKind, ImportBatch } from '@/types/domain';
import { SAMPLE_FILES } from '@/data/sampleFiles';
import { Badge, EmptyState, KeyValue, Modal } from '@/components/ui';

const KIND_LABELS: Record<DatasetKind, string> = {
  bill: '平台账单',
  activity: '活动小时消耗',
  fx: '服务日汇率',
};

export default function DataIngestionPage() {
  const [kind, setKind] = useState<DatasetKind>('bill');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [constants, setConstants] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [detailBatch, setDetailBatch] = useState<ImportBatch | null>(null);
  const [mappingName, setMappingName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const { batches, importFile, saveMapping } = useAppStore();

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return format === 'csv' ? parseCsv(text) : parseJsonFile(text);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [text, format]);

  const loadText = (next: string, name: string, fmt: 'csv' | 'json', preset?: Record<string, string>) => {
    setText(next);
    setFileName(name);
    setFormat(fmt);
    setOutcome(null);
    // 等 headers 可用后再给建议
    try {
      const p = fmt === 'csv' ? parseCsv(next) : parseJsonFile(next);
      setColumns(preset ?? suggestMapping(kind, p.headers));
      setConstants({});
    } catch {
      setColumns({});
    }
  };

  const onUpload = async (file: File) => {
    const fmt = file.name.endsWith('.json') ? 'json' : 'csv';
    const content = await file.text();
    setFormat(fmt);
    loadText(content, file.name, fmt);
  };

  const switchKind = (k: DatasetKind) => {
    setKind(k);
    setText('');
    setOutcome(null);
    setColumns({});
    setConstants({});
    setFileName('');
  };

  const doImport = () => {
    if (!parsed || 'error' in parsed) return;
    const result = importFile({ kind, fileName: fileName || '手动粘贴.txt', format, text, columns, constants });
    setOutcome(result);
  };

  const doSaveMapping = () => {
    const name = mappingName.trim() || `${KIND_LABELS[kind]}字段对应-${new Date().toISOString().slice(0, 10)}`;
    saveMapping({ name, kind, columns, constants });
    setMappingName('');
    alert(`字段对应「${name}」已保存，后续同结构文件可直接复用`);
  };

  const kindBatches = batches.filter((b) => b.kind === kind);
  const fields = FIELD_CATALOG[kind];
  const previewRows = parsed && !('error' in parsed) ? parsed.rows.slice(0, 5) : [];

  return (
    <div>
      <div className="tabs">
        {(Object.keys(KIND_LABELS) as DatasetKind[]).map((k) => (
          <div key={k} className={`tab${kind === k ? ' active' : ''}`} onClick={() => switchKind(k)}>
            {KIND_LABELS[k]}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">
          ① 选择示例文件或上传 {KIND_LABELS[kind]}（CSV / JSON）
          <span className="hint">示例文件同样走解析管线，页面数值均来自本次输入</span>
        </div>
        <div className="pill-row" style={{ marginBottom: 12 }}>
          {SAMPLE_FILES.filter((f) => f.kind === kind).map((f) => (
            <button key={f.fileName} className="sm" title={f.description} onClick={() => loadText(f.text, f.fileName, f.format, f.mapping)}>
              <FileDown size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {f.fileName}
            </button>
          ))}
        </div>
        <div className="form-row">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          <button className="primary" onClick={() => fileRef.current?.click()}>
            <Upload size={14} style={{ verticalAlign: -2, marginRight: 4 }} />上传文件
          </button>
          <span className="muted small">或直接在下方粘贴文本；当前文件：{fileName || '未选择'}</span>
        </div>
        <textarea
          style={{ width: '100%', minHeight: 150, marginTop: 12, fontFamily: 'var(--mono)', fontSize: 12 }}
          placeholder="粘贴 CSV 或 JSON 内容…"
          value={text}
          onChange={(e) => loadText(e.target.value, fileName || '手动粘贴内容', format)}
        />
      </div>

      {parsed && 'error' in parsed && (
        <div className="notice error"><AlertTriangle size={15} />文件解析失败：{parsed.error}</div>
      )}

      {parsed && !('error' in parsed) && (
        <>
          <div className="card">
            <div className="card-title">
              ② 预览列含义并建立字段对应
              <span className="hint">识别到 {parsed.headers.length} 列 / {parsed.rows.length} 行；别名已自动匹配，可手动修正并保存</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>标准字段</th>
                  <th style={{ width: 70 }}>必填</th>
                  <th style={{ width: 240 }}>源列</th>
                  <th>缺列时常量值</th>
                  <th>口径说明</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f: FieldDef) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td>{f.required ? <Badge tone="red">必填</Badge> : <span className="muted">可选</span>}</td>
                    <td>
                      <select
                        style={{ width: '100%' }}
                        value={columns[f.key] ?? ''}
                        onChange={(e) => setColumns((c) => ({ ...c, [f.key]: e.target.value }))}
                      >
                        <option value="">— 不映射 —</option>
                        {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        style={{ width: 180 }}
                        placeholder="整文件固定值"
                        value={constants[f.key] ?? ''}
                        onChange={(e) => setConstants((c) => ({ ...c, [f.key]: e.target.value }))}
                      />
                    </td>
                    <td className="muted small">{f.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="form-row" style={{ marginTop: 12 }}>
              <input placeholder="字段对应方案名称（可选）" value={mappingName} onChange={(e) => setMappingName(e.target.value)} style={{ minWidth: 240 }} />
              <button onClick={doSaveMapping}><Save size={14} style={{ verticalAlign: -2, marginRight: 4 }} />保存字段对应</button>
              <button className="primary" onClick={doImport}>执行导入与受理判重</button>
            </div>
            {fields.filter((f) => f.required && !columns[f.key] && !constants[f.key]).length > 0 && (
              <div className="notice warn" style={{ marginTop: 10 }}>
                <AlertTriangle size={15} />
                仍有必填字段未映射：{fields.filter((f) => f.required && !columns[f.key] && !constants[f.key]).map((f) => f.label).join('、')}，相关行将被拒绝。
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">③ 数据预览（前 5 行原始值）</div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr>{parsed.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>{parsed.headers.map((h) => <td key={h} className="mono small">{r[h]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {outcome && (
        <div className={`notice ${outcome.rejectedCount > 0 ? 'warn' : 'success'}`}>
          <CopySlash size={15} />
          <div>
            导入完成：共 {outcome.totalRows} 行，受理 {outcome.acceptedCount} 行，拒绝 {outcome.rejectedCount} 行，
            重复件 {outcome.duplicateCount} 件，修订候选 {outcome.revisionCount} 件。
            {outcome.messages.map((m, i) => <div key={i} className="small">· {m}</div>)}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">④ 受理账批次（{kindBatches.length}）<span className="hint">保留原始行、账期与拒绝原因</span></div>
        {kindBatches.length === 0 ? <EmptyState text="暂无导入批次" /> : (
          <table>
            <thead>
              <tr><th>批次 / 文件</th><th>格式</th><th className="num">总行</th><th className="num">受理</th><th className="num">拒绝</th><th className="num">重复</th><th>导入时间</th><th></th></tr>
            </thead>
            <tbody>
              {[...kindBatches].reverse().map((b) => (
                <tr key={b.batchId}>
                  <td><div className="mono small">{b.fileName}</div><div className="muted small">{b.batchId}</div></td>
                  <td>{b.format.toUpperCase()}</td>
                  <td className="num">{b.totalRows}</td>
                  <td className="num">{b.billRows.length + b.activityRows.length + b.fxRows.length}</td>
                  <td className="num">{b.rejected.length > 0 ? <Badge tone="orange">{b.rejected.length}</Badge> : 0}</td>
                  <td className="num">{b.duplicates.length > 0 ? <Badge tone="purple">{b.duplicates.length}</Badge> : 0}</td>
                  <td className="small muted">{b.importedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td><button className="sm" onClick={() => setDetailBatch(b)}>查看原始行</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card tight">
        <div className="card-title">账户与币种口径（金额标准化固定使用）</div>
        <KeyValue rows={[
          ['账户', <span>{ACCOUNTS.map((a) => `${a.accountId}（${a.name} · ${a.currency} · ${a.timezone}）`).join('；')}</span>],
          ['币种小数位', <span>{CURRENCIES.map((c) => `${c.code}=${c.minorUnit} 位`).join('；')}（由输入口径登记，换算不写死）</span>],
        ]} />
      </div>

      <Modal open={!!detailBatch} title={`批次原始行 — ${detailBatch?.fileName ?? ''}`} onClose={() => setDetailBatch(null)} wide>
        {detailBatch && (
          <>
            <h4 style={{ marginBottom: 8 }}>被拒绝的原始行（{detailBatch.rejected.length}）</h4>
            {detailBatch.rejected.length === 0 ? <EmptyState text="无拒绝行" /> : (
              <table style={{ marginBottom: 16 }}>
                <thead><tr><th style={{ width: 70 }}>行号</th><th>拒绝原因</th><th>原始内容</th></tr></thead>
                <tbody>
                  {detailBatch.rejected.map((r, i) => (
                    <tr key={i}><td className="num">{r.rowNumber || '—'}</td><td className="small">{r.reason}</td><td className="mono small">{JSON.stringify(r.raw)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <h4 style={{ marginBottom: 8 }}>重复件留痕（{detailBatch.duplicates.length}，不二次入账）</h4>
            {detailBatch.duplicates.length === 0 ? <EmptyState text="无重复件" /> : (
              <table>
                <thead><tr><th>判重原因</th><th>原始内容</th></tr></thead>
                <tbody>
                  {detailBatch.duplicates.map((r, i) => (
                    <tr key={i}><td className="small">{r.reason}</td><td className="mono small">{JSON.stringify(r.raw)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
