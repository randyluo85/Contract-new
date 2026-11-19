# -*- coding: utf-8 -*-
"""Parser 接口与 Docling/Stub 实现（Q3：接口化，Docling 默认，可换后备）。

Docling 配置（Q20）：docling-slim、do_ocr=False、heading_hierarchy 不开、TableFormer FAST。
输出统一为 StructBlock 列表（block 级），坐标仅作候选（ADR-0002）。
"""
from __future__ import annotations

import os
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
        return blocks


def default_parser() -> Parser:
    """环境变量 POC_PARSER=stub 强制 stub；否则 Docling（默认）。"""
    if os.environ.get("POC_PARSER", "").lower() == "stub":
        return StubParser()
    return DoclingParser()
