# T8 测试记录 — PDF 条款解析与双向定位 POC

日期：2026-11-19 ｜ 运行：python3 _work/pdf-test/poc_t8_run_cases.py（fixtures：poc/fixtures.json 30 案例）

## 结果：30/30 通过 ✅（零错误标记）

| 维度 | 案例 | 通过 | 口径 |
|---|---|---|---|
| 正向·唯一 | 11 | 11 | 期望页码相等 + 锚点 exactText 含期望片段（读回核验语义） |
| 正向·歧义 | 3 | 3 | 有锚点但无 linked（铁律：歧义停待确认，人工绑定路径） |
| 正向·失败 | 1 | 1 | 未定位（无锚点，不错误高亮） |
| 反向·唯一 | 11 | 11 | 选区区间与锚点求交命中唯一条款（占比 ≥30%） |
| 反向·歧义 | 2+1 | 3 | 跨条款边界选区列候选（两条款重叠各 ≥30%） |
| 反向·无对应 | 1 | 1 | 页外选区空提示（正确行为） |

## 关键口径记录

- 正向断言=锚点落库事实（页码+exactText），与 UI 点击「跳页+高亮+读回」同源（T3 E2E 已单独验证 UI 链）。
- 反向断言=reverseLocate 纯函数语义复算（区间求交+重叠排序+占比≥30% 唯一），与 onCommitted UI 链同源（T4 E2E 已验证）。
- R10 案例经历口径修正：擦边选区（1.1 内 31 字+1.2 擦边 5 字=12%）判唯一是**正确行为**（用户意图显然在 1.1 内）——歧义案例自校验「两条款各占 ≥30%」才入歧义组。
- fixtures 键=条款 id（编号可重复，如智界两处「1.1」——编号重复正是五规则自检的 duplicate 角标）。
- 生成器带自校验：歧义对生成时复算重叠占比，非真歧义对不入组（fixtures 期望与断言同口径闭环）。

## 累计验收证据（各票）

- T1 骨架：Playwright 冒烟（上传→done→树+预览+幂等）
- T2 解析：26 份批量（19 良好/6 扫描/2 平铺）；三套单测 ALL PASS
- T3 正向：样例 linked 23/26、GTC 英文 25/40、智界 101/129（三轮质量修复后）
- T4 反向：E2E 三路（unique/ambiguous:2/none）+ reverse.test.ts 9 例
- T5 绑定/恢复：E2E 五路（绑定/正向/反向/确认/重开）
- T6 重解析：E2E 四断言（manual 保留/失效清单/auto 清/树重建）
- T7 树编辑：E2E 8/8（四类编辑+锚点跟随）

## 交付物

- Web Demo：http://localhost:5173/（上传→解析→树→双向定位→绑定→重开完整闭环）
- fixtures：[poc/fixtures.json](fixtures.json)（30 案例，代号+条款 id+期望页/片段/判定，不含原文全段）
- 断言脚本：[_work/pdf-test/poc_t8_run_cases.py](../_work/pdf-test/poc_t8_run_cases.py)（可复跑）
- 结果：[poc/test-results.json](test-results.json)
- 交付 JSON：[poc/parse-export.json](parse-export.json)（自有 Clause/Anchor schema）
- 测试记录：本文件
