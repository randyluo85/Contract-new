/**
 * T3 候选生成与正向定位（ADR-0001/0002 的实现层）。
 *
 * 两窗口→多窗口演进（用户实测反馈）：
 * 1) 英文协议大面积未定位的根因：SQUASH 去空白对英文是致命的（EmbedPDF fold 只折叠
 *    空白为单空格、不删除），中文巧合可用、英文必失配。修正：needle 保留原文形态。
 * 2) 已关联锚点未覆盖整个条款：前缀 60 字只是窗口。改为滑窗切分（~60 字/窗，无空白
 *    重叠），每窗独立核验落锚点，整条款多锚点覆盖；点击定位用第一个锚点。
 * 歧义铁律不变：任一窗口多命中→该窗口停待确认（不自动升级）；全部窗口唯一命中→已关联。
 */

export interface ViewerCaps {
  findAll: (opts: { text: string; wholeWord?: boolean }) => Promise<readonly SearchHit[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: (r: { page: any; start: number; count: number }) => unknown;
  readText: () => Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reveal: (page: any, opts: any) => unknown;
}

import type { SearchHit } from '@embedpdf/plugin-search/contract';

export interface AnchorDraft {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any; // PageRef
  pageIndex: number; // 显示序号（0 基，与 SearchHit.pageIndex 同基）
  charStart: number;
  charCount: number;
  exactText: string;
  status: 'linked' | 'pending';
}

/** 条款正文 → 滑窗切分：每窗 ≤60 字（按空白边界不切断），覆盖整个条款。 */
export function windowTexts(content: string, windowN = 60, step = 55): string[] {
  const t = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= windowN) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += step) {
    let end = Math.min(t.length, i + windowN);
    if (end < t.length) {
      // 不切断词：往后挪到最近的空白
      const ws = t.indexOf(' ', end - 10);
      if (ws > 0 && ws < end + 10) end = ws;
    }
    const piece = t.slice(i, end).trim();
    if (piece.length >= 8) out.push(piece);
    if (end >= t.length) break;
  }
  return out;
}

/** 归一化比对（空白折叠为单空格，与 search fold 语义一致——不删空白！）。 */
const NORM = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

/**
 * 单窗口核验：命中集合中，读回文本与 needle 归一化一致者为命中；
 * 唯一 → {unique}；零 → 'nomatch'；多个 → 'ambiguous'。
 */
export async function verifyWindow(
  caps: ViewerCaps,
  text: string,
  hits: readonly SearchHit[],
): Promise<{ unique: SearchHit & { exactText: string } } | 'ambiguous' | 'nomatch'> {
  if (!hits.length) return 'nomatch';
  const needle = NORM(text);
  const goods: (SearchHit & { exactText: string })[] = [];
  for (const h of hits) {
    caps.select({ page: h.page, start: h.start, count: h.count });
    let read = '';
    try {
      read = await caps.readText();
    } catch {
      continue; // 读失败不算命中也不算排除
    }
    if (NORM(read) === needle) {
      goods.push({ ...h, exactText: read });
    }
  }
  if (goods.length === 1) return { unique: goods[0] };
  if (goods.length === 0) return 'nomatch';
  return 'ambiguous';
}

/**
 * 条款 → 多窗口锚点（覆盖全文）。
 * 返回 null=未定位（无任何窗口命中）；'ambiguous'=待确认（≥1 窗口歧义）；
 * 锚点数组=全部唯一命中窗口（整条款覆盖）。
 */
export async function anchorsForClause(
  caps: ViewerCaps,
  content: string,
): Promise<AnchorDraft[] | 'ambiguous' | null> {
  const windows = windowTexts(content);
  if (!windows.length) return null;
  const drafts: AnchorDraft[] = [];
  let ambiguous = false;
  let anyHit = false;
  for (const w of windows) {
    const hits = await caps.findAll({ text: w, wholeWord: false });
    const verdict = await verifyWindow(caps, w, hits);
    if (verdict === 'ambiguous') {
      ambiguous = true; // 该窗口歧义：整条款停待确认（铁律）
      continue;
    }
    if (verdict === 'nomatch') continue;
    anyHit = true;
    const h = verdict.unique;
    drafts.push({
      page: h.page,
      pageIndex: h.pageIndex,
      charStart: h.start,
      charCount: h.count,
      exactText: h.exactText,
      status: 'linked',
    });
  }
  if (drafts.length && !ambiguous) return drafts;         // 全部窗口唯一命中
  if (drafts.length && ambiguous) return 'ambiguous';     // 有命中但有歧义窗口 → 待确认
  if (ambiguous) return 'ambiguous';                      // 全歧义
  if (anyHit) return drafts;                              // 理论不可达（nomatch 落 drafts 空）
  return null;                                             // 全 nomatch → 未定位
}
