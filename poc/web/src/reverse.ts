/**
 * T4 反向定位（Q5/Q16 定案：选区区间与锚点区间求交，重叠排序）。
 *
 * 触发：selection.onCommitted（仅用户手势结束触发；程序化选区不触发——研究笔记 A1）。
 * 载荷 range: TextRange（start/end 两端各 {page, index}，页内 0 基字符，半开区间）。
 * 跨页选区：按页拆成多段半开区间分别求交（Q17：锚点=单页区间，跨页即多锚点）。
 *
 * 归属规则（Q5）：重叠即候选，按重叠字符数排序：
 *  - 唯一候选且重叠占比高（≥30% 选区长度）→ 自动选中并展开
 *  - 多候选或占比低 → 列候选条款供用户确认（不静默选一个）
 *  - 无对应（页眉/封面）→ 空提示（正确行为，不算失败）
 */

export interface ReverseAnchor {
  clauseId: string;
  page: number;      // 0 基 pageIndex（与锚点库同基）
  charStart: number; // 页内 0 基字符
  charCount: number;
}

export interface SelectionSpan {
  page: number;      // 0 基 pageIndex
  start: number;     // 页内字符起点
  end: number;       // 页内字符终点（不含）
}

export interface ReverseCandidate {
  clauseId: string;
  overlap: number;    // 重叠字符数
  ratio: number;      // overlap / 选区总长
}

/** TextRange（start/end 两端 {page, index}，可能跨页）→ 逐页半开区间列表。 */
export function spansOfRange(range: {
  start: { page: number | { index?: number }; index?: number };
  end: { page: number | { index?: number }; index?: number };
}): SelectionSpan[] {
  const pageNum = (p: unknown): number =>
    typeof p === 'number' ? p : ((p as { index?: number })?.index ?? 0);
  const sPage = pageNum(range.start.page);
  const ePage = pageNum(range.end.page);
  const sIdx = range.start.index ?? 0;
  const eIdx = range.end.index ?? 0;
  const spans: SelectionSpan[] = [];
  if (sPage === ePage) {
    spans.push({ page: sPage, start: Math.min(sIdx, eIdx), end: Math.max(sIdx, eIdx) });
  } else {
    const lo = Math.min(sPage, ePage);
    const hi = Math.max(sPage, ePage);
    // 文档顺序：起端页取起端之后、终端页取终端之前、中间页全页（字符区间未知全页长——用交叠近似：首尾页用端点，中间页 span 为 [0, ∞) 表示「整页」）
    for (let p = lo; p <= hi; p++) {
      if (p === sPage) spans.push({ page: p, start: sIdx, end: Number.MAX_SAFE_INTEGER });
      else if (p === ePage) spans.push({ page: p, start: 0, end: eIdx });
      else spans.push({ page: p, start: 0, end: Number.MAX_SAFE_INTEGER });
    }
  }
  return spans;
}

/** 选区 span 与锚点区间的重叠字符数（单页对单页，区间半开）。 */
export function overlapOf(span: SelectionSpan, a: ReverseAnchor): number {
  if (span.page !== a.page) return 0;
  const lo = Math.max(span.start, a.charStart);
  const hi = Math.min(span.end, a.charStart + a.charCount);
  return Math.max(0, hi - lo);
}

/**
 * 反向求交：选区 spans × 全部锚点 → 候选（按重叠字符数排序）。
 * ratio = 该条款总重叠 / 选区总字符数（MAX_SAFE_INTEGER 段按保守 1 计入）。
 */
export function reverseLocate(
  spans: SelectionSpan[],
  anchors: ReverseAnchor[],
  minRatio = 0.3,
): { kind: 'unique'; clauseId: string } | { kind: 'ambiguous'; candidates: ReverseCandidate[] } | { kind: 'none' } {
  const spanLen = spans.reduce((n, s) => {
    const len = s.end === Number.MAX_SAFE_INTEGER ? 1 : s.end - s.start;
    return n + Math.max(0, len);
  }, 0);
  if (spanLen <= 0) return { kind: 'none' };
  const byClause = new Map<string, number>();
  for (const a of anchors) {
    if (a.charCount <= 0) continue; // 歧义占位锚点（T3 铁律）不参与求交
    for (const s of spans) {
      const ov = overlapOf(s, a);
      if (ov > 0) byClause.set(a.clauseId, (byClause.get(a.clauseId) ?? 0) + ov);
    }
  }
  if (byClause.size === 0) return { kind: 'none' };
  const candidates = [...byClause.entries()]
    .map(([clauseId, overlap]) => ({ clauseId, overlap, ratio: overlap / spanLen }))
    .sort((x, y) => y.overlap - x.overlap);
  const top = candidates[0];
  const strong = candidates.filter((c) => c.ratio >= minRatio);
  if (strong.length === 1) return { kind: 'unique', clauseId: strong[0].clauseId };
  // 唯一候选但占比低（选区跨出条款边界太多）→ 也列候选供确认
  return { kind: 'ambiguous', candidates };
}
