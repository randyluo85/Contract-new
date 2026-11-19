/** 反向定位纯函数测试（Node 直跑：npx tsx 或 vitest 缺席时用 node --experimental-strip-types）。 */
import { reverseLocate, overlapOf, spansOfRange } from './reverse.ts';

const A = (clauseId: string, page: number, s: number, n: number) => ({ clauseId, page, charStart: s, charCount: n });

let fails = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) { fails++; console.log('FAIL:', name); }
};

// 1) 单页选区完全落入某锚点 → unique
const anchors1 = [A('c1', 0, 0, 100), A('c2', 1, 0, 50)];
let r = reverseLocate([{ page: 0, start: 10, end: 60 }], anchors1);
check('unique-in-anchor', r.kind === 'unique' && (r as { clauseId: string }).clauseId === 'c1');

// 2) 跨两锚点（同条款多窗）→ 合并重叠仍 unique
const anchors2 = [A('c1', 0, 0, 50), A('c1', 0, 60, 50), A('c2', 1, 0, 50)];
r = reverseLocate([{ page: 0, start: 20, end: 80 }], anchors2);
check('unique-multi-window', r.kind === 'unique' && (r as { clauseId: string }).clauseId === 'c1');

// 3) 两条款重叠 → ambiguous（列候选）
const anchors3 = [A('c1', 0, 0, 50), A('c2', 0, 40, 50)];
r = reverseLocate([{ page: 0, start: 30, end: 70 }], anchors3);
check('ambiguous-two', r.kind === 'ambiguous' && (r as { candidates: { clauseId: string }[] }).candidates.length === 2);

// 4) 选区大部分在锚点外（页眉）→ 占比低 → ambiguous（供确认）
r = reverseLocate([{ page: 0, start: 0, end: 500 }], anchors3);
check('low-ratio-candidates', r.kind === 'ambiguous');

// 5) 无任何重叠 → none
r = reverseLocate([{ page: 3, start: 0, end: 10 }], anchors3);
check('none', r.kind === 'none');

// 6) 跨页 TextRange → 两段 span
const spans = spansOfRange({ start: { page: 1, index: 90 }, end: { page: 2, index: 10 } });
check('cross-page-spans', spans.length === 2 && spans[0].page === 1 && spans[0].start === 90 && spans[1].page === 2 && spans[1].end === 10);

// 7) 页对象形态（PageRef）也能取 index
const spans2 = spansOfRange({ start: { page: { index: 5 }, index: 3 }, end: { page: { index: 5 }, index: 9 } });
check('pageref-form', spans2.length === 1 && spans2[0].page === 5 && spans2[0].start === 3 && spans2[0].end === 9);

// 8) 歧义占位锚点（charCount=0）不参与
const anchors4 = [A('c9', 0, 0, 0), A('c1', 0, 0, 100)];
r = reverseLocate([{ page: 0, start: 10, end: 20 }], anchors4);
check('placeholder-excluded', r.kind === 'unique' && (r as { clauseId: string }).clauseId === 'c1');

// 9) overlapOf 基本算术
check('overlap-math', overlapOf({ page: 0, start: 10, end: 30 }, A('x', 0, 20, 30)) === 10);
check('overlap-other-page', overlapOf({ page: 1, start: 10, end: 30 }, A('x', 0, 20, 30)) === 0);

console.log(fails === 0 ? 'ALL PASS' : `FAILED ${fails}`);
if (fails) process.exit(1);
