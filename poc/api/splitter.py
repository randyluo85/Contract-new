# -*- coding: utf-8 -*-
"""条款拆分与五规则自检（Q10 拆分信号 + Q24 可疑节点）。

拆分信号：Docling 结构块 + 编号语义联合，冲突时编号优先（Q10）。
编号识别统一走 numbering.FAMILIES（单一事实源，含中英家族表）。
层级推导：fixed1 家族恒 L1；depth 家族=段数；context 家族按语境
（文档顶层=1；与前节点同家族=同级；否则=前节点层级+1）。
表格内容并入最近条款 content（Q3(i)）；无编号文档降级平铺不阻断。
五规则自检（Q24）：empty 空内容 / skip 跳号 / duplicate 重号 / overlong 超长(>1500) / jump 层级突变。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from numbering import MAX_LEVEL, level_of_depth, match_prefix, same_family
from parser import StructBlock

LONG_CONTENT = 1500
_PUNCT = r"[。：:；;，,．\.\s]"


@dataclass
class SplitClause:
    number: str
    title: str
    content: str = ""
    page_no: int | None = None
    level: int = 1
    suspicious: tuple[str, ...] = field(default_factory=tuple)

    def flag(self, rule: str) -> None:
        if rule not in self.suspicious:
            self.suspicious = (*self.suspicious, rule)


def _short_title(rest: str, number: str) -> tuple[str, str]:
    """编号后的标题短语与剩余正文。"""
    rest = rest.strip()
    if not rest:
        return number, ""
    m = re.split(_PUNCT, rest, 1)
    head = (m[0] or "").strip()[:40]
    if not head:
        head = rest[:40]
    tail = rest[len(m[0]):].strip() if m[0] else rest
    return head, tail


def _pop_stack(stack: list[SplitClause], level: int) -> None:
    while stack and stack[-1].level >= level:
        stack.pop()


def split_clauses(blocks: list[StructBlock]) -> list[SplitClause]:
    clauses: list[SplitClause] = []
    stack: list[SplitClause] = []
    current: SplitClause | None = None
    last_family: str | None = None

    for b in blocks:
        hit = match_prefix(b.text) if b.kind in ("text", "heading") else None
        if hit:
            family, number, rest, rule = hit
            # 层级推导
            if rule == "fixed1":
                level = 1
            elif rule == "depth":
                depth = level_of_depth(number)
                if depth is None:          # 超过 MAX_LEVEL：并入正文
                    hit = None
                else:
                    level = depth
            else:                          # context
                if not stack:
                    level = 1              # 文档顶层
                elif same_family(last_family, family):
                    level = stack[-1].level  # 连续同家族 → 同级
                else:
                    level = min(MAX_LEVEL, stack[-1].level + 1)
            if hit:
                title, tail = _short_title(rest, number)
                node = SplitClause(
                    number=number, title=title, content=tail,
                    page_no=b.page_no, level=level,
                )
                clauses.append(node)
                _pop_stack(stack, level)
                stack.append(node)
                current = node
                last_family = family
                continue
        if hit is None:
            if b.kind == "table":
                md = b.table_markdown or b.text
                if current is not None:
                    current.content += ("\n\n" if current.content else "") + md
                else:
                    clauses.append(SplitClause(
                        number="", title="(表格)", content=md, page_no=b.page_no, level=1,
                    ))
            elif (b.text or "").strip():
                text = b.text.strip()
                if current is not None:
                    current.content += ("\n" if current.content else "") + text
                else:
                    clauses.append(SplitClause(
                        number="", title=text[:40], content=text,
                        page_no=b.page_no, level=1,
                    ))
    return clauses


def audit_suspicious(clauses: list[SplitClause]) -> None:
    """就地打可疑角标（Q24 五规则）。"""
    seen: dict[tuple[int, str], int] = {}
    prev_level = 0
    for c in clauses:
        if not c.content.strip():
            c.flag("empty")
        if len(c.content) > LONG_CONTENT:
            c.flag("overlong")
        if c.number:  # 空编号（无编号降级平铺）不参与重号检测
            key = (c.level, c.number)
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > 1:
                c.flag("duplicate")
        if c.level > prev_level + 1:
            c.flag("jump")
        prev_level = c.level

    dotted = [c for c in clauses if re.match(r"^[A-Za-z]?\d+(?:\.\d+)+$", c.number)]
    for i in range(1, len(dotted)):
        a, b = dotted[i - 1], dotted[i]
        try:
            pa, pb = a.number.split("."), b.number.split(".")
            if pa[:-1] == pb[:-1] and int(pb[-1]) - int(pa[-1]) > 1:
                b.flag("skip")
        except ValueError:
            pass
