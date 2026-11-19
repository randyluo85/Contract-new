# -*- coding: utf-8 -*-
"""PDF 条款解析与双向定位 POC —— 后端骨架（T1）。

异步解析任务 + fileHash 幂等 + SQLite 三表 + stub 解析器。
接口：POST /parse、GET /documents/{id}、GET /documents/{id}/file、
PUT /clauses/{id}/anchors、PUT /anchors/{id}。
"""
import hashlib
import io
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pypdf import PdfReader

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
  parseStatus TEXT NOT NULL DEFAULT 'parsing'
);
CREATE TABLE IF NOT EXISTS clauses (
  id         TEXT PRIMARY KEY,
  documentId TEXT NOT NULL,
  parentId   TEXT,
  number     TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT,
  sortOrder  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anchors (
  id         TEXT PRIMARY KEY,
  clauseId   TEXT NOT NULL,
  documentId TEXT NOT NULL,
  exactText  TEXT,
  page       INTEGER,
  charStart  INTEGER,
  charCount  INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending'
);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


# ---------------- stub 解析器（T1：固定假条款；T2 换 Docling 实现） ----------------

STUB_CLAUSES = [
    ("第一条", "合同标的", [
        ("1.1", "产品名称"),
        ("1.2", "产品数量"),
    ]),
    ("第二条", "付款方式", [
        ("2.1", "付款期限"),
        ("2.2", "付款条件"),
    ]),
    ("第三条", "违约责任", [
        ("3.1", "违约金"),
        ("3.2", "赔偿责任"),
    ]),
]

STUB_CONTENT = "（stub 解析器占位正文，T2 将替换为 Docling 解析结果。）"


def run_stub_parse(document_id: str) -> None:
    """后台任务：模拟解析耗时后写入固定假条款树，置 done；异常置 failed。"""
    try:
        time.sleep(1.0)
        conn = db()
        order = 0
        for num, title, children in STUB_CLAUSES:
            top_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO clauses (id, documentId, parentId, number, title, content, sortOrder)"
                " VALUES (?,?,?,?,?,?,?)",
                (top_id, document_id, None, num, title, STUB_CONTENT, order),
            )
            order += 1
            for sub_num, sub_title in children:
                conn.execute(
                    "INSERT INTO clauses (id, documentId, parentId, number, title, content, sortOrder)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()), document_id, top_id, sub_num, sub_title, STUB_CONTENT, order),
                )
                order += 1
        conn.execute(
            "UPDATE documents SET parseStatus='done' WHERE id=?", (document_id,)
        )
        conn.commit()
        conn.close()
    except Exception:
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
    background.add_task(run_stub_parse, doc_id)
    return {"documentId": doc_id, "parseStatus": "parsing", "existed": False}


def _clause_rows(conn, document_id):
    rows = conn.execute(
        "SELECT id, parentId, number, title, content, sortOrder FROM clauses"
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
            "anchors": amap.get(r["id"], []),
        }
        for r in rows
    ]


@app.get("/documents/{document_id}")
def get_document(document_id: str):
    conn = db()
    try:
        doc = conn.execute(
            "SELECT id, fileName, pageCount, parseStatus FROM documents WHERE id=?",
            (document_id,),
        ).fetchone()
        if not doc:
            raise HTTPException(404, "文档不存在")
        return {
            "document": dict(doc),
            "clauses": _clause_rows(conn, document_id),
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
                "INSERT INTO anchors (id, clauseId, documentId, exactText, page, charStart, charCount, status)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (aid, clause_id, document_id, a.exactText, a.page, a.charStart, a.charCount, a.status),
            )
            out.append({"id": aid, "clauseId": clause_id, **a.__dict__})
        conn.commit()
        return {"clauseId": clause_id, "anchors": out}
    finally:
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
