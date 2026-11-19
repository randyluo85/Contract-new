# -*- coding: utf-8 -*-
"""编号恢复纯函数测试。运行：python3 test_parser.py（无重依赖，仅 stdlib）"""
from parser import match_numbered_line

failures = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print(f"FAIL: {name}")


lines = [
    "3.1.1 包装设计以智界公司 CPS 及 TPM 要求为包装业务开展的总原则，包",
    "3.1.2 供应商总焊装件要求出厂及上线包装均采用直送工位循环包装，包",
    "（一）出卖人货到买受人指定地点，并承担由此产生的费用。",
    "第2条 供应商的地理位置",
    "4、乙方提供的发票出现税务问题时，乙方应承担赔偿责任。",
]

check("recover-dotted",
      match_numbered_line("包装设计以智界公司 CPS 及 TPM 要求为包装业务开展的总原则，包 装设计应充分体现", lines) == "3.1.1")
check("recover-dotted2",
      match_numbered_line("供应商总焊装件要求出厂及上线包装均采用直送工位循环包装", lines) == "3.1.2")
check("recover-paren",
      match_numbered_line("出卖人货到买受人指定地点，并承担由此产生的费用。", lines) == "（一）")
check("recover-article",
      match_numbered_line("供应商的地理位置", lines) == "第2条")
check("recover-dash",
      match_numbered_line("乙方提供的发票出现税务问题时，乙方应承担赔偿责任。", lines) == "4")
check("no-match-unnumbered", match_numbered_line("与条款编号无关的一段普通正文内容", lines) is None)
check("no-match-short", match_numbered_line("太短", lines) is None)
check("no-double-prefix", match_numbered_line("3.1.8KD 件装箱量按照 120 的公约数", lines) is None)

print()
if failures:
    print(f"FAILED {len(failures)}: {failures}")
    raise SystemExit(1)
print("ALL PASS")
