# -*- coding: utf-8 -*-
"""splitter 层级推导与自检测试（家族表驱动版）。运行：python3 test_splitter.py"""
from splitter import SplitClause, StructBlock, audit_suspicious, split_clauses

B = lambda t, p=1, k="text": StructBlock(text=t, page_no=p, kind=k)
failures: list[str] = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print(f"FAIL: {name}")


# 1) 奇瑞形态：第X条 + 条内 1. 2. 3.（连续同级子项）
blocks = [
    B("第七条 包装、搬运及周转", 10),
    B("1. 供应商供应的合同货物的包装应严格遵守附件7。", 10),
    B("2. 售后用的合同货物包装、搬运与周转按照规定执行。", 10),
    B("3. 出口用的合同货物包装、搬运与周转按照规定执行。", 10),
    B("第八条 产品质量", 10),
    B("1. 供应商所供应合同货物的质量要求见附件5。", 10),
]
cs = split_clauses(blocks)
check("qirui-count", len(cs) == 6)
check("qirui-levels", [c.level for c in cs] == [1, 2, 2, 2, 1, 2])
check("qirui-numbers", [c.number for c in cs] == ["第七条", "1", "2", "3", "第八条", "1"])

# 2) 威睿形态：一、~十、顶层 + 1.1/2.2.1 点分 + （一）子项
blocks2 = [
    B("一、总则", 2),
    B("1.1 目的", 2),
    B("2.2.1 细则", 3),
    B("（一）出卖人货到买受人指定地点。", 4),
    B("（二）买受人扣留质保金。", 4),
    B("二、质量", 5),
    B("1.1 质量标准", 5),
]
cs2 = split_clauses(blocks2)
check("vruung-count", len(cs2) == 7)
# 层级：一、=fixed1 L1；1.1=depth L2；2.2.1=depth L3；（一）context：前 L3 非同家族→+1 封顶 L3
# （二）paren 连续→同级 L3；二、=fixed1 L1；1.1=depth L2
check("vruung-levels", [c.level for c in cs2] == [1, 2, 3, 3, 3, 1, 2])

# 3) MAHLE 形态：顶层平级 1. 2. 3.
cs3 = split_clauses([B("1. Competition Law and Antitrust.", 3), B("9. Counterfeit Parts.", 3)])
check("mahle-levels", [c.level for c in cs3] == [1, 1])
check("mahle-numbers", [c.number for c in cs3] == ["1", "9"])

# 4) Master Agreement 形态：A. 标题 + B.1.1 字母点分 + Article
blocks4 = [
    B("A.Definitions", 1, "heading"),
    B("B.1.1 The Parties expressly agree.", 1),
    B("B.1.2 This Master Agreement creates rights.", 1),
    B("Article 2 Product Supply", 1, "heading"),
]
cs4 = split_clauses(blocks4)
check("ma-count", len(cs4) == 4)
check("ma-levels", [c.level for c in cs4] == [1, 3, 3, 1])
check("ma-b11-depth", cs4[1].number == "B.1.1")

# 5) 表格并入最近条款 content
blocks5 = [
    B("第一条 合同标的", 1),
    B("1.1 产品名称：水管总成。", 1),
    StructBlock(text="", page_no=2, kind="table", table_markdown="|名称|数量|\n|水管|46|"),
    B("1.2 产品数量：以订单为准。", 2),
]
cs5 = split_clauses(blocks5)
check("table-into-content", any("|名称|" in c.content for c in cs5))
check("table-no-node", all(c.title != "(表格)" for c in cs5))

# 6) 无编号文档降级平铺（不重号）
cs6 = split_clauses([B("甲方：福士汽车。", 1), B("乙方：汉德车桥。", 1)])
audit_suspicious(cs6)
check("plain-flat", len(cs6) == 2 and all(c.level == 1 for c in cs6))
check("plain-no-duplicate", all("duplicate" not in c.suspicious for c in cs6))

# 7) 标题短语截取
blocks7 = [B("第二条 付款方式：收货后 30 日内支付。", 2)]
cs7 = split_clauses(blocks7)
check("title-short", cs7[0].title == "付款方式")
check("body-tail", "收货后" in cs7[0].content)

# 8) 五规则自检
audit = [
    SplitClause("1.1", "A", "", 1, 2),                     # empty
    SplitClause("1.3", "B", "x" * 10, 1, 2),               # skip (1.1→1.3)
    SplitClause("1.3", "C", "y" * 10, 1, 2),               # duplicate
    SplitClause("1.4", "D", "z" * 1600, 1, 2),             # overlong
    SplitClause("1.4.1", "E", "w" * 10, 1, 3),
    SplitClause("2", "F", "v" * 10, 1, 1),
]
audit_suspicious(audit)
check("rule-empty", "empty" in audit[0].suspicious)
check("rule-skip", "skip" in audit[1].suspicious)
check("rule-duplicate", "duplicate" in audit[2].suspicious)
check("rule-overlong", "overlong" in audit[3].suspicious)
check("no-jump-gradual", "jump" not in audit[4].suspicious)  # 2→3 渐进非突变
audit2 = [SplitClause("2", "F", "v" * 10, 1, 1), SplitClause("2.1.1", "E", "w" * 10, 1, 3)]
audit_suspicious(audit2)
check("rule-jump2", "jump" in audit2[1].suspicious)  # 1→3 直挂才是突变

print()
if failures:
    print(f"FAILED {len(failures)}: {failures}")
    raise SystemExit(1)
print("ALL PASS")
