import { useEffect, useRef, useState } from 'react';
import { PDFViewer } from '@embedpdf/viewer-react';
import type { Viewer } from '@embedpdf/viewer-react';
import type { SearchHit } from '@embedpdf/plugin-search/contract';
import { anchorsForClause } from './locate';
import { reverseLocate, spansOfRange, type ReverseAnchor, type ReverseCandidate } from './reverse';

interface Anchor {
  id: string;
  page: number;
  charStart: number;
  charCount: number;
  exactText: string | null;
  status: string;
}

interface Clause {
  id: string;
  parentId: string | null;
  number: string;
  title: string;
  content: string | null;
  sortOrder: number;
  suspicious: boolean;
  anchors: Anchor[];
}

interface Doc {
  id: string;
  fileName: string;
  pageCount: number | null;
  parseStatus: 'parsing' | 'done' | 'failed';
}

const STATUS_TEXT: Record<string, string> = {
  parsing: '解析中…',
  done: '解析完成',
  failed: '解析失败',
};

/** 定位三态（GLOSSARY）：无锚点=未定位；有已确认锚点=已关联；否则=待确认。 */
function clauseState(c: Clause): 'linked' | 'pending' | 'unlocated' {
  if (c.anchors.length === 0) return 'unlocated';
  if (c.anchors.some((a) => a.status === 'linked')) return 'linked';
  return 'pending';
}

const BADGE: Record<string, { text: string; cls: string }> = {
  linked: { text: '已关联', cls: 'badge linked' },
  pending: { text: '待确认', cls: 'badge pending' },
  unlocated: { text: '未定位', cls: 'badge unlocated' },
};

function Tree({ clauses, onPick, activeId, onConfirm }: { clauses: Clause[]; onPick: (c: Clause) => void; activeId: string | null; onConfirm: (c: Clause) => void }) {
  const byParent = new Map<string | null, Clause[]>();
  for (const c of clauses) {
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  const roots = byParent.get(null) ?? [];
  if (roots.length === 0) {
    return <div className="placeholder" style={{ height: 200 }}>上传后这里会出现条款树</div>;
  }
  return (
    <div className="tree">
      {roots.map((c) => (
        <Node key={c.id} c={c} byParent={byParent} depth={0} onPick={onPick} activeId={activeId} onConfirm={onConfirm} />
      ))}
    </div>
  );
}

function Node({
  c,
  byParent,
  depth,
  onPick,
  activeId,
  onConfirm,
}: {
  c: Clause;
  byParent: Map<string | null, Clause[]>;
  depth: number;
  onPick: (c: Clause) => void;
  activeId: string | null;
  onConfirm: (c: Clause) => void;
}) {
  const children = byParent.get(c.id) ?? [];
  const badge = BADGE[clauseState(c)];
  const clickable = c.anchors.length > 0;
  return (
    <div style={{ paddingLeft: 4 + depth * 16 }}>
      <div
        className={`node-line ${clickable ? 'clickable' : ''} ${activeId === c.id ? 'active' : ''}`}
        onClick={clickable ? () => onPick(c) : undefined}
      >
        <span className="num">{c.number}</span>
        <span className="title" title={c.title}>{c.title}</span>
        {c.suspicious && <span className="badge suspect" title="可疑节点（Q24 五规则自检命中）">⚠</span>}
        <span className={badge.cls}>{badge.text}</span>
        {badge === BADGE.pending && (
          <button
            className="confirm-btn"
            title="确认该条款的锚点（待确认→已关联）"
            onClick={(e) => { e.stopPropagation(); onConfirm(c); }}
          >确认</button>
        )}
      </div>
      {children.map((ch) => (
        <Node key={ch.id} c={ch} byParent={byParent} depth={depth + 1} onPick={onPick} activeId={activeId} onConfirm={onConfirm} />
      ))}
    </div>
  );
}

export function App() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const elRef = useRef<HTMLElement | null>(null); // <embedpdf-viewer> 底层元素（imperative surface）
  const genRunningRef = useRef(false);
  const docRef = useRef<Doc | null>(null);
  const clausesRef = useRef<Clause[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [pdfSrc, setPdfSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [readback, setReadback] = useState<string | null>(null);
  const [locating, setLocating] = useState<string | null>(null);
  const [reverseInfo, setReverseInfo] = useState<
    | { kind: 'none' }
    | { kind: 'candidates'; candidates: ReverseCandidate[]; selectedText: string }
  | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    spans: { page: number; start: number; end: number }[];
    text: string;
  } | null>(null); // 当前用户选区（onChanged 实时快照——绑定时用）
  const [bindingMsg, setBindingMsg] = useState<string | null>(null); // 绑定/确认操作反馈

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function capsOf() {
    // el.viewer 是权威实例；文档打开完成前插件未注册 → 同步 null（调用方需重试）
    const viewer = getViewerFromElement() ?? viewerRef.current;
    if (!viewer) return null;
    const search = viewer.tryGet('search');
    const selection = viewer.tryGet('selection');
    const stage = viewer.tryGet('stage');
    if (!search || !selection || !stage) return null;
    return { search, selection, stage };
  }

  /** 带重试的 caps（插件在文档打开后才注册，最多等 ~15s）。 */
  async function capsAwait(): Promise<ReturnType<typeof capsOf>> {
    for (let i = 0; i < 50; i++) {
      const caps = capsOf();
      if (caps) return caps;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  /** 从 <embedpdf-viewer> 元素取 viewer 实例（绕开 onReady 竞态的稳健通道）。 */
  function getViewerFromElement(): Viewer | null {
    const els = document.querySelectorAll('embedpdf-viewer');
    for (const el of Array.from(els)) {
      const v = (el as unknown as Record<string, unknown>).viewer;
      if (v) return v as Viewer;
    }
    return null;
  }

  function applyDoc(d: { document: Doc; clauses: Clause[]; notice?: string | null }) {
    docRef.current = d.document;
    clausesRef.current = d.clauses;
    setDoc(d.document);
    setClauses(d.clauses);
    setNotice(d.notice ?? null);
    setActiveId(null);
    setReadback(null);
    setBindingMsg(null);
    setPendingSelection(null);
    setPdfSrc(`/api/documents/${d.document.id}/file`);
    void tryGenerate();
    // T5 重开恢复：对已有关联（linked 且有区间）的锚点跑核验重算——
    // 失败降「待确认」并列入待办清单（核验= exactText 页内重搜读回比对，Q19 纯锚点驱动）
    void reverifyAnchors(d.document.id, d.clauses);
  }

  /** T5 恢复核验：linked 锚点重搜比对；失败→降 pending + 待办清单。 */
  async function reverifyAnchors(documentId: string, list: Clause[]) {
    const caps = await capsAwait();
    if (!caps) return;
    const failed: string[] = [];
    for (const c of list) {
      for (const a of c.anchors) {
        if (a.status !== 'linked' || a.charCount === 0 || !a.exactText) continue;
        try {
          const hits = (await caps.search.findAll({ text: a.exactText, wholeWord: false })) as readonly SearchHit[];
          const onPage = hits.filter((h) => h.pageIndex === a.page);
          if (!onPage.length) {
            failed.push(c.id);
            await fetch(`/api/anchors/${a.id}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ status: 'pending' }),
            }).catch(() => {});
          }
        } catch {
          failed.push(c.id);
        }
      }
    }
    if (failed.length) {
      const d = await fetch(`/api/documents/${documentId}`).then((r) => r.json());
      setClauses(d.clauses);
      clausesRef.current = d.clauses;
      setBindingMsg(`重开核验：${failed.length} 个锚点失效已降级「待确认」，请重新绑定`);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    stopPolling();
    setError(null);
    setClauses([]);
    setPdfSrc(null);
    setDoc({ id: '', fileName: file.name, pageCount: null, parseStatus: 'parsing' });
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/parse', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || `上传失败 ${res.status}`);

      if (j.parseStatus === 'done') {
        // fileHash 幂等命中已解析文档：直接载入
        const d = await fetch(`/api/documents/${j.documentId}`).then((r) => r.json());
        applyDoc(d);
      } else {
        setDoc((prev) => (prev ? { ...prev, id: j.documentId } : prev));
        timerRef.current = setInterval(async () => {
          try {
            const d = await fetch(`/api/documents/${j.documentId}`).then((r) => r.json());
            if (d.document.parseStatus === 'done') {
              stopPolling();
              applyDoc(d);
            } else if (d.document.parseStatus === 'failed') {
              stopPolling();
              setDoc(d.document);
              setError('解析失败：后端解析任务异常');
            }
          } catch {
            /* 单轮轮询失败，下一轮重试 */
          }
        }, 700);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDoc(null);
    } finally {
      e.target.value = '';
    }
  }

  /** 文档就绪后触发候选生成：轮询等待 viewer + clauses 就绪（避免 onReady/渲染竞速）。 */
  async function tryGenerate() {
    if (genRunningRef.current) return;
    for (let i = 0; i < 90; i++) {
      const target = docRef.current;
      const list = clausesRef.current;
      if (target && target.parseStatus === 'done' && list.length > 0 && viewerRef.current) {
        const pending = list.filter(
          (c) => c.anchors.length === 0 &&
            ((c.content ?? '').trim() || (c.number || c.title || '').trim()),
        );
        if (pending.length > 0) {
          await generateAnchors(target.id, pending);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** T3 候选生成：对无锚点条款跑两窗口核验并落锚点。 */
  async function generateAnchors(documentId: string, pending: Clause[]) {
    if (genRunningRef.current) return;
    genRunningRef.current = true;
    try {
      const caps = await capsAwait();
      if (!caps) return;
      const viewerCaps = {
        findAll: (o: { text: string }) => caps.search.findAll({ text: o.text, wholeWord: false }) as Promise<readonly SearchHit[]>,
        select: (r: { page: SearchHit['page']; start: number; count: number }) => caps.selection.select(r),
        readText: () => caps.selection.readText(),
        reveal: (p: SearchHit['page'], o: any) => caps.stage.reveal(p, o),
      };
      for (const c of pending) {
        try {
        // 候选段：标题行（编号+标题，PDF 里真实相邻）与正文**分段**滑窗——
        // 不拼接（拼接空格在 PDF 不存在会让首窗失配）；纯标题节点也有标题窗可锚
        const head = [c.number, c.title].filter(Boolean).join(' ').trim();
        const body = (c.content ?? '').trim();
        const segments = [head, body].filter(Boolean);
        if (!segments.length) continue;
        setLocating(`${c.number || c.title} 正在核验…`);
        const verdict = await anchorsForClause(viewerCaps, segments);
        if (verdict === 'ambiguous') {
          // 歧义铁律：停待确认（写入 pending 锚点占位：无区间，仅状态）
          await fetch(`/api/clauses/${c.id}/anchors`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anchors: [{ page: 0, charStart: 0, charCount: 0, exactText: '', status: 'pending' }] }),
          }).catch(() => {});
        } else if (verdict && verdict.length) {
          // 多窗口锚点：整条款覆盖（每窗一个锚点，全部唯一命中）
          await fetch(`/api/clauses/${c.id}/anchors`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              anchors: verdict.map((a) => ({
                page: a.pageIndex, // 0 基 pageIndex 存库（onPick 与 SearchHit 同基）
                charStart: a.charStart,
                charCount: a.charCount,
                exactText: a.exactText,
                status: 'linked',
              })),
            }),
          }).catch(() => {});
        }
        // null → 未定位：不写锚点
        } catch (err) {
          console.warn('[t3] clause anchor failed:', c.number || c.title, err);
          // 单条款失败不阻断整体生成
        }
      }
    } finally {
      genRunningRef.current = false;
      setLocating(null);
      // 核验完成后刷新条款树（拉取最新锚点状态）
      const d = await fetch(`/api/documents/${documentId}`).then((r) => r.json());
      setClauses(d.clauses);
    }
  }

  /** 正向定位：点击条款 → 跳页 + 选中高亮 + 读回显示。 */
  async function onPick(c: Clause) {

    setActiveId(c.id); // 先置选中态（caps 不可用时也保持视觉反馈）
    setReadback(null);
    const caps = await capsAwait();
    if (!caps || c.anchors.length === 0) return;
    const anchor = c.anchors.find((a) => a.status === 'linked') ?? c.anchors[0];
    if (anchor.charCount === 0) return; // 歧义占位锚点不可定位
    setActiveId(c.id);
    setReadback(null);
    try {
      // 用 exactText 在该页内重搜核验（ADR-0001 恢复路径），取该页命中
      const hits = (await caps.search.findAll({ text: anchor.exactText ?? '', wholeWord: false })) as readonly SearchHit[];
      const onPage = hits.filter((h) => h.pageIndex === anchor.page); // anchor.page 存 0 基 pageIndex（与 SearchHit.pageIndex 同基）
      const hit = onPage.find((h) => h.start === anchor.charStart) ?? onPage[0];
      if (!hit) return;
      caps.stage.reveal(hit.page, {
        rect: hit.bounds,
        zoom: 'keep',
        align: { y: 0.35 },
        behavior: 'smooth',
      });
      caps.selection.select({ page: hit.page, start: hit.start, count: hit.count });
      try {
        const t = await caps.selection.readText();
        setReadback(t);
      } catch {
        setReadback(anchor.exactText);
      }
    } catch {
      /* 核验失败保持已关联态显示，读回为空 */
    }
  }

  /** T4 反向定位：用户拖选结束（onCommitted 仅手势触发）→ 与锚点求交。 */
  async function onSelectionCommitted(range: {
    start: { page: unknown; index?: number };
    end: { page: unknown; index?: number };
  }) {
    setReverseInfo(null);
    const caps = await capsAwait();
    if (!caps) return;
    // 锚点集合（当前文档全部条款的锚点，charCount>0 才参与）
    const anchors: ReverseAnchor[] = [];
    for (const c of clauses) {
      for (const a of c.anchors) {
        anchors.push({ clauseId: c.id, page: a.page, charStart: a.charStart, charCount: a.charCount });
      }
    }
    const spans = spansOfRange(range as Parameters<typeof spansOfRange>[0]);
    const verdict = reverseLocate(spans, anchors);
    if (verdict.kind === 'unique') {
      // 唯一且占比高：左树自动选中并展开（复用正向 onPick 的视觉反馈）
      const target = clauses.find((c) => c.id === verdict.clauseId);
      if (target) {
        await onPick(target);
        setReverseInfo(null);
      }
    } else if (verdict.kind === 'ambiguous') {
      // 歧义：读回选中文本供参考，列候选条款供确认
      let selectedText = '';
      try {
        selectedText = await caps.selection.readText();
      } catch {
        selectedText = '';
      }
      setReverseInfo({ kind: 'candidates', candidates: verdict.candidates, selectedText });
    } else {
      setReverseInfo({ kind: 'none' }); // 无对应（页眉/封面）——空提示
    }
  }

  /** T5 人工绑定：左选中条款 + 右选区 → 关联当前条款（整组替换保存）。 */
  async function bindCurrentSelection() {
    const target = clauses.find((c) => c.id === activeId);
    if (!target) {
      setBindingMsg('先在左侧选中一个条款');
      return;
    }
    if (!pendingSelection || pendingSelection.spans.length === 0) {
      setBindingMsg('先在右侧 PDF 中选中一段原文');
      return;
    }
    const caps = await capsAwait();
    if (!caps) {
      setBindingMsg('PDF 引擎未就绪');
      return;
    }
    // 读回选中文本（exactText 优先用真实读回；失败用空串仅存区间）
    let text = '';
    try {
      text = await caps.selection.readText();
    } catch {
      text = '';
    }
    const anchors = pendingSelection.spans
      .filter((s) => Number.isFinite(s.end) && s.end > s.start)
      .map((s) => ({
        page: s.page,
        charStart: s.start,
        charCount: s.end - s.start,
        exactText: text,
        status: 'linked',
        source: 'manual', // T6：人工绑定锚点重解析保留
      }));
    if (anchors.length === 0) {
      setBindingMsg('选区无效（跨页中段无法精确定位，请分段绑定）');
      return;
    }
    const res = await fetch(`/api/clauses/${target.id}/anchors`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchors }),
    });
    if (!res.ok) {
      setBindingMsg('保存失败：' + res.status);
      return;
    }
    // 刷新树（拉最新锚点）并给反馈
    const d = await fetch(`/api/documents/${doc!.id}`).then((r) => r.json());
    setClauses(d.clauses);
    clausesRef.current = d.clauses;
    setBindingMsg(`已绑定 ${target.number || target.title}（${anchors.length} 锚点）`);
    setPendingSelection(null);
  }

  /** T5 确认动作：待确认条款 → 已关联（首个 pending 锚点翻 linked）。 */
  async function confirmClause(c: Clause) {
    const a = c.anchors.find((x) => x.status === 'pending' && x.charCount > 0);
    if (!a) {
      setBindingMsg('该条款没有可确认的锚点（先人工绑定原文）');
      return;
    }
    const res = await fetch(`/api/anchors/${a.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'linked' }),
    });
    if (res.ok) {
      const d = await fetch(`/api/documents/${doc!.id}`).then((r) => r.json());
      setClauses(d.clauses);
      clausesRef.current = d.clauses;
      setBindingMsg(`已确认 ${c.number || c.title}`);
    }
  }

  /** T6 重新解析：警示（树编辑丢弃/人工锚点保留）确认后重跑。 */
  async function onReparse() {
    if (!doc) return;
    const ok = window.confirm(
      '重新解析将：\n• 重建整棵条款树（人工树编辑将被丢弃）\n• 自动锚点全部重来\n• 人工绑定的锚点尽量保留（按条款编号+标题对回，对不上的进失效清单）\n\n继续？',
    );
    if (!ok) return;
    setBindingMsg('重新解析中…（原文件重新拆分，人工锚点将尽量保留）');
    const res = await fetch(`/api/documents/${doc.id}/reparse`, { method: 'POST' });
    if (!res.ok) {
      setBindingMsg('重解析启动失败');
      return;
    }
    // 轮询到 done 后重载文档（复用现有轮询模式）
    const timer = setInterval(async () => {
      try {
        const d = await fetch(`/api/documents/${doc.id}`).then((r) => r.json());
        if (d.document.parseStatus === 'done') {
          clearInterval(timer);
          applyDoc(d);
          const lost = d.document.reparseLost ? JSON.parse(d.document.reparseLost) : [];
          setBindingMsg(
            lost.length
              ? `重解析完成：人工锚点已尽量保留；${lost.length} 个锚点失效（${lost.map((l: { number: string; title: string }) => l.number || l.title).join('、')}），请重新绑定`
              : '重解析完成：人工锚点已保留',
          );
        } else if (d.document.parseStatus === 'failed') {
          clearInterval(timer);
          setBindingMsg('重解析失败');
        }
      } catch {
        /* 下一轮重试 */
      }
    }, 1000);
  }

  return (
    <>
      <header className="topbar">
        <label className="upload-btn">
          上传 PDF
          <input type="file" accept="application/pdf" onChange={onFile} hidden />
        </label>
        {doc && (
          <>
            <span className="doc-name">{doc.fileName}</span>
            <span className="doc-pages">{doc.pageCount ?? '…'} 页</span>
            <span className={`status-${doc.parseStatus}`}>{STATUS_TEXT[doc.parseStatus]}</span>
            {doc.parseStatus === 'done' && (
              <button className="reparse-btn" onClick={() => void onReparse()}>重新解析</button>
            )}
          </>
        )}
        {error && <span className="error">{error}</span>}
      </header>
      <main>
        <aside>
          {notice && <div className="notice">{notice}</div>}
          {locating && <div className="locating">锚点核验：{locating}</div>}
          <Tree clauses={clauses} onPick={onPick} activeId={activeId} onConfirm={(c) => void confirmClause(c)} />
          {readback && (
            <div className="readback">
              <span>从 PDF 读回的原文</span>
              <blockquote>{readback}</blockquote>
            </div>
          )}
          {reverseInfo?.kind === 'none' && (
            <div className="reverse-none">所选文字不属于任何条款（页眉/封面等）</div>
          )}
          {/* T5 人工绑定操作条 */}
          {doc && doc.parseStatus === 'done' && (
            <div className="bind-bar">
              <button
                className="bind-btn"
                onClick={() => void bindCurrentSelection()}
                disabled={!activeId || !pendingSelection}
                title="左侧选中条款 + 右侧选中原文后点击"
              >
                关联当前条款
              </button>
              {pendingSelection && <em>右侧已选 {pendingSelection.spans.length} 段</em>}
              {bindingMsg && <span className="bind-msg">{bindingMsg}</span>}
            </div>
          )}
          {reverseInfo?.kind === 'candidates' && (
            <div className="reverse-candidates">
              <span>该选区命中多个候选条款（重叠排序）：</span>
              <ul>
                {reverseInfo.candidates.slice(0, 6).map((cand) => {
                  const target = clauses.find((c) => c.id === cand.clauseId);
                  return (
                    <li key={cand.clauseId}>
                      <button onClick={() => target && onPick(target)}>
                        {target ? `${target.number || ''} ${target.title}`.trim() : cand.clauseId}
                        <em>重叠 {cand.overlap} 字（{Math.round(cand.ratio * 100)}%）</em>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
        <section>
          {pdfSrc ? (
            <PDFViewer
              key={pdfSrc}
              src={pdfSrc}
              style={{ height: '100%', display: 'block' }}
              elementRef={(el) => { elRef.current = el; }}
              onReady={(viewer) => {
                viewerRef.current = viewer;
                // 文档就绪 + 有条款且大多无锚点 → 触发 T3 候选生成
                void tryGenerate();
                // T4 反向定位 + T5 人工绑定：订阅 selection 事件。
                const sel = viewer.tryGet('selection');
                // onChanged：实时选区快照（绑定流程用——用户可能先选字再点关联按钮）
                if (sel?.onChanged) {
                  sel.onChanged((ev: { range: unknown }) => {
                    const r = ev.range as { start?: unknown; end?: unknown } | null;
                    if (r && r.start && r.end) {
                      try {
                        const spans = spansOfRange(r as Parameters<typeof spansOfRange>[0]);
                        setPendingSelection({ spans, text: '' });
                      } catch {
                        setPendingSelection(null);
                      }
                    } else {
                      setPendingSelection(null);
                    }
                  });
                }
                if (sel?.onCommitted) {
                  const off = sel.onCommitted((ev: { range: unknown }) => {
                    void onSelectionCommitted(ev.range as Parameters<typeof onSelectionCommitted>[0]);
                  });
                  (elRef.current as unknown as Record<string, unknown>).__t4_off_committed = off;
                }
              }}
            />
          ) : (
            <div className="placeholder">
              先上传一份 PDF（可从 poc/samples/ 取样例）
            </div>
          )}
        </section>
      </main>
    </>
  );
}
