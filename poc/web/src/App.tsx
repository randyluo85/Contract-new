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

function Tree({ clauses, onPick, activeId }: { clauses: Clause[]; onPick: (c: Clause) => void; activeId: string | null }) {
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
        <Node key={c.id} c={c} byParent={byParent} depth={0} onPick={onPick} activeId={activeId} />
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
}: {
  c: Clause;
  byParent: Map<string | null, Clause[]>;
  depth: number;
  onPick: (c: Clause) => void;
  activeId: string | null;
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
      </div>
      {children.map((ch) => (
        <Node key={ch.id} c={ch} byParent={byParent} depth={depth + 1} onPick={onPick} activeId={activeId} />
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
    setPdfSrc(`/api/documents/${d.document.id}/file`);
    void tryGenerate();
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
          </>
        )}
        {error && <span className="error">{error}</span>}
      </header>
      <main>
        <aside>
          {notice && <div className="notice">{notice}</div>}
          {locating && <div className="locating">锚点核验：{locating}</div>}
          <Tree clauses={clauses} onPick={onPick} activeId={activeId} />
          {readback && (
            <div className="readback">
              <span>从 PDF 读回的原文</span>
              <blockquote>{readback}</blockquote>
            </div>
          )}
          {reverseInfo?.kind === 'none' && (
            <div className="reverse-none">所选文字不属于任何条款（页眉/封面等）</div>
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
                // T4 反向定位：订阅 selection.onCommitted（EventHook 是函数本身：listener → Unsubscribe）。
                const sel = viewer.tryGet('selection');
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
