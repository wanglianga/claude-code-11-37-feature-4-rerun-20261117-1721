// 测试辅助：与应用完全相同的解析管线，把示例文件文本转成领域行
import { buildActivityRows, buildBillRows, buildFxRows, parseCsv, parseJsonFile } from '@/engine/parse';
import { INITIAL_SAMPLE_FILES, SAMPLE_FILES, type SampleFile } from '@/data/sampleFiles';
import type { ActivityHourRow, BillRow, FxRateRow } from '@/types/domain';

let batchSeq = 0;
function batchId(kind: string): string {
  batchSeq += 1;
  return `BAT-TEST-${kind}-${batchSeq}`;
}

export function buildSample(sample: SampleFile): { billRows: BillRow[]; activityRows: ActivityHourRow[]; fxRows: FxRateRow[] } {
  const parsed = sample.format === 'csv' ? parseCsv(sample.text) : parseJsonFile(sample.text);
  const id = batchId(sample.kind);
  return {
    billRows: sample.kind === 'bill' ? buildBillRows(parsed, id, sample.mapping).accepted : [],
    activityRows: sample.kind === 'activity' ? buildActivityRows(parsed, id, sample.mapping).accepted : [],
    fxRows: sample.kind === 'fx' ? buildFxRows(parsed, id, sample.mapping).accepted : [],
  };
}

export function initialInputs() {
  const billRows: BillRow[] = [];
  const activityRows: ActivityHourRow[] = [];
  const fxRows: FxRateRow[] = [];
  for (const s of INITIAL_SAMPLE_FILES) {
    const r = buildSample(s);
    billRows.push(...r.billRows);
    activityRows.push(...r.activityRows);
    fxRows.push(...r.fxRows);
  }
  return { billRows, activityRows, fxRows };
}

export function followup(fileName: string) {
  const sample = SAMPLE_FILES.find((s) => s.fileName === fileName)!;
  return buildSample(sample);
}

export function makeBill(over: Partial<BillRow> & Pick<BillRow, 'accountId' | 'currency' | 'billDay' | 'sourceDocNo' | 'amountMinor'>): BillRow {
  const { rowId, batchId, period, sourceDocNo, revisionNo, summary, lineType, splits, raw, ...rest } = over;
  return {
    rowId: rowId ?? `BIL-${Math.random().toString(36).slice(2, 8)}`,
    batchId: batchId ?? 'BAT-X',
    period: period ?? over.billDay.slice(0, 7),
    sourceDocNo,
    revisionNo: revisionNo ?? 1,
    summary: summary ?? sourceDocNo,
    lineType: lineType ?? (over.amountMinor < 0 ? 'credit' : 'charge'),
    splits: splits ?? [],
    raw: raw ?? {},
    ...rest,
  };
}
