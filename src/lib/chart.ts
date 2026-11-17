// 图表统一配色（品牌中性色板）
export const CHART_COLORS = ['#2f54eb', '#13a8a8', '#722ed1', '#fa8c16', '#52c41a', '#eb2f96', '#faad14', '#8c8c8c'];

export const CHART_TEXT = '#5b6675';
export const CHART_AXIS = '#e4e8ef';

export const baseTextStyle = { color: CHART_TEXT, fontSize: 12 };

export function barGrid() {
  return { left: 72, right: 24, top: 40, bottom: 40 };
}

export function tooltipMinor(code = '') {
  return {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    valueFormatter: (v: unknown) => `${Number(v).toLocaleString('en-US')}${code ? ` ${code}` : ''}（最小单位）`,
  };
}
