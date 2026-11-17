// 报告/明细 CSV 导出：浏览器端下载，数值口径与页面完全一致
export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
  // 带 BOM 保证 Excel 正确识别中文
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
