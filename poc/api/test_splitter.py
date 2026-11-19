# -*- coding: utf-8 -*-
"""splitter 函数级开发测试（T2 验收项）。运行：python3 test_splitter.py"""
from splitter import SplitClause, StructBlock, audit_suspicious, split_clauses, _match_number

B = lambda t, p=1, k="text": StructBlock(text=t, page_no=p, kind=k)
failures: list[str] = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print(f"FAIL: {name}")


# 1) 编号家族与层级
check("article-l1", _match_number("第一条 合同标的与数量")[0] == "第一条")
check("dotted-l2", _match_number("1.1 产品名称：详见附件")[1] == 2)
check("dotted-l3", _match_number("1.1.1 细则")[1] == 3)
check("paren-l2", _match_number("（一）付款期限")[1] == 2)
check("dash-l1", _match_number("一、总则")[1] == 1)
check("digit-dash-l1", _match_number("1、本合同预估总量")[1] == 1)
check("inline-no-match", _match_number("产品数量 1、2、3 见下表") is None)   # 行首锚定：行中数字不触发
check("deep-dotted-merged", _match_number("1.1.1.1 深层编号") is None)      # 层级>3 并入正文

# 2) 树形结构（条/项两级 + 表格入 content）
blocks = [
    B("第一条 合同标的", 1),
    B("1.1 产品名称：水管总成。", 1),
    StructBlock(text="", page_no=2, kind="table", table_markdown="|名称|数量|\n|水管|46|"),
    B("1.2 产品数量：以订单为准。", 2),
    B("第二条 付款方式：收货后付款。", 2),
]
clauses = split_clauses(blocks)
check("count", len(clauses) == 4)
check("levels", [c.level for c in clauses] == [1, 2, 2, 1])
check("table-into-content", "|名称|" in clauses[1].content)
check("title-short", clauses[0].title == "合同标的")
check("body-accumulates", "以订单为准" in clauses[2].content)

# 3) （一）挂到最近条下（level2）
blocks2 = [B("第一条 总则", 1), B("（一）本协议为原合同附件。", 1), B("（二）与原合同具有同等效力。", 1)]
c2 = split_clauses(blocks2)
check("paren-under-article", all(x.level == 2 for x in c2[1:]))

# 4) 无编号文档降级平铺
c3 = split_clauses([B("甲方：福士汽车。", 1), B("乙方：汉德车桥。", 1)])
check("plain-flat", len(c3) == 2 and all(x.level == 1 for x in c3))

# 5) 行内密集编号单块不拆（一整段 1、2、3、）→ 一节点 + 超长/粗粒度由自检暴露
dense = "1、本合同预估总量以 SRM 订单为准。2、结算方式为挂账 120 天。3、价格以价格通知单为准。"
c4 = split_clauses([B(dense, 1)])
check("dense-single-block", len(c4) == 1)

# 6) 五规则自检
audit = [
    SplitClause("1.1", "A", "", 1, 2),                     # empty
    SplitClause("1.3", "B", "x" * 10, 1, 2),               # skip (1.1→1.3)
    SplitClause("1.3", "C", "y" * 10, 1, 2),               # duplicate
    SplitClause("1.4", "D", "z" * 1600, 1, 2),             # overlong
    SplitClause("1.4.1", "E", "w" * 10, 1, 3),             # jump (prev level1? 下一个 1.1 直挂 level3)
    SplitClause("2", "F", "v" * 10, 1, 1),
]
audit[4] = SplitClause("1.4.1", "E", "w" * 10, 1, 3)
audit2 = [SplitClause("2", "F", "v" * 10, 1, 1), SplitClause("2.1.1", "E", "w" * 10, 1, 3)]
audit_suspicious(audit)
check("rule-empty", "empty" in audit[0].suspicious)
flat = split_clauses([B("甲方：福士汽车。", 1), B("乙方：汉德车桥。", 1)])
audit_suspicious(flat)
check("plain-no-duplicate", all("duplicate" not in x.suspicious for x in flat))
check("rule-skip", "skip" in audit[1].suspicious)
check("rule-duplicate", "duplicate" in audit[2].suspicious)
check("rule-overlong", "overlong" in audit[3].suspicious)
check("no-jump-gradual", "jump" not in audit[4].suspicious)  # 2→3 渐进非突变
audit_suspicious(audit2)
check("rule-jump2", "jump" in audit2[1].suspicious)  # 1→3 直挂才是突变

print()
if failures:
    print(f"FAILED {len(failures)}: {failures}")
    raise SystemExit(1)
print("ALL PASS")
