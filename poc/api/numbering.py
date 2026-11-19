# -*- coding: utf-8 -*-
"""统一编号家族表（单一事实源）：splitter 拆分与 parser 编号恢复共用。

层级规则（每家族三种之一）：
- fixed1  —— 恒为 L1（第X条 / Article X）
- depth   —— 层级 = 编号段数（1.1→2，B.1.1→3；超过 MAX_LEVEL 并入正文）
- context —— 语境推导：文档顶层=1；与前一节点同家族=同级（连续子项）；否则=前节点层级+1

事实来源（真实语料核查 2026-11-19）：
- 威睿双语 99 页：一、~十、（L1）+ 1.1 / 2.2.1（点分）
- 奇瑞采购主合同：第X条 + 条内 1. 2. 3.（Docling 丢编号，由 parser 恢复）
- Master Agreement（364）：Article B.4 引用、B.1.1（字母点分三层）、A.Definitions（单字母标题）
- MAHLE Code of Conduct（178）：顶层平级 1. 2. 9.
- 订货合同群：1、2、3、顶层平铺
- Consignment（140）：目录 1...Subject，正文 1. Subject
分隔符实测集合：. ． 、 ， , ） ) ： : 空格
"""
from __future__ import annotations

import re

CN = "一二三四五六七八九十百千零〇两"
MAX_LEVEL = 3

_EN_WORD = (
    r"(?:[Aa]rticle|ARTICLE|[Ss]ection|SECTION|[Cc]lause|CLAUSE|[Cc]hapter|CHAPTER|"
    r"[Pp]art|PART|[Aa]nnex|ANNEX|[Aa]ppendix|APPENDIX|[Ss]chedule|SCHEDULE|"
    r"[Tt]erm|TERM)\s+"
)


def _f(name: str, pattern: str, rule: str) -> tuple[str, re.Pattern, str]:
    return name, re.compile(pattern), rule


# 家族表：按优先级从上到下（先具体后泛化；先点分后裸数字）
FAMILIES: list[tuple[str, re.Pattern, str]] = [
    _f("article-cn", rf"(第[{CN}\d]+条)", "fixed1"),
    _f("en-word", rf"({_EN_WORD}(?:\d+(?:\.\d+)*|[IVX]+|[A-Z])\b)", "fixed1"),
    _f("alpha-dotted", r"([A-Za-z]\.\d+(?:\.\d+)*)", "depth"),
    _f("dotted", r"(\d+(?:\.\d+)+)", "depth"),
    _f("paren", rf"([（(]\s*(?:[{CN}]+|\d{{1,3}}|[A-Za-z])\s*[）)])", "context"),
    _f("cn-dash", rf"([{CN}]+、)", "fixed1"),
    _f("num-sep", r"(\d{1,3})\s*[.．、，,）):：]", "context"),
    _f("alpha", r"([A-Za-z]|[ivx]{2,4}|[IVX]{2,4})\s*[.．、]", "context"),
    # 裸数字+空格：最宽家族放最后；安全阀：1-2 位、后随中文/字母、且下一个字不是 年/月/日/件
    _f("bare-num", r"(\d{1,2})(?=\s*(?:[\u4e00-\u9fffA-Za-z])(?<![年月日件]))", "context"),
]

# 裸数字家族的负向遮罩：形如 3 月/8 日/46 件 的量词短语不是编号
_BARE_NEG = re.compile(r"^\d{1,2}\s*[年月日件分条页周]")


def _bare_blocked(t: str) -> bool:
    return bool(_BARE_NEG.match(t))


def match_prefix(text: str) -> tuple[str, str, str, str] | None:
    """行首匹配编号家族。返回 (family, token, rest, rule)；未命中返回 None。

    token 是干净编号（第X条/Article 1/1.1/B.1.1/（一）/1/A/ii），
    rest 是去掉编号后的剩余文本（strip 过）。
    """
    t = (text or "").strip()
    if not t:
        return None
    for name, pat, rule in FAMILIES:
        m = pat.match(t)
        if not m:
            continue
        token = m.group(1).strip()
        rest = t[m.end():].strip()
        if not token:
            continue
        if name == "bare-num" and _bare_blocked(t):
            continue
        return name, token, rest, rule
    return None


def level_of_depth(token: str) -> int | None:
    """depth 家族的层级 = 段数；超过 MAX_LEVEL 返回 None（并入正文）。"""
    parts = [p for p in re.split(r"[.]", token) if p]
    depth = len(parts)
    return depth if 1 <= depth <= MAX_LEVEL else None


def same_family(a: str | None, b: str | None) -> bool:
    """两个家族名是否视为连续同级（alpha 含单字母与罗马）。"""
    if not a or not b:
        return False
    if a == b:
        return True
    return {a, b} <= {"alpha", "alpha-dotted"}
