import { useEffect, useRef, useState } from 'react';
import { PDFViewer } from '@embedpdf/viewer-react';

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

function Tree({ clauses }: { clauses: Clause[] }) {
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
        <Node key={c.id} c={c} byParent={byParent} depth={0} />
      ))}
    </div>
  );
}

function Node({
  c,
  byParent,
  depth,
}: {
  c: Clause;
  byParent: Map<string | null, Clause[]>;
  depth: number;
}) {
  const children = byParent.get(c.id) ?? [];
  const badge = BADGE[clauseState(c)];
  return (
    <div style={{ paddingLeft: 4 + depth * 16 }}>
      <div className="node-line">
        <span className="num">{c.number}</span>
        <span className="title" title={c.title}>{c.title}</span>
        {c.suspicious && <span className="badge suspect" title="可疑节点（Q24 五规则自检命中）">⚠</span>}
        <span className={badge.cls}>{badge.text}</span>
      </div>
      {children.map((ch) => (
        <Node key={ch.id} c={ch} byParent={byParent} depth={depth + 1} />
      ))}
    </div>
  );
}

export function App() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [pdfSrc, setPdfSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  function applyDoc(d: { document: Doc; clauses: Clause[]; notice?: string | null }) {
    setDoc(d.document);
    setClauses(d.clauses);
    setNotice(d.notice ?? null);
    setPdfSrc(`/api/documents/${d.document.id}/file`);
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
          <Tree clauses={clauses} />
        </aside>
        <section>
          {pdfSrc ? (
            <PDFViewer key={pdfSrc} src={pdfSrc} style={{ height: '100%', display: 'block' }} />
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
