# -*- coding: utf-8 -*-
"""Parser 接口与 Docling/Stub 实现（Q3：接口化，Docling 默认，可换后备）。

Docling 配置（Q20）：docling-slim、do_ocr=False、heading_hierarchy 不开、TableFormer FAST。
输出统一为 StructBlock 列表（block 级），坐标仅作候选（ADR-0002）。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class StructBlock:
    """结构块：解析器输出的最小单元。kind ∈ text|table|heading。"""
    text: str
    page_no: int | None = None
    kind: str = "text"
    table_markdown: str | None = None
    level: int | None = None  # Docling heading 层级提示（默认全 1，编号语义优先）


class Parser(Protocol):
    def parse(self, pdf_path: str) -> list[StructBlock]: ...


class StubParser:
    """固定假条款（T1 用；测试与无 Docling 环境的退路）。"""

    def parse(self, pdf_path: str) -> list[StructBlock]:
        return [
            StructBlock("第一条 合同标的", 1, "heading"),
            StructBlock("1.1 产品名称：详见附件。", 1),
            StructBlock("1.2 产品数量：以订单为准。", 1),
            StructBlock("第二条 付款方式", 2, "heading"),
            StructBlock("2.1 付款期限：收货后 30 日。", 2),
            StructBlock("2.2 付款条件：验收合格后付款。", 2),
            StructBlock("第三条 违约责任", 3, "heading"),
            StructBlock("3.1 违约金：按合同总价 5%。", 3),
            StructBlock("3.2 赔偿责任：赔偿实际损失。", 3),
        ]


class DoclingParser:
    """Docling 默认实现（Q20 定案的配置）。"""

    def parse(self, pdf_path: str) -> list[StructBlock]:
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableFormerMode,
        )
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc.labels import DocItemLabel

        opts = PdfPipelineOptions()
        opts.do_ocr = False                    # 仅验证文字型 PDF
        opts.do_table_structure = True
        opts.table_structure_options.mode = TableFormerMode.FAST
        converter = DocumentConverter(
            format_options={"pdf": PdfFormatOption(pipeline_options=opts)}
        )
        result = converter.convert(pdf_path)
        doc = result.document

        blocks: list[StructBlock] = []
        for item, level in doc.iterate_items():
            label = getattr(item, "label", None)
            page_no = None
            provs = getattr(item, "prov", None) or []
            if provs:
                page_no = getattr(provs[0], "page_no", None)
            if label == DocItemLabel.TABLE:
                blocks.append(StructBlock(
                    text="",
                    page_no=page_no,
                    kind="table",
                    table_markdown=item.export_to_markdown(doc),
                ))
            elif label in (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE):
                blocks.append(StructBlock(
                    text=item.text or "",
                    page_no=page_no,
                    kind="heading",
                    level=max(1, level or 1),
                ))
            elif label in (DocItemLabel.TEXT, DocItemLabel.PARAGRAPH, DocItemLabel.LIST_ITEM):
                text = getattr(item, "text", None)
                if text and text.strip():
                    blocks.append(StructBlock(text=text, page_no=page_no, kind="text"))
        _recover_numbers(blocks, pdf_path)
        return blocks


# ---------------- 编号恢复（修正阶梯第 1 层：解析期减错） ----------------
# 实测事实（安徽智界物流协议.pdf）：编号 3.1.1~3.1.7 在 PDF 原始文字层行首存在，
# 但 Docling 布局管线把编号前缀整段丢弃（185 个 item 0 命中），导致下游漏拆。
# 对策：用 pypdf 按页提取原始行，行首命中编号家族且去空白后与块开头一致时，补回编号。

_NUM_PREFIX_RE = re.compile(
    r"^((?:第[一二三四五六七八九十百千零〇两\d]+条)"
    r"|(?:\d+(?:\.\d+)+)"
    r"|(?:[一二三四五六七八九十百千零〇两\d]+、)"
    r"|(?:（[一二三四五六七八九十百千零〇两\d]+）))"
)

_SQUASH = lambda s: re.sub(r"\s+", "", s or "")


def match_numbered_line(body_text: str, raw_lines: list[str]) -> str | None:
    """块正文若与某条「编号+剩余」的原始行同头，返回应补回的编号。纯函数，可测。"""
    head = _SQUASH(body_text)[:24]
    if len(head) < 8:  # 太短易误配
        return None
    for ln in raw_lines:
        m = _NUM_PREFIX_RE.match(ln.strip())
        if not m:
            continue
        rest = _SQUASH(ln.strip()[m.end():])[:24]
        if len(rest) >= 8 and rest == head:
            number = m.group(1)
            return number[:-1] if number.endswith("、") else number  # 顿号不进编号
    return None


def _recover_numbers(blocks: list[StructBlock], pdf_path: str) -> None:
    """就地补回被 Docling 丢弃的行首编号（按块 provenance 页对齐原始文字层）。"""
    from pypdf import PdfReader

    try:
        reader = PdfReader(pdf_path)
    except Exception:
        return
    page_lines: dict[int, list[str]] = {}
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            continue
        page_lines[i + 1] = [ln for ln in text.splitlines() if ln.strip()]

    for b in blocks:
        if b.kind != "text" or not b.text or b.page_no is None:
            continue
        if _NUM_PREFIX_RE.match(b.text.strip()):  # 块本身带编号，不重复补
            continue
        number = match_numbered_line(b.text, page_lines.get(b.page_no) or [])
        if number:
            b.text = f"{number} {b.text}"


def default_parser() -> Parser:
    """环境变量 POC_PARSER=stub 强制 stub；否则 Docling（默认）。"""
    if os.environ.get("POC_PARSER", "").lower() == "stub":
        return StubParser()
    return DoclingParser()
