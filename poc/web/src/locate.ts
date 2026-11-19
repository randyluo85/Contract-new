/**
 * T3 候选生成与正向定位（ADR-0001/0002 的实现层）。
 *
 * 编号恢复/拆分产生的条款 content 带页码提示（Docling provenance 仅作候选），
 * 前端在 PDF 文字层上做两窗口搜索核验：
 *   前缀 60 字 + 尾缀 40 字，各在提示页内 search.findAll；
 *   唯一命中且 readText 比对一致 → 锚点（status=linked，自动核验通过）；
 *   多命中 → 待确认（歧义铁律：绝不自动升级）；无命中 → 未定位（无锚点）。
 * 锚点主键 = { page, charStart, charCount, exactText }（页内字符半开区间）。
 */

import type { SearchHit } from '@embedpdf/plugin-search/contract';

/** 调用方用真实 viewer capability 装配（结构签名宽松，PageRef 由调用侧持有）。 */
export interface ViewerCaps {
  findAll: (opts: { text: string; wholeWord?: boolean }) => Promise<readonly SearchHit[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: (r: { page: any; start: number; count: number }) => unknown;
  readText: () => Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reveal: (page: any, opts: any) => unknown;
}

export interface SearchHitLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any;
  pageIndex: number;
  start: number;
  count: number;
}

export interface AnchorDraft {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any; // PageRef
  pageIndex: number; // 显示序号（1 基页码）
  charStart: number;
  charCount: number;
  exactText: string;
  status: 'linked' | 'pending';
}

const SQUASH = (s: string) => (s || '').replace(/\s+/g, '');
const PREFIX_N = 60;
const SUFFIX_N = 40;

/** SearchHit 命中 → 锚点草稿（字段名映射 start/count → charStart/charCount）。 */
function toDraft(h: SearchHit & { exactText: string }): AnchorDraft {
  return {
    page: h.page,
    pageIndex: h.pageIndex,
    charStart: h.start,
    charCount: h.count,
    exactText: h.exactText,
    status: 'linked',
  };
}

/** 取条款正文的搜索窗口文本（前缀/尾缀）。 */
export function windowText(content: string, which: 'prefix' | 'suffix'): string {
  const t = SQUASH(content);
  if (!t) return '';
  return which === 'prefix' ? t.slice(0, PREFIX_N) : t.slice(-SUFFIX_N);
}

/**
 * 单窗口核验：在给定命中集合内，找出「命中即该窗口文本」的唯一命中。
 * 全部命中都调 readText 比对（search 的 fold 归一化跨行可命中，但需防同页重复文本）。
 */
export async function verifyWindow(
  caps: ViewerCaps,
  text: string,
  hits: readonly SearchHit[],
): Promise<{ unique: SearchHit & { exactText: string } } | 'ambiguous' | 'nomatch'> {
  if (!hits.length) return 'nomatch';
  const needle = SQUASH(text);
  const goods: (SearchHit & { exactText: string })[] = [];
  for (const h of hits) {
    caps.select({ page: h.page, start: h.start, count: h.count });
    let read = '';
    try {
      read = await caps.readText();
    } catch {
      continue; // 读失败不算命中也不算排除
    }
    if (SQUASH(read) === needle.slice(0, Math.min(needle.length, SQUASH(read).length)) && SQUASH(read)) {
      goods.push({ ...h, exactText: read });
    }
  }
  if (goods.length === 1) return { unique: goods[0] };
  if (goods.length === 0) return 'nomatch';
  return 'ambiguous';
}

/**
 * 条款 → 锚点候选（两窗口）。返回 null=未定位；'ambiguous'=待确认；锚点数组=可落。
 * 前缀窗口优先：前缀唯一即用前缀；前缀歧义时试尾缀；两窗口都歧义 → 待确认。
 */
export async function anchorsForClause(
  caps: ViewerCaps,
  content: string,
): Promise<AnchorDraft[] | 'ambiguous' | null> {
  const prefix = windowText(content, 'prefix');
  if (!prefix) return null;
  const hits = await caps.findAll({ text: prefix, wholeWord: false });
  const verdict = await verifyWindow(caps, prefix, hits);
  if (verdict === 'ambiguous') {
    const suffix = windowText(content, 'suffix');
    if (suffix && suffix !== prefix) {
      const sHits = await caps.findAll({ text: suffix, wholeWord: false });
      const sVerdict = await verifyWindow(caps, suffix, sHits);
      if (sVerdict !== 'ambiguous' && sVerdict !== 'nomatch') {
        return [toDraft(sVerdict.unique)];
      }
    }
    return 'ambiguous';
  }
  if (verdict === 'nomatch') return null;
  return [toDraft(verdict.unique)];
}
