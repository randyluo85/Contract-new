# 锚点主键：页 + 字符区间 + exactText，不持久化渲染矩形

Docling 的 bbox 坐标系与 EmbedPDF 的文字层坐标系不保证一致，渲染矩形又随缩放与视图变化。锚点唯一持久化的定位信息定为 PDF 文字层坐标系的 `{page, charStart, charCount}` 加读回文本 `exactText`；矩形由 viewer 渲染时现算，不进库。重新打开文件的恢复路径：在该页用 exactText 重搜并 readText 比对，一致则恢复「已关联」，不一致降级「待确认」。
