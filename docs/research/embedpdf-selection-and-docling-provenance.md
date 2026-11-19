# 研究笔记：EmbedPDF 选区/搜索/标注 API 与 Docling provenance

> 本仓库此前没有 research notes 惯例，本文档新建 `docs/research/` 目录存放研究笔记。
> 调查时间：2026-11-19。EmbedPDF 证据来自本地源码克隆 `_work/embed-pdf-viewer`（commit `9e84385`，`@embedpdf/viewer-react@3.3.0`，`@embedpdf/plugin-selection@3.3.0`）；Docling 证据来自官方 GitHub 仓库 docling-project/docling、docling-project/docling-core（main 分支，写作时最新 release v2.150.1，2026-11-14 发布）与 Docling 技术报告（arXiv:2408.09869v5）。

## 分档说明

- **确认的事实**：直接读源码/官方文档原文得出，每条附「路径:行号」或官方 URL。
- **推断/未验证**：从源码语义合理外推、或官方文档未明确说明的部分，需实测验证。

---

# A 组：EmbedPDF（本地源码 primary source）

## A1. selection 插件：宿主能否收到用户手动拖选的事件

### 确认的事实

**能，且 API 完备。** SelectionCapability 暴露三个事件钩子（`packages/plugin/selection/src/contract.ts:274-280`）：

- `onChanged: EventHook<SelectionChangedEvent>` — 选区或其分段变化（拖选每一步、程序化 select、边界页几何加载、clear 都触发）。
- `onCommitted: EventHook<SelectionCommittedEvent>` — **手势结束（pointer-up、拖点释放）且有选区在位时触发，且明确「程序化选区从不触发此事件」**（contract.ts:141-146 注释），这是「用户确认选区」的语义点，正适合「用户选 → 宿主建标注」的流程。
- `onCleared: EventHook<SelectionClearedEvent>` — 选区从有到无。

事件载荷结构（contract.ts:135-149）：

```ts
interface SelectionChangedEvent {
  readonly range: TextRange | null;       // 选中字符区间
  readonly pages: readonly PageRef[];      // 当前带 segment 的页
}
interface SelectionCommittedEvent { readonly range: TextRange }
type SelectionClearedEvent = Record<string, never>  // 无载荷
```

**字符区间是页内索引、不是文档级索引**：`TextPosition` = `{ page: PageRef; index: number }`（0 基字符索引，页内），`TextRange` 是半开区间 `start` 含/`end` 不含，按文档顺序（contract.ts:64-78）。注释明确说明它「不是抽取文本的字符串偏移」，两空间由引擎 `charMap` 桥接。

**跨页选区的表达**：GlyphPosition 按 (页 index, glyph) 全局排序，`SelectionRange` = anchor + focus 两个 GlyphPosition（`model.ts:11-20`）；controller 注释明确「Selection is cross-page: 从第 2 页拖到第 4 页会选中 2 的尾、3 的全部、4 的头」（controller.ts:79-82）。跨页字符区间用「每页一段半开区间」表达，readTextInRange 按页切片读取、页间以 `\n` 连接（controller.ts:412-458）。

**rects/文本获取**：事件本身不带 rect 与文本；宿主从 `getSnapshot()`（含每页 segments、start/end 端点 quad、方向、range）或 `listRects(page)`（AABB）、`readText()`（文本，需 `doc.text.copy` 权限）补齐。segments 类型 `SelectionSegment = PdfTextSegment` = `{ quad（方向四边形，几何权威）; rect（AABB）; advance: 1|-1（阅读方向）}`（`geometry.ts:17`，`packages/engine/core/src/text/layout.ts:63-75`）。

**状态钩子**：React 侧 `useSelectionState()`（`packages/framework/react/src/selection.tsx:143`）返回 `{ hasSelection; isSelecting; range; pages }`（`state.ts:13-22`），只适合 UI 开关，不含几何。

拖选手势由 interaction hub 的 pointer 流驱动（`selection.plugin.ts:9-14`），插件依赖 `InteractionToken`。事件发射处：changed/committed/cleared 在 controller（controller.ts:89-91 创建、517-519 挂载、541-547 手势结束时先 settle 再 emit committed）。

## A2. SearchHit 的确切结构

### 确认的事实

`packages/plugin/search/src/contract.ts:41-51`：

```ts
interface SearchHit {
  readonly page: PageRef;          // 页的持久身份
  readonly pageIndex: number;      // 匹配时刻的显示序号
  readonly start: number;          // 页字符空间起点
  readonly count: number;          // 字符数
  readonly segments: readonly TextSegment[];  // 页空间可视行分段（绘制输入）
  readonly bounds?: Rect;          // segments 的并集（reveal 目标）；无可绘制几何时缺省
  readonly snippet?: SearchSnippet;  // before/match/after，空白压平
}
```

- **字符区间是页内索引**：注释（contract.ts:36-39）明确「a range of the page's characters, so a hit goes straight to `selection.select({ page: hit.page, start: hit.charStart, count: hit.charCount })`」；引擎层 SearchMatch 注释（`packages/engine/core/src/search/types.ts:122-133`）同样说明不是 `PageTextSnapshot.text` 的字符串偏移，引擎经 charMap 转换。
- **bounds 坐标系**：页空间（page space：y 向下、PDF 单位、crop 相对）——selection contract 头注释（`plugin/selection/src/contract.ts:7-8`）；`bounds = boundsOfRects(segments.map(s => s.rect))`（`plugin/search/src/controller.ts:110-111`），即命中分段 AABB 的并集。
- snippet 需要 `doc.text.copy` 权限（默认有权限才带；`searchFindAllOptions.snippets` 可强制，强制无权限会拒绝，contract.ts:120-128）。

## A3. search.findAll 的匹配算法（空白/断行/跨页）

### 确认的事实

**归一化（fold）**：字面查询在「折叠文本平面」上匹配（`packages/engine/core/src/search/fold.ts`，`SEARCH_FOLD_VERSION = 2`，fold.ts:36）：
- 不可见字符（软连字符、零宽空格/连接符、bidi 标记、U+FEFF、非空白控制码、noncharacters）直接忽略 → 匹配可跨越它们（fold.ts:8-12、67-71）。
- 空白串折叠为单个空格（任何 `\s`）（fold.ts:13-14、83-94）→ **跨行文本「hello\n  world」可命中「hello world」**；`ignoreWhitespace: true` 时直接丢弃空白，「i n v o i c e」可命中「invoice」（types.ts:45-52）。
- NFKD 分解（连字 ﬁ→fi、上标 ²→2）+ 去组合标记 + 大小写折叠（upper→lower 往返）（fold.ts:15-21、73-79）。
- 折叠位 ↔ 原文位有 map，匹配区间翻译回精确原文区间（fold.ts:23-25、112-128）。

**逐页匹配，跨页文本搜不到**：引擎 SearchReader 逐页循环（`packages/engine/services/src/features/search/SearchReader.ts:130-179`）——每页独立取 corpus.text、跑 matcher（matchLiteral/matchRegex），命中才读几何并按页组装 SearchMatch；分片预算按页粒度、cursor 只在页之间推进（SearchReader.ts:126-128 注释）。**结论：匹配不跨页；一页尾部+下一页头部的短语不会命中。** 全角/半角：NFKD 会折叠兼容分解字符（如全角数字/部分标点变体），但对中文标点（，vs ,）等不保证全部归一——未见任何针对全角/半角标点的专门归一化代码，**未验证**部分见下。

**行内断字**：PDF 文字层的断字若以软连字符 U+00AD 表达会被 fold 忽略（IGNORABLE 含 U+00AD，fold.ts:58）；「行内断字」若是抽取文本中的换行+空白，默认 fold 已把换行折叠成空格解决。

`wholeWord` 的词边界用 Unicode 字母/数字（`[\p{L}\p{N}_]`，literal.ts:25），对中文（Han 属 \p{L}）会把整个连续汉字串当「一个词」——中文短语加 wholeWord 语义需注意。

## A4. annotation.createFromSelection 的产出与序列化

### 确认的事实

**调用与产出**：`createFromSelection(toolId, options?) → Promise<{ annotations: readonly Annotation[] }>`（`plugin/annotation/src/contract.ts:903-906`）。「每个选中页一条标注」（一页一个 highlight/underline 等）；无文字选区时返回空数组；默认调用后清空文字选区（`clear: false` 可保留）（contract.ts:894-899；实现 `write/markup.ts:159-199`：按 selection snapshot.pages 逐页建 markup commit，quads 取每行 segment.quad）。

**标注对象字段**（text-markup 族，如 highlight）：AnnotationBase 字段（`engine/core/src/annotation/kinds/shared-fields.ts:50-117`）包括 `ref`、`page`、`rect`、`contents`、`author`、`createdAt/modifiedAt`、`popup`、`reply`、各 /F 标志等；textMarkup 额外字段（shared-fields.ts:225-230）：`quadPoints`（`/QuadPoints`，行 quad 数组——**几何权威**）、`rect`（quads 的包围盒）、`color/opacity`。**不引用字符区间**：PDF text-markup 标注按 PDF 规范存 quadPoints 几何，不存 char span——选中区间只在建标注时用于推导 quads。

**序列化/导出/恢复**：
- `annotations.export(selection?) → Promise<AnnotationBundle>`（contract.ts:956-959）：把标注连同其字节资源导出为 bundle（需 `doc.download` 权限）；`import(bundle) → { annotations, refMap, dropped }`（contract.ts:968-971）把 bundle 装回同一文档（history: false 可不进撤销栈）。
- 引擎层 `AnnotationTransfer`（`engine/core/src/transfer/AnnotationTransfer.ts:8-17`）：bundle 可 stringify 成单 JSON 文件（资源 base64）/parse 回来，用于存储或下载。
- **结论：可持久化与恢复**——export→存 JSON→重开同一文档 import；跨文档移植时页面引用按 PageRef（PDF object number）对位。

## A5. PDFViewer React 组件接入

### 确认的事实

（`packages/viewer/react/src/component.ts`、`index.ts`、`core.ts`，`packages/viewer/main/src/kernel/config.ts`）

- **接入**：`<PDFViewer src={...} style={{ height: '100vh' }}>`，React 封装的是 `<embedpdf-viewer>` 自定义元素（component.ts:218-234）。主入口 `@embedpdf/viewer-react`（index.ts:20-31）默认带本地 PDFium 引擎（wasm worker），**必填 props 实际上只有 src 类配置**，`engine` 可不传；`@embedpdf/viewer-react/core` 入口则必须注入 engine（core.ts:12-15）。
- **src 支持 URL 字符串、`File`/任意 `Blob`、`ArrayBuffer`、`Uint8Array`**：`DocumentSrc = string | Blob | ArrayBuffer | Uint8Array`（config.ts:19-20；`src?: Src | null`，另一值就在原位换开、null 关闭，config.ts:41-43）。判定逻辑 config.ts:158-163。
- **live props**（运行中跟随变更）：`src/theme/locale/features/disable/readOnly/fetch/appState`（component.ts:108-118）；其余 config 只在启动读一次，改了会被忽略并 dev 警告，需换 `key` 重挂（component.ts:40-44、120-137）。
- **「文档打开完成」回调**：组件层有 `onReady`（viewer 就绪，拿 `Viewer` 句柄；handle.ts:133-135）与 `onDocumentChange(documentId)`（component.ts:151-153、171-172）；单条文档打开完成的精准信号是 `viewer.documents.open(source)` 的 Promise（「resolves `{ document }` once it's ready, or locked with a password」，`packages/core/main/src/types.ts` DocumentsCapability.open 注释，约 923-931 行）及 documents 能力的 onOpened 事件。**没有单独的「文档打开完成」prop**，惯用法是 onReady 拿 viewer 再走 documents.open。

---

# B 组：Docling（官方文档/源码 primary source）

## B1. DoclingDocument 的 provenance 与粒度

### 确认的事实

**正文段落/标题/表格条目都带 provenance**：`DocItem.prov: list[ProvenanceItem]`（`docling_core/types/doc/items/node.py` DocItem 基类，约 91 行起）。`ProvenanceItem`（`docling_core/types/doc/common/reference.py`）：

```python
class ProvenanceItem(BaseModel):
    page_no: Annotated[int, ...]   # 页号
    bbox: Annotated[BoundingBox, ...]  # BoundingBox(l,t,r,b, coord_origin 默认 TOPLEFT)
    charspan: CharSpan              # (start, end) 元组，0 索引字符区间
```

`CharSpan = Annotated[tuple[int, int], Field(description="Character span (0-indexed)")]`（`docling_core/types/doc/common/scalars.py`）。`BoundingBox` 字段 l/t/r/b + `coord_origin`（TOPLEFT/BOTTOMLEFT），文档式导出时坐标经精度上下文取整（`docling_core/types/doc/base.py` BoundingBox 类）。

**粒度是 block 级**：prov 挂在 DocItem（段落/标题/表格/图片等块）上，**不是 word/char 级**；没有逐 word/char 的 provenance 数组。

**charspan 是文档级（0 索引，跨页连续）**：由 pipeline 的 ReadingOrderModel 填充（`docling/models/stages/reading_order/readingorder_model.py`），典型写法 `charspan=(0, len(text))`（该文件 127、233、848 行等多处）或子元素段 `charspan=(start, len)`——即从条目文本自身长度的文档级偏移，不是页内文字层索引，也**不直接映射回 PDF 原生字符级文字层**（映射需经页内 cells 的文本/bbox 自行对齐；见「推断/未验证」）。表格单元格另有 `TableCell.bbox`（B1 末尾 B3 一并说）。

### 推断/未验证

- charspan→PDF 原生 text layer 的精确字符对齐：官方未提供直接 API；两套索引体系（Docling 文档级 charspan vs 后端逐 cell 文本）需自行用 bbox 对齐验证。
- 旧版本 charspan 语义曾为页内；以 v2.106+（docling-slim 2.150.1 依赖 docling-core>=2.106.0）源码为准。

## B2. 标题层级与中文编号

### 确认的事实

**层级表达**：`SectionHeaderItem(TextItem)` 有 `level: LevelNumber`（`docling_core/types/doc/items/text.py`），LevelNumber 为 1..100（scalars.py）。

**层级来源**：布局模型本身只给 SECTION_HEADER 标签**不给层级**，PDF 路径默认全部 level=1（`docling/models/stages/heading_hierarchy/heading_hierarchy_model.py` 模块 docstring 明确）。2.150 版新增 HeadingHierarchyModel：按优先级 (1) PDF 书签/大纲 (2) 编号（`PART I → 1. → 1.1 → (a) → (i)` 等法定编号）(3) 字体样式（字号→粗细→斜体→大小写）推断层级；**默认关闭**（`PdfPipelineOptions.heading_hierarchy_options` 字段说明「Disabled by default; when enabled…assigns SectionHeaderItem.level instead of leaving every heading at level 1」，`docling/datamodel/pipeline_options.py` 约 2347-2357 行）。

**中文合同编号**：编号家族与正则（heading_hierarchy_model.py 53-100 行）为西式：part/chapter/article/section/clause/annex/appendix/rule、罗马、阿拉伯点分、alpha；**没有「第一条」「（一）」「1.1 之外的中文序号」家族**。即：若打开 heading_hierarchy，1.1 这类点分阿拉伯编号可被识别；「第 X 条/（一）」需自己按文本正则拆分层级（或保持默认关闭、全部 level=1 后自行解析）。对中文合同，实际可用信号是字体样式（加粗/字号）与自定义文本匹配。

## B3. 表格输出

### 确认的事实

- **模型**：默认表格结构引擎是 TableFormer（`docling/models/stages/table_structure/table_structure_model.py`：`_model_path = "model_artifacts/tableformer"`，`TableFormerMode.FAST/ACCURATE` 两档，`pipeline_options.py` TableFormerMode 枚举注释：FAST 重速度、ACCURATE 重质量）。备选 Granite Vision VLM 表格模型（`plugins/defaults.py` table_structure_engines 列表：TableStructureModel、TableStructureModelV2、GraniteVisionTableStructureModel）。`do_table_structure` 默认 True（pipeline_options.py 约 2205-2214 行）。
- **导出**：`TableItem.export_to_dataframe(doc) → pd.DataFrame` 与 `export_to_markdown(doc)`（`docling_core/types/doc/items/table/table.py` TableItem 方法）；整文档 `DoclingDocument.export_to_markdown()`（README Quickstart）。
- **单元格带坐标**：`TableCell` 有 `bbox: BoundingBox | None`（`docling_core/types/doc/items/table/table_data.py` TableCell 类，字段表：bbox/row_span/col_span/start_row_offset_idx/end_row_offset_idx/start_col_offset_idx/end_col_offset_idx/text/column_header/row_header/row_section/fillable）。即**结构化导出（JSON/损失式）保留每 cell bbox；markdown/DataFrame 导出则只剩文本**。表格本体另有 TableItem 的 prov（页号+bbox+charspan）。

## B4. 纯文字 PDF 免 OCR、中文、确定性

### 确认的事实

- **do_ocr 默认 True**（`pipeline_options.py` 约 2205-2214 行），但 **OCR 只跑「无文字层的区域」**：默认 OcrMode.DEFAULT = PDF_AWARE_LAYOUT_REGIONS（pipeline_options.py OcrMode 枚举），基类 BaseOcrModel `_find_pdf_aware_layout_ocr_rects` 只挑「与 bitmap 重叠的 cluster / 无字符内容的 cluster」（`docling/models/base_ocr_model.py` 394-498 行区域，`has_content_in(chars=False, bitmaps=True)` 判断）。纯文字页 OCR 不会被实际执行。
- **完全免 OCR/免下 OCR 模型**：设 `do_ocr=False` 即彻底不建 OCR 引擎。标准安装含 OCR 依赖（docling meta 包 = `docling-slim[standard]`，其中 feat-ocr-rapidocr → rapidocr+onnxruntime，`pyproject.toml`）；OCR 模型权重本身按需从 HF 下载（auto 引擎偏好 rapidocr-onnxruntime，`docling/models/stages/ocr/auto_ocr_model.py` 127-159 行）。也可装 docling-slim 的精简 extras 避开 OCR 依赖。
- **中文**：本地布局模型（DocLayNet 家族）与 TableFormer 对中文文档可用（官方支持多种语言文档；技术报告用 DocLayNet 数据集含中文样本），中文文本抽取走 PDF 原生文字层无语言依赖；中文 OCR 需给 OCR 引擎传语言参数（OcrOptions.lang，BCP-47 或引擎原生码如 ch）。
- **确定性**：同一文件两次解析，布局模型为确定性前向推理（无采样），阅读顺序/装配规则确定 → **预期输出确定**；官方文档无逐字「确定性保证」表述（见「推断/未验证」）。模型权重与版本固定、无 GPU 非确定性算子时输出应可复现。

### 推断/未验证

- 「两次解析 bit 级一致」：官方无显式承诺；建议对同一 PDF 跑两次比对导出 JSON 作回归验证。
- 中文标点在抽取文本中的表示（全角保留）未经实测。

## B5. 版本、依赖量级、CPU 性能

### 确认的事实

- **当前版本**：docling 2.150.1（`packages/docling/pyproject.toml` version 字段；GitHub release v2.150.1，2026-11-14 发布）。Python 要求 >=3.10,<4.0（pyproject.toml）。docling 包现在拆为 docling-slim（本体，最小 8 个依赖，约 50MB）+ docling meta（standard extras 合集）；`pip install docling` 默认装 standard（含本地模型 torch/docling-ibm-models/rapidocr/office/web 解析等）。核心依赖链：pydantic、docling-core>=2.106、torch、torchvision、docling-ibm-models、accelerate、pypdfium2、docling-parse、numpy、pillow、rtree、scipy、rapidocr、onnxruntime 等（`pyproject.toml` dependencies 与 extras）。
- **纯 CPU 吞吐（官方技术报告 Table 1，OCR 关闭、标准模型管线、225 页测试集）**（arXiv:2408.09869v5）：
  - Apple M3 Max（16 核）：native backend 4 线程 1.27 pages/s（177s），16 线程 1.34；pypdfium backend 4 线程 2.18 pages/s，16 线程 2.45。峰值内存 2.4–6.2 GB。
  - Intel Xeon E5-2690（16 核）：native 4 线程 0.60 pages/s，16 线程 0.92；pypdfium 4 线程 0.94，16 线程 1.57。内存约 2.4–6.2 GB。
  - EasyOCR 在 CPU 上可达 30 秒/页（报告 §3.2）——OCR 对纯文字 PDF 关掉（见 B4）可完全避开。
- 即：**纯 CPU 量级约 0.6–2.5 pages/s**（CPU 型号与线程数而定），开启 OCR 显著变慢。

---

# 汇总速查

| 问题 | 一行结论 |
|---|---|
| A1 | 有：onChanged/onCommitted(手势结束才发)/onCleared，载荷 TextRange（页内字符半开区间，anchor/focus 表达跨页）；rects/文本从 getSnapshot/listRects/readText 补 |
| A2 | SearchHit{page,pageIndex,start,count,segments,bounds?,snippet?}；字符区间=页内索引；bounds=页空间分段 AABB 并集 |
| A3 | fold v2 归一化（忽略不可见字符、空白折叠为单空格、NFKD、去标记、大小写折叠）；逐页匹配、跨页文本不命中；ignoreWhitespace 可跨任意空白 |
| A4 | 每选中页一条标注：Annotation{ref,page,rect,quadPoints(/QuadPoints),color,...}，不存字符区间；annotations.export/import + AnnotationTransfer JSON 可持久化恢复 |
| A5 | <PDFViewer src=URL|File|Blob|ArrayBuffer|Uint8Array>；src 等 8 个 live props 跟随变更，其余一次性；文档打开完成=viewer.documents.open() 的 Promise（无专属 prop 回调） |
| B1 | DocItem.prov=[ProvenanceItem{page_no,bbox(ltrb),charspan(文档级 0 索引)}]；block 级粒度，无 word/char 级 provenance；charspan 不直接映射 PDF 文字层 |
| B2 | SectionHeaderItem.level(1..100)；布局模型不给层级（默认全 level=1）；2.150 HeadingHierarchyModel（默认关）从书签>西式编号>样式推层级；中文「第一条/（一）」编号不在内置家族，需自行解析 |
| B3 | TableFormer 默认（FAST/ACCURATE），可选 Granite Vision；export_to_markdown/DataFrame；TableCell 带 bbox（JSON 保留坐标，MD/DataFrame 只剩文本）；表格本体另有 prov |
| B4 | do_ocr 默认 True 但 PDF-aware 只 OCR 无文字层区域（纯文字页不实际执行）；do_ocr=False 完全免 OCR 与其模型下载；中文文本层无语言依赖；确定性预期成立但官方无逐字承诺 |
| B5 | 当前 2.150.1（Py ≥3.10）；docling-slim 最小 8 依赖 ~50MB，standard 含 torch 全家（GB 级）；纯 CPU 约 0.6–2.5 pages/s（官方报告：M3 Max 1.27–2.45，Xeon 0.60–1.57，OCR 关） |

# 主要来源清单

**EmbedPDF（本地路径均相对 `_work/embed-pdf-viewer/`）**：
- `packages/plugin/selection/src/contract.ts`（SelectionCapability/事件/TextRange/SelectionRangeInput）
- `packages/plugin/selection/src/model.ts`（GlyphPosition/SelectionRange/跨页）
- `packages/plugin/selection/src/controller.ts`（readText 分页切片、endGesture→committed）
- `packages/plugin/selection/src/geometry.ts`、`state.ts`、`selection.plugin.ts`
- `packages/plugin/search/src/contract.ts`（SearchHit/findAll/snippets）
- `packages/plugin/search/src/controller.ts`（hitsFromSlice bounds）
- `packages/engine/core/src/search/{types,fold,literal,matcher,canonicalQuery}.ts`
- `packages/engine/services/src/features/search/SearchReader.ts`（逐页匹配循环）
- `packages/plugin/annotation/src/contract.ts`（createFromSelection/export/import）
- `packages/plugin/annotation/src/write/markup.ts`（createFromSelection 实现）
- `packages/engine/core/src/annotation/kinds/shared-fields.ts`、`items/table/*`；`transfer/AnnotationTransfer.ts`
- `packages/viewer/react/src/{component,index,core}.ts`；`packages/viewer/main/src/kernel/config.ts`；`packages/core/main/src/types.ts`（DocumentsCapability.open）

**Docling（官方）**：
- https://github.com/docling-project/docling（README、pyproject.toml、docling/ 下源码）
- https://github.com/docling-project/docling-core（docling_core/types/doc/ 下模型源码）
- https://arxiv.org/abs/2408.09869 及 v5 HTML（技术报告、性能表）
- https://pypi.org/project/docling/（版本页）
