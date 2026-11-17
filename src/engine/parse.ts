// ============================================================
// 输入解析：CSV / JSON -> 领域行
// - 预览列含义、生成字段对应建议；对应关系可保存复用
// - 校验失败的原始行进 rejected，不进入后续对账，且保留原始内容
// ============================================================

import type {
  ActivityHourRow,
  BillRow,
  DatasetKind,
  FieldMapping,
  FxRateRow,
  RejectedRawRow,
} from '@/types/domain';
import { parseMinor, parseRateScaled, allocateByBps } from '@/lib/money';
import { ACCOUNTS, CURRENCIES, FX_RATE_SCALE } from '@/lib/constants';

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
}

/** 最小 RFC4180 风格 CSV 解析：支持引号、转义双引号、CRLF */
export function parseCsv(text: string): ParsedFile {
  const rows: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    rows.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRecord();
    } else if (ch === '\r') {
      // 吞掉 CR，LF 负责结束记录
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) pushRecord();
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const dataRows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });
  return { headers, rows: dataRows };
}

export function parseJsonFile(text: string): ParsedFile {
  const data = JSON.parse(text) as unknown;
  const arr = Array.isArray(data) ? data : [data];
  const rows = arr.map((item) => {
    const obj: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      obj[k] = v === null || v === undefined ? '' : String(v);
    }
    return obj;
  });
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return { headers, rows };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;

function validDay(v: string): boolean {
  if (!ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function getCell(raw: Record<string, string>, mapping: FieldMapping['columns'], key: string,
  constants?: Record<string, string>): string {
  const col = mapping[key];
  if (col && raw[col] !== undefined && raw[col] !== '') return raw[col];
  return constants?.[key] ?? '';
}

function currencyOf(code: string) {
  return CURRENCIES.find((c) => c.code === code);
}
function accountOf(id: string) {
  return ACCOUNTS.find((a) => a.accountId === id);
}

export interface BuildResult<T> {
  accepted: T[];
  rejected: RejectedRawRow[];
}

let seq = 0;
function rid(prefix: string, batchId: string, rowNumber: number): string {
  seq += 1;
  return `${prefix}-${batchId}-${rowNumber}-${seq.toString(36)}`;
}

function reject(rejected: RejectedRawRow[], rowNumber: number, raw: Record<string, string>, reason: string) {
  rejected.push({ rowNumber, raw: { ...raw }, reason });
}

/** 账单行：费用为正；贷项/退款行金额带负号；lineType 显式给出或由关键词推断 */
function normalizeLineType(text: string, amount: number): BillRow['lineType'] {
  const t = text.trim().toLowerCase();
  if (t.includes('credit') || t.includes('贷') || t.includes('退款') || t.includes('refund')) return 'credit';
  if (t.includes('correct') || t.includes('更正')) return 'correction';
  return amount < 0 ? 'credit' : 'charge';
}

export function buildBillRows(
  parsed: ParsedFile,
  batchId: string,
  mapping: FieldMapping['columns'],
  constants?: Record<string, string>,
): BuildResult<BillRow> {
  const accepted: BillRow[] = [];
  const rejected: RejectedRawRow[] = [];
  parsed.rows.forEach((raw, i) => {
    const rowNumber = i + 1;
    const cell = (key: string) => getCell(raw, mapping, key, constants);
    const accountId = cell('accountId');
    const currency = cell('currency');
    const billDay = cell('billDay');
    const sourceDocNo = cell('sourceDocNo');
    const amountText = cell('amount');
    const account = accountOf(accountId);
    if (!account) return reject(rejected, rowNumber, raw, '账户不存在或未在账户口径中登记');
    const spec = currencyOf(currency);
    if (!spec) return reject(rejected, rowNumber, raw, `未知币种 ${currency}（币种小数位由输入口径确定）`);
    if (account.currency !== currency) {
      return reject(rejected, rowNumber, raw, `账户 ${accountId} 固定币种 ${account.currency}，与行币种 ${currency} 不符（口径不同）`);
    }
    if (!validDay(billDay)) return reject(rejected, rowNumber, raw, '账单日不是合法 YYYY-MM-DD');
    if (!sourceDocNo) return reject(rejected, rowNumber, raw, '缺少平台来源编号');
    const amountMinor = parseMinor(amountText, spec.minorUnit);
    if (amountMinor === null) return reject(rejected, rowNumber, raw, `金额无法按 ${currency} 小数位 ${spec.minorUnit} 解析`);
    const revText = cell('revisionNo');
    const revisionNo = revText === '' ? 1 : Number(revText);
    if (!Number.isInteger(revisionNo) || revisionNo < 1) return reject(rejected, rowNumber, raw, '修订号必须为 >=1 的整数');
    const summary = cell('summary') || sourceDocNo;
    const lineType = normalizeLineType(cell('lineType'), amountMinor);
    const splits: BillRow['splits'] = [];
    const campaignCell = cell('campaignId');
    if (campaignCell) {
      // 一行可含多个活动拆分：分号/竖线分隔，金额、占比、核验标记按位对齐
      const campaignIds = campaignCell.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
      const amountCells = cell('splitAmount').split(/[;|]/).map((s) => s.trim());
      const shareCells = cell('shareBps').split(/[;|]/).map((s) => s.trim());
      const verifyCells = cell('verifiable').split(/[;|]/).map((s) => s.trim());
      const explicitAmounts = amountCells.filter((s) => s !== '').length > 0;
      const fallback = explicitAmounts
        ? null
        : (() => {
            const weights = shareCells.map((s) => (s === '' ? 0 : Number(s)));
            if (weights.some((w) => !Number.isFinite(w) || w < 0 || w > 10000)) return 'bad-weight';
            return allocateByBps(amountMinor, weights.length ? weights : campaignIds.map(() => Math.floor(10000 / campaignIds.length)));
          })();
      if (fallback === 'bad-weight') return reject(rejected, rowNumber, raw, '活动占比必须是 0..10000 基点');
      let splitSum = 0;
      campaignIds.forEach((cid, idx) => {
        const verifiable = ['1', 'true', 'yes', 'y', '是'].includes((verifyCells[idx] ?? verifyCells[0] ?? '').toLowerCase());
        const shareText = shareCells[idx] ?? '';
        const shareBps = shareText === '' ? null : Number(shareText);
        if (shareBps !== null && (!Number.isFinite(shareBps) || shareBps < 0 || shareBps > 10000)) {
          return reject(rejected, rowNumber, raw, '活动占比必须是 0..10000 基点');
        }
        const splitAmount = explicitAmounts
          ? parseMinor(amountCells[idx] ?? '', spec.minorUnit)
          : fallback![idx];
        if (splitAmount === null) return reject(rejected, rowNumber, raw, '活动拆分金额无法按币种小数位解析');
        splitSum += splitAmount;
        splits.push({ campaignId: cid, amountMinor: splitAmount, verifiable, shareBps });
      });
      if (rejected.some((x) => x.rowNumber === rowNumber)) return;
      if (explicitAmounts && splitSum !== amountMinor) {
        return reject(rejected, rowNumber, raw, `活动拆分金额合计 ${splitSum} 不等于行金额 ${amountMinor}，拒绝静默改数`);
      }
    }
    accepted.push({
      rowId: rid('BIL', batchId, rowNumber),
      batchId,
      period: billDay.slice(0, 7),
      sourceDocNo,
      revisionNo,
      accountId,
      currency,
      billDay,
      summary,
      lineType,
      amountMinor,
      linkedDocNo: cell('linkedDocNo') || undefined,
      splits,
      raw,
    });
  });
  return { accepted, rejected };
}

export function buildActivityRows(
  parsed: ParsedFile,
  batchId: string,
  mapping: FieldMapping['columns'],
  constants?: Record<string, string>,
): BuildResult<ActivityHourRow> {
  const accepted: ActivityHourRow[] = [];
  const rejected: RejectedRawRow[] = [];
  parsed.rows.forEach((raw, i) => {
    const rowNumber = i + 1;
    const cell = (key: string) => getCell(raw, mapping, key, constants);
    const accountId = cell('accountId');
    const currency = cell('currency');
    const day = cell('day');
    const hourStart = cell('hourStart');
    const hourEnd = cell('hourEnd');
    const campaignId = cell('campaignId');
    const placementKey = cell('placementKey');
    const account = accountOf(accountId);
    if (!account) return reject(rejected, rowNumber, raw, '账户不存在或未登记');
    const spec = currencyOf(currency);
    if (!spec) return reject(rejected, rowNumber, raw, `未知币种 ${currency}`);
    if (account.currency !== currency) return reject(rejected, rowNumber, raw, '活动记录币种与账户固定币种不符');
    if (!validDay(day)) return reject(rejected, rowNumber, raw, '投放日不是合法 YYYY-MM-DD');
    // 跨时区拆日的前提：来源包含可验证的明细时间
    if (!ISO_OFFSET.test(hourStart) || !ISO_OFFSET.test(hourEnd)) {
      return reject(rejected, rowNumber, raw, '小时起止时间必须是带时区偏移的 ISO-8601（可验证明细时间）');
    }
    if (Number.isNaN(new Date(hourStart).getTime()) || Number.isNaN(new Date(hourEnd).getTime())) {
      return reject(rejected, rowNumber, raw, '小时起止时间无法解析为真实时刻');
    }
    if (!campaignId) return reject(rejected, rowNumber, raw, '缺少活动标识');
    if (!placementKey) return reject(rejected, rowNumber, raw, '缺少投放位标识（无法识别日内活动迁移）');
    const spendMinor = parseMinor(cell('spend'), spec.minorUnit);
    if (spendMinor === null) return reject(rejected, rowNumber, raw, '消耗金额无法按币种小数位解析');
    accepted.push({
      rowId: rid('ACT', batchId, rowNumber),
      batchId,
      accountId,
      campaignId,
      campaignName: cell('campaignName') || campaignId,
      placementKey,
      day,
      hourStart,
      hourEnd,
      timezone: cell('timezone') || account.timezone,
      currency,
      spendMinor,
      raw,
    });
  });
  return { accepted, rejected };
}

export function buildFxRows(
  parsed: ParsedFile,
  batchId: string,
  mapping: FieldMapping['columns'],
  constants?: Record<string, string>,
): BuildResult<FxRateRow> {
  const accepted: FxRateRow[] = [];
  const rejected: RejectedRawRow[] = [];
  parsed.rows.forEach((raw, i) => {
    const rowNumber = i + 1;
    const cell = (key: string) => getCell(raw, mapping, key, constants);
    const fromCurrency = cell('fromCurrency');
    const toCurrency = cell('toCurrency');
    const serviceDay = cell('serviceDay');
    const rateText = cell('rate');
    const rateVersion = cell('rateVersion');
    if (!currencyOf(fromCurrency) || !currencyOf(toCurrency)) return reject(rejected, rowNumber, raw, '汇率币种未知');
    if (!validDay(serviceDay)) return reject(rejected, rowNumber, raw, '服务日不是合法 YYYY-MM-DD');
    if (parseRateScaled(rateText, FX_RATE_SCALE) === null) {
      return reject(rejected, rowNumber, raw, `汇率无法按输入精度 ${FX_RATE_SCALE} 位小数解析`);
    }
    if (!rateVersion) return reject(rejected, rowNumber, raw, '缺少汇率版本号');
    accepted.push({
      rowId: rid('FX', batchId, rowNumber),
      batchId,
      rateVersion,
      fromCurrency,
      toCurrency,
      serviceDay,
      rateText,
      appliedAt: cell('appliedAt') || new Date(0).toISOString().replace('1970-01-01', serviceDay),
    });
  });
  return { accepted, rejected };
}

/** 列含义预览：按别名模糊匹配标准字段，给出字段对应建议 */
export function suggestMapping(kind: DatasetKind, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of FIELD_CATALOG[kind]) {
    const hit = headers.find((h) => {
      const lower = h.toLowerCase();
      return field.aliases.some((a) => lower.includes(a.toLowerCase()));
    });
    if (hit) out[field.key] = hit;
  }
  return out;
}

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  aliases: string[];
  hint: string;
}

export const FIELD_CATALOG: Record<DatasetKind, FieldDef[]> = {
  bill: [
    { key: 'accountId', label: '账户编号', required: true, aliases: ['account', '账户', '账号'], hint: '必须匹配账户口径' },
    { key: 'currency', label: '币种', required: true, aliases: ['currency', '币种', 'ccy'], hint: '账户固定币种' },
    { key: 'billDay', label: '账单日', required: true, aliases: ['day', 'date', '日期', '账单日'], hint: 'YYYY-MM-DD，账户时区' },
    { key: 'sourceDocNo', label: '来源编号', required: true, aliases: ['doc', 'source', '编号', '单号', 'invoice'], hint: '平台单据号，参与重传/更正判定' },
    { key: 'revisionNo', label: '修订号', required: false, aliases: ['revision', 'rev', '修订'], hint: '整数，缺省为 1' },
    { key: 'summary', label: '行摘要', required: false, aliases: ['summary', 'memo', '摘要', '备注'], hint: '与账户/账期共同判重' },
    { key: 'lineType', label: '行类型', required: false, aliases: ['type', 'line', '类型'], hint: 'charge/credit/correction，可按金额符号推断' },
    { key: 'amount', label: '金额', required: true, aliases: ['amount', '金额', 'cost', 'spend'], hint: '贷项/退款为负数' },
    { key: 'campaignId', label: '活动标识（拆分）', required: false, aliases: ['campaign', '活动'], hint: '多个拆分用 ; 或 | 分隔' },
    { key: 'splitAmount', label: '拆分金额', required: false, aliases: ['splitamount', '拆分金额'], hint: '与活动按位对齐；缺省时按占比分配行金额' },
    { key: 'shareBps', label: '活动占比基点', required: false, aliases: ['share', 'bps', '占比'], hint: '0..10000，估算口径留痕' },
    { key: 'verifiable', label: '可核验标记', required: false, aliases: ['verifiable', '核验', '凭证'], hint: 'true/是 才允许确认活动级金额' },
    { key: 'linkedDocNo', label: '关联原单号', required: false, aliases: ['linked', '关联', '原单'], hint: '贷项/退款关联的原账单来源编号' },
  ],
  activity: [
    { key: 'accountId', label: '账户编号', required: true, aliases: ['account', '账户'], hint: '' },
    { key: 'campaignId', label: '活动标识', required: true, aliases: ['campaign', '活动'], hint: '' },
    { key: 'campaignName', label: '活动名称', required: false, aliases: ['campaignname', '活动名称', 'name'], hint: '' },
    { key: 'placementKey', label: '投放位标识', required: true, aliases: ['placement', 'slot', '投放位', '广告位'], hint: '同投放位当天换活动=日内迁移' },
    { key: 'day', label: '投放日', required: true, aliases: ['day', 'date', '日期'], hint: 'YYYY-MM-DD' },
    { key: 'hourStart', label: '小时起点', required: true, aliases: ['start', 'hourstart', '起点', '开始'], hint: '带偏移 ISO-8601' },
    { key: 'hourEnd', label: '小时终点', required: true, aliases: ['end', 'hourend', '终点', '结束'], hint: '带偏移 ISO-8601' },
    { key: 'timezone', label: '时区', required: false, aliases: ['timezone', 'tz', '时区'], hint: '缺省取账户时区' },
    { key: 'currency', label: '币种', required: true, aliases: ['currency', '币种'], hint: '' },
    { key: 'spend', label: '小时消耗', required: true, aliases: ['spend', 'cost', '消耗', '金额'], hint: '' },
  ],
  fx: [
    { key: 'rateVersion', label: '汇率版本', required: true, aliases: ['version', '版本'], hint: '' },
    { key: 'fromCurrency', label: '源币种', required: true, aliases: ['from', '源币种'], hint: '' },
    { key: 'toCurrency', label: '目标币种', required: true, aliases: ['to', '目标币种'], hint: '' },
    { key: 'serviceDay', label: '服务日', required: true, aliases: ['day', 'date', '服务日', '日期'], hint: 'YYYY-MM-DD' },
    { key: 'rate', label: '汇率', required: true, aliases: ['rate', '汇率', '价格'], hint: `最多 ${FX_RATE_SCALE} 位小数` },
    { key: 'appliedAt', label: '发布时间', required: false, aliases: ['applied', '发布', '时间'], hint: '' },
  ],
};
