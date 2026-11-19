# -*- coding: utf-8 -*-
"""PDF 条款解析与双向定位 POC —— 后端骨架（T1）。

异步解析任务 + fileHash 幂等 + SQLite 三表 + stub 解析器。
接口：POST /parse、GET /documents/{id}、GET /documents/{id}/file、
PUT /clauses/{id}/anchors、PUT /anchors/{id}。
"""
import hashlib
import io
import json
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pypdf import PdfReader

from parser import default_parser
from splitter import audit_suspicious, split_clauses

BASE = Path(__file__).resolve().parent
DATA = BASE.parent / "data"          # poc/data/
PDFS = DATA / "pdfs"
DB = DATA / "app.db"
DATA.mkdir(exist_ok=True)
PDFS.mkdir(exist_ok=True)

app = FastAPI(title="contract-poc-api")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  fileName    TEXT NOT NULL,
  fileHash    TEXT NOT NULL UNIQUE,
  pageCount   INTEGER,
  parseStatus TEXT NOT NULL DEFAULT 'parsing',
  reparseLost TEXT            -- T6：重解析未对回的人工锚点清单（JSON，失败明示）
);
CREATE TABLE IF NOT EXISTS clauses (
  id         TEXT PRIMARY KEY,
  documentId TEXT NOT NULL,
  parentId   TEXT,
  number     TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT,
  sortOrder  INTEGER NOT NULL,
  suspicious INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS anchors (
  id         TEXT PRIMARY KEY,
  clauseId   TEXT NOT NULL,
  documentId TEXT NOT NULL,
  exactText  TEXT,
  page       INTEGER,
  charStart  INTEGER,
  charCount  INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending',
  source     TEXT NOT NULL DEFAULT 'auto'   -- auto=T3 候选生成；manual=T5 人工绑定（重解析保留）
);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    # T2 迁移：T1 旧库 clauses 缺 suspicious 列时补上
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(clauses)")}
    if "suspicious" not in cols:
        conn.execute("ALTER TABLE clauses ADD COLUMN suspicious INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    # T6 迁移：anchors 加 source 列（auto/manual——重解析清 auto 保 manual）
    acols = {r["name"] for r in conn.execute("PRAGMA table_info(anchors)")}
    if "source" not in acols:
        conn.execute("ALTER TABLE anchors ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'")
        conn.commit()
    # T6 迁移：documents 加 reparseLost 列（失效清单 JSON）
    dcols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
    if "reparseLost" not in dcols:
        conn.execute("ALTER TABLE documents ADD COLUMN reparseLost TEXT")
        conn.commit()
    return conn


# ---------------- 解析任务（T2：Parser 接口 + 拆分器 + 五规则自检） ----------------


def run_parse(document_id: str) -> None:
    """后台任务：Parser（默认 Docling，POC_PARSER=stub 可切）→ 拆分 → 自检 → 落库；异常置 failed。"""
    pdf_path = PDFS / f"{document_id}.pdf"
    try:
        blocks = default_parser().parse(str(pdf_path))
        clauses = split_clauses(blocks)
        audit_suspicious(clauses)

        conn = db()
        try:
            order = 0
            stack: list[tuple[int, str]] = []  # (level, id)
            for c in clauses:
                cid = str(uuid.uuid4())
                while stack and stack[-1][0] >= c.level:
                    stack.pop()
                parent_id = stack[-1][1] if stack else None
                conn.execute(
                    "INSERT INTO clauses (id, documentId, parentId, number, title, content, sortOrder, suspicious)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (cid, document_id, parent_id, c.number, c.title, c.content, order,
                     1 if c.suspicious else 0),
                )
                order += 1
                stack.append((c.level, cid))
            conn.execute(
                "UPDATE documents SET parseStatus='done' WHERE id=?", (document_id,)
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        import traceback
        traceback.print_exc()
        conn = db()
        conn.execute(
            "UPDATE documents SET parseStatus='failed' WHERE id=?", (document_id,)
        )
        conn.commit()
        conn.close()


# ---------------- 接口 ----------------


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/parse")
async def parse(file: UploadFile, background: BackgroundTasks):
    data = await file.read()
    if not data:
        raise HTTPException(400, "空文件")
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "只接受 PDF 文件")
    file_hash = hashlib.sha256(data).hexdigest()

    conn = db()
    try:
        row = conn.execute(
            "SELECT id, parseStatus FROM documents WHERE fileHash=?", (file_hash,)
        ).fetchone()
        if row:  # fileHash 幂等：同文件返回同一文档（含已保存的条款树与锚点）
            return {"documentId": row["id"], "parseStatus": row["parseStatus"], "existed": True}

        try:
            pages = len(PdfReader(io.BytesIO(data)).pages)
        except Exception:
            raise HTTPException(422, "无法读取 PDF（损坏或加密）")

        doc_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO documents (id, fileName, fileHash, pageCount, parseStatus)"
            " VALUES (?,?,?,?, 'parsing')",
            (doc_id, file.filename, file_hash, pages),
        )
        conn.commit()
    finally:
        conn.close()

    (PDFS / f"{doc_id}.pdf").write_bytes(data)  # 原件副本，重开恢复用
    background.add_task(run_parse, doc_id)
    return {"documentId": doc_id, "parseStatus": "parsing", "existed": False}


def _clause_rows(conn, document_id):
    rows = conn.execute(
        "SELECT id, parentId, number, title, content, sortOrder, suspicious FROM clauses"
        " WHERE documentId=? ORDER BY sortOrder",
        (document_id,),
    ).fetchall()
    anchors = conn.execute(
        "SELECT id, clauseId, page, charStart, charCount, exactText, status FROM anchors"
        " WHERE documentId=?",
        (document_id,),
    ).fetchall()
    amap: dict = {}
    for a in anchors:
        amap.setdefault(a["clauseId"], []).append(dict(a))
    return [
        {
            "id": r["id"],
            "parentId": r["parentId"],
            "number": r["number"],
            "title": r["title"],
            "content": r["content"],
            "sortOrder": r["sortOrder"],
            "suspicious": bool(r["suspicious"]),
            "anchors": amap.get(r["id"], []),
        }
        for r in rows
    ]


@app.get("/documents/{document_id}")
def get_document(document_id: str):
    conn = db()
    try:
        doc = conn.execute(
            "SELECT id, fileName, pageCount, parseStatus, reparseLost FROM documents WHERE id=?",
            (document_id,),
        ).fetchone()
        if not doc:
            raise HTTPException(404, "文档不存在")
        clauses = _clause_rows(conn, document_id)
        empty_tree = doc["parseStatus"] == "done" and len(clauses) == 0
        return {
            "document": dict(doc),
            "clauses": clauses,
            "notice": ("未提取到任何条款：这份 PDF 没有可提取的文字层（疑似扫描件）。"
                        "本 POC 仅支持文字型 PDF，详见规格 Out of Scope。") if empty_tree else None,
        }
    finally:
        conn.close()


@app.get("/documents/{document_id}/file")
def get_document_file(document_id: str):
    path = PDFS / f"{document_id}.pdf"
    if not path.exists():
        raise HTTPException(404, "原件不存在")
    return FileResponse(path, media_type="application/pdf")


class AnchorIn:
    def __init__(self, payload: dict):
        self.page = int(payload["page"])
        self.charStart = int(payload["charStart"])
        self.charCount = int(payload["charCount"])
        self.exactText = str(payload.get("exactText") or "")
        self.status = str(payload.get("status") or "pending")
        self.source = str(payload.get("source") or "auto")  # T5 人工绑定传 manual；T3 候选生成默认 auto


@app.put("/clauses/{clause_id}/anchors")
def replace_anchors(clause_id: str, body: dict):
    """整组替换该条款的锚点（人工绑定/修正的写路径）。"""
    anchors = [AnchorIn(a) for a in (body.get("anchors") or [])]
    conn = db()
    try:
        clause = conn.execute("SELECT documentId FROM clauses WHERE id=?", (clause_id,)).fetchone()
        if not clause:
            raise HTTPException(404, "条款不存在")
        document_id = clause["documentId"]
        conn.execute("DELETE FROM anchors WHERE clauseId=?", (clause_id,))
        out = []
        for a in anchors:
            aid = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO anchors (id, clauseId, documentId, exactText, page, charStart, charCount, status, source)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (aid, clause_id, document_id, a.exactText, a.page, a.charStart, a.charCount, a.status, a.source),
            )
            out.append({"id": aid, "clauseId": clause_id, **a.__dict__})
        conn.commit()
        return {"clauseId": clause_id, "anchors": out}
    finally:
        conn.close()


@app.post("/documents/{document_id}/reparse")
def reparse(document_id: str, background: BackgroundTasks):
    """T6 重新解析：人工锚点保留（按 number+title 对回），自动锚点与旧树重来，失效清单明示。"""
    conn = db()
    try:
        doc = conn.execute("SELECT id, fileHash FROM documents WHERE id=?", (document_id,)).fetchone()
        if not doc:
            raise HTTPException(404, "文档不存在")
        # 1) 摘出人工锚点（manual）及其条款键（number+title）
        manual = conn.execute(
            "SELECT a.exactText, a.page, a.charStart, a.charCount, a.status,"
            "       c.number, c.title FROM anchors a JOIN clauses c ON a.clauseId = c.id"
            " WHERE a.documentId=? AND a.source='manual'",
            (document_id,),
        ).fetchall()
        # 2) 清旧树与全部锚点（人工树编辑按 Q25 整体丢弃；人工锚点已在手上）
        conn.execute("DELETE FROM anchors WHERE documentId=?", (document_id,))
        conn.execute("DELETE FROM clauses WHERE documentId=?", (document_id,))
        conn.execute("UPDATE documents SET parseStatus='parsing' WHERE id=?", (document_id,))
        conn.commit()
    finally:
        conn.close()
    background.add_task(run_reparse, document_id, [dict(m) for m in manual])
    return {"documentId": document_id, "parseStatus": "parsing", "manualAnchorsKept": len(manual)}


def run_reparse(document_id: str, manual: list[dict]) -> None:
    """重跑解析 → 建新树 → 人工锚点按 (number, title) 对回新条款；对不上的进失效清单。"""
    pdf_path = PDFS / f"{document_id}.pdf"
    try:
        blocks = default_parser().parse(str(pdf_path))
        clauses = split_clauses(blocks)
        audit_suspicious(clauses)

        conn = db()
        try:
            order = 0
            stack: list[tuple[int, str]] = []
            restored = 0
            lost: list[dict] = []
            for c in clauses:
                cid = str(uuid.uuid4())
                while stack and stack[-1][0] >= c.level:
                    stack.pop()
                parent_id = stack[-1][1] if stack else None
                conn.execute(
                    "INSERT INTO clauses (id, documentId, parentId, number, title, content, sortOrder, suspicious)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (cid, document_id, parent_id, c.number, c.title, c.content, order,
                     1 if c.suspicious else 0),
                )
                order += 1
                stack.append((c.level, cid))
                # 人工锚点对回：number+title 双匹配（宽松：strip 相等）
                for m in manual:
                    if m["number"].strip() == c.number.strip() and m["title"].strip() == c.title.strip():
                        conn.execute(
                            "INSERT INTO anchors (id, clauseId, documentId, exactText, page, charStart, charCount, status, source)"
                            " VALUES (?,?,?,?,?,?,?,?, 'manual')",
                            (str(uuid.uuid4()), cid, document_id, m["exactText"],
                             m["page"], m["charStart"], m["charCount"], m["status"]),
                        )
                        restored += 1
            # 失效清单：新树里 number+title 都对不上的人工锚点（写库供 GET 明示）
            newKeys = {(c.number.strip(), c.title.strip()) for c in clauses}
            for m in manual:
                if (m["number"].strip(), m["title"].strip()) not in newKeys:
                    lost.append({"number": m["number"], "title": m["title"]})
            conn.execute(
                "UPDATE documents SET parseStatus='done', reparseLost=? WHERE id=?",
                (json.dumps(lost, ensure_ascii=False) if lost else None, document_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        import traceback
        traceback.print_exc()
        conn = db()
        conn.execute("UPDATE documents SET parseStatus='failed' WHERE id=?", (document_id,))
        conn.commit()
        conn.close()


@app.put("/anchors/{anchor_id}")
def update_anchor(anchor_id: str, body: dict):
    """只改 status（待确认 → 已关联 的确认动作）。"""
    status = body.get("status")
    if status not in ("pending", "linked"):
        raise HTTPException(400, "status 只允许 pending/linked")
    conn = db()
    try:
        row = conn.execute("SELECT id FROM anchors WHERE id=?", (anchor_id,)).fetchone()
        if not row:
            raise HTTPException(404, "锚点不存在")
        conn.execute("UPDATE anchors SET status=? WHERE id=?", (status, anchor_id))
        conn.commit()
        return {"id": anchor_id, "status": status}
    finally:
        conn.close()
