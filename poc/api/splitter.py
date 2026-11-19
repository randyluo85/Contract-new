# -*- coding: utf-8 -*-
"""条款拆分与五规则自检（Q10 拆分信号 + Q24 可疑节点）。

拆分信号：Docling 结构块 + 中文编号语义联合，冲突时编号优先（Q10）。
编号家族与层级：
  第X条 → 1；一、/ 1、 → 1；X.Y → 2；X.Y.Z → 3；（一）→ 当前层级1 之下的层级 2
  编号只在块文本行首锚定（修正阶梯第 1 层：表格 cell 与行中数字不参与拆分）
  层级上限 3（更深编号并入正文）；无编号文档降级平铺树（每块一节点），不阻断
  表格内容并入最近条款 content（Q3(i)）
五规则自检（Q24）：empty 空内容 / skip 跳号 / duplicate 重号 / overlong 超长(>1500) / jump 层级突变。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from parser import StructBlock

CN = "一二三四五六七八九十百千零〇两"
ARTICLE_RE = re.compile(rf"^(第[{CN}\d]+条)\s*(.*)$")
DASH_RE = re.compile(rf"^([{CN}\d]+)、\s*(.*)$")
PAREN_RE = re.compile(rf"^(（[{CN}\d]+）)\s*(.*)$")
DOTTED_RE = re.compile(r"^(\d+(?:\.\d+)*)\s*[、.．]?\s*(.*)$")

MAX_LEVEL = 3
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


def _match_number(text: str) -> tuple[str, int, str] | None:
    """(编号, 层级, 剩余文本)。行首锚定；行中数字不触发。"""
    t = (text or "").strip()
    if not t:
        return None
    m = ARTICLE_RE.match(t)
    if m:
        return m.group(1), 1, m.group(2).strip()
    m = DOTTED_RE.match(t)
    if m and "." in m.group(1):
        depth = m.group(1).count(".") + 1
        if depth > MAX_LEVEL:      # 更深编号并入正文
            return None
        return m.group(1), depth, m.group(2).strip()
    m = PAREN_RE.match(t)
    if m:
        return m.group(1), 2, m.group(2).strip()
    m = DASH_RE.match(t)
    if m:
        return m.group(1), 1, m.group(2).strip()
    return None


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

    for b in blocks:
        hit = _match_number(b.text) if b.kind in ("text", "heading") else None
        if hit:
            number, level, rest = hit
            title, tail = _short_title(rest, number)
            node = SplitClause(
                number=number, title=title, content=tail,
                page_no=b.page_no, level=level,
            )
            clauses.append(node)
            _pop_stack(stack, level)
            stack.append(node)
            current = node
        elif b.kind == "table":
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

    dotted = [c for c in clauses if re.match(r"^\d+(\.\d+)+$", c.number)]
    for i in range(1, len(dotted)):
        a, b = dotted[i - 1], dotted[i]
        try:
            pa, pb = a.number.split("."), b.number.split(".")
            if pa[:-1] == pb[:-1] and int(pb[-1]) - int(pa[-1]) > 1:
                b.flag("skip")
        except ValueError:
            pass
