// ============================================================
// 账单受理：重复导入判定
// 规则（需求口径）：
// - 按 账户 + 账期 + 行摘要 去重；
// - 同来源编号、同修订号、同金额 => 同额重复件，丢弃但留痕；
// - 同来源编号金额改变（或修订号更高）=> 修订候选，
//   既不能当重复件丢弃，也不能直接与旧金额相加；
// - 不同来源编号但业务键与金额完全相同 => 重复候选（疑似换号重传）。
// ============================================================

import type { BillRow } from '@/types/domain';

export type IngestDecisionKind = 'accepted' | 'duplicate' | 'revision_candidate';

export interface IngestDecision {
  kind: IngestDecisionKind;
  incoming: BillRow;
  /** 命中的既有受理行（重复/修订场景） */
  existing?: BillRow;
  reason: string;
}

export function businessKey(row: Pick<BillRow, 'accountId' | 'period' | 'summary'>): string {
  return `${row.accountId}|${row.period}|${row.summary.trim().toLowerCase()}`;
}

/**
 * 对一批新账单行逐个做受理判定。existing 为此前已受理（含被替代留痕）的账单行。
 * 纯函数：不修改输入，返回与 incoming 等长、等序的判定列表。
 */
export function decideIngestion(existing: BillRow[], incoming: BillRow[]): IngestDecision[] {
  return incoming.map((row) => {
    const key = businessKey(row);
    const sameKey = existing.filter((e) => businessKey(e) === key);
    const sameDoc = sameKey.find((e) => e.sourceDocNo === row.sourceDocNo);
    if (sameDoc) {
      const amountChanged = sameDoc.amountMinor !== row.amountMinor;
      const revisionAdvanced = row.revisionNo > sameDoc.revisionNo;
      if (!amountChanged && !revisionAdvanced) {
        return {
          kind: 'duplicate',
          incoming: row,
          existing: sameDoc,
          reason: `同额重复件：账户/账期/摘要/来源编号 ${row.sourceDocNo} 与已受理行 ${sameDoc.rowId} 完全一致，不重复入账`,
        };
      }
      return {
        kind: 'revision_candidate',
        incoming: row,
        existing: sameDoc,
        reason: amountChanged
          ? `同编号 ${row.sourceDocNo} 金额由 ${sameDoc.amountMinor} 变为 ${row.amountMinor}，形成修订候选（修订号 ${sameDoc.revisionNo}→${row.revisionNo}）`
          : `同编号 ${row.sourceDocNo} 修订号 ${sameDoc.revisionNo}→${row.revisionNo}，形成修订候选`,
      };
    }
    const sameAmountOtherDoc = sameKey.find((e) => e.amountMinor === row.amountMinor);
    if (sameAmountOtherDoc) {
      return {
        kind: 'duplicate',
        incoming: row,
        existing: sameAmountOtherDoc,
        reason: `重复候选：业务键（账户/账期/摘要）与金额同已受理行 ${sameAmountOtherDoc.rowId} 一致，仅来源编号不同，疑似换号重传`,
      };
    }
    return { kind: 'accepted', incoming: row, reason: '新账单行，受理入账' };
  });
}

/**
 * 应用修订链：同一来源编号只保留最高修订号作为生效行；
 * 被替代的旧行保留在受理账中用于血缘（supersededRowIds 留痕）。
 */
export function effectiveBillRows(allRows: BillRow[]): { effective: BillRow[]; superseded: BillRow[] } {
  const byDoc = new Map<string, BillRow[]>();
  for (const row of allRows) {
    const list = byDoc.get(row.sourceDocNo) ?? [];
    list.push(row);
    byDoc.set(row.sourceDocNo, list);
  }
  const effective: BillRow[] = [];
  const superseded: BillRow[] = [];
  for (const list of byDoc.values()) {
    const sorted = [...list].sort((a, b) => b.revisionNo - a.revisionNo || a.rowId.localeCompare(b.rowId));
    effective.push(sorted[0]);
    superseded.push(...sorted.slice(1));
  }
  effective.sort((a, b) => a.rowId.localeCompare(b.rowId));
  return { effective, superseded };
}
