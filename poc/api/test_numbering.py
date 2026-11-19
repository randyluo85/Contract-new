# -*- coding: utf-8 -*-
"""编号家族表测试（用户点名：点/逗号/冒号/纯数字/中文/英文 各形态）。运行：python3 test_numbering.py"""
from numbering import match_prefix, level_of_depth, same_family

failures = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print(f"FAIL: {name}")


def hit(text):
    r = match_prefix(text)
    return r  # (family, token, rest, rule)


# --- 中文 ---
check("article-cn", hit("第一条 合同标的")[:2] == ("article-cn", "第一条"))
check("article-cn-digit", hit("第12条 质量保证")[:2] == ("article-cn", "第12条"))
check("cn-dash", hit("一、总则")[:2] == ("cn-dash", "一、"))
check("paren-cn", hit("（一）付款期限")[:2] == ("paren", "（一）"))
check("dotted-l2", hit("1.1 产品名称")[:2] == ("dotted", "1.1"))
check("dotted-l3", hit("1.1.1 细则")[:2] == ("dotted", "1.1.1"))
check("depth-2", level_of_depth("1.1") == 2)
check("depth-3", level_of_depth("1.1.1") == 3)
check("depth-over-max", level_of_depth("1.1.1.1") is None)

# --- 分隔符全集（用户点名：点/逗号/冒号） ---
check("sep-dot", hit("1. 供应商供应的合同货物")[:2] == ("num-sep", "1"))
check("sep-dot-fullwidth", hit("1．包装要求")[:2] == ("num-sep", "1"))
check("sep-comma", hit("2,乙方应承担赔偿责任")[:2] == ("num-sep", "2"))
check("sep-comma-cn", hit("2，乙方应承担赔偿责任")[:2] == ("num-sep", "2"))
check("sep-colon", hit("3:质量标准")[:2] == ("num-sep", "3"))
check("sep-colon-cn", hit("3：质量标准")[:2] == ("num-sep", "3"))
check("sep-paren-close", hit("4)包装要求")[:2] == ("num-sep", "4"))
check("sep-dash-cn", hit("1、本合同预估总量")[:2] == ("num-sep", "1"))

# --- 纯数字 + 空格（安全阀内） ---
check("bare-num-ok", hit("1 供应商供应的合同货物")[:2] == ("bare-num", "1"))
check("bare-num-2digit", hit("12 保密义务")[:2] == ("bare-num", "12"))
check("bare-num-year-blocked", hit("2026 年度采购协议") is None)      # 年
check("bare-num-month-blocked", hit("3 月份结算") is None)            # 月
check("bare-num-day-blocked", hit("8 日报送") is None)               # 日
check("bare-num-3digit-blocked", hit("100 件货物") is None)          # 3 位数字
check("bare-num-digit-follow", hit("46 件") is None)                 # 后随"件"被阀挡

# --- 英文 ---
check("en-article", hit("Article 1 Definitions")[:2] == ("en-word", "Article 1"))
check("en-section", hit("Section 2 Scope")[:2] == ("en-word", "Section 2"))
check("en-section-dotted", hit("Section 2.2 Warranties")[:2] == ("en-word", "Section 2.2"))
check("en-annex-upper", hit("ANNEX A Pricing")[:2] == ("en-word", "ANNEX A"))
check("en-appendix", hit("Appendix H Affiliates")[:2] == ("en-word", "Appendix H"))
check("alpha-dotted", hit("B.1.1 The Parties")[:2] == ("alpha-dotted", "B.1.1"))
check("alpha-dotted-depth", level_of_depth("B.1.1") == 3)
check("alpha-single", hit("A.Definitions")[:2] == ("alpha", "A"))
check("alpha-lower", hit("a. General")[:2] == ("alpha", "a"))
check("roman-lower", hit("ii. Packaging")[:2] == ("alpha", "ii"))
check("roman-upper", hit("IV. Tests")[:2] == ("alpha", "IV"))
check("paren-letter", hit("(a) delivery terms")[:2] == ("paren", "(a)"))
check("paren-digit", hit("（1）标的")[:2] == ("paren", "（1）"))

# --- 行中数字不触发（行首锚定） ---
check("inline-blocked", hit("产品数量 1、2、3 见下表") is None)
check("sentence-not-number", hit("The supplier shall deliver") is None)  # 单词非编号家族
check("year-sentence", hit("2026年1月1日至2026年12月31日") is None)

# --- 同家族连续性 ---
check("same-alpha", same_family("alpha", "alpha"))
check("same-numsep", same_family("num-sep", "num-sep"))
check("diff-family", not same_family("num-sep", "article-cn"))

print()
if failures:
    print(f"FAILED {len(failures)}: {failures}")
    raise SystemExit(1)
print("ALL PASS")
