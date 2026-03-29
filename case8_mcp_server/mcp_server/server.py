"""
MCP Server — 知識庫 FastMCP stdio 伺服器

架構說明：
- 使用 FastMCP（stdio transport）作為 MCP 協定實作
- 後端（backend/api.py）透過 MultiServerMCPClient 以子程序方式啟動本伺服器
- 兩者透過 stdin/stdout 以 JSON-RPC 格式溝通

提供工具：
- search_articles  : 關鍵字搜尋文章（LIKE 比對 title/content/tags）
- get_article      : 取得完整文章內容（依 ID）
- create_article   : 新增文章
- list_articles    : 列出文章清單（可依標籤篩選，content 截斷至 200 字）
"""

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from fastmcp import FastMCP

# ============================================================
# 資料庫設定
# ============================================================

# 優先從環境變數取得資料庫路徑，預設為專案根目錄下的 data/kb.db
DB_PATH = Path(
    os.getenv("KB_DB_PATH", str(Path(__file__).parent.parent / "data" / "kb.db"))
)
# 確保資料庫目錄存在（首次啟動時自動建立）
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    """建立並回傳 SQLite 連線，設定 Row Factory 以支援欄位名稱存取"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """初始化知識庫資料表（若尚未建立）"""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS articles (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                content    TEXT NOT NULL,
                tags       TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)


# 伺服器啟動時自動初始化資料庫
init_db()

# ============================================================
# FastMCP 伺服器實例
# ============================================================

mcp = FastMCP("Knowledge Base")


# ============================================================
# 工具：search_articles
# ============================================================

@mcp.tool()
def search_articles(query: str, limit: int = 5) -> str:
    """
    根據關鍵字搜尋知識庫文章。

    搜尋範圍包含文章標題、內文及標籤（三者皆使用 LIKE 比對）。
    結果依建立時間降冪排列，並截斷 content 至 300 字以減少輸出量。

    Args:
        query: 搜尋關鍵字
        limit: 最多回傳筆數（預設 5）

    Returns:
        JSON 字串，格式為 list[dict]，每筆包含 id/title/content/tags/created_at
    """
    pattern = f"%{query}%"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT id, title,
                   substr(content, 1, 300) AS content,
                   tags, created_at
            FROM articles
            WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (pattern, pattern, pattern, limit),
        ).fetchall()
    result = [dict(row) for row in rows]
    return json.dumps(result, ensure_ascii=False)


# ============================================================
# 工具：get_article
# ============================================================

@mcp.tool()
def get_article(article_id: int) -> str:
    """
    依文章 ID 取得完整文章內容（不截斷）。

    Args:
        article_id: 文章的數字 ID

    Returns:
        JSON 字串，格式為 dict（含所有欄位），若不存在則回傳錯誤訊息
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, title, content, tags, created_at, updated_at FROM articles WHERE id = ?",
            (article_id,),
        ).fetchone()
    if row is None:
        return json.dumps({"error": f"找不到 ID 為 {article_id} 的文章"}, ensure_ascii=False)
    return json.dumps(dict(row), ensure_ascii=False)


# ============================================================
# 工具：create_article
# ============================================================

@mcp.tool()
def create_article(title: str, content: str, tags: str = "") -> str:
    """
    在知識庫中新增一篇文章。

    Args:
        title:   文章標題（必填）
        content: 文章內文（必填）
        tags:    標籤，多個標籤以逗號分隔（選填，例如 "python,asyncio"）

    Returns:
        JSON 字串，格式為 dict，包含新建文章的完整資料（含自動產生的 id）
    """
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO articles (title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (title, content, tags, now, now),
        )
        new_id = cursor.lastrowid
        conn.commit()
        row = conn.execute(
            "SELECT id, title, content, tags, created_at, updated_at FROM articles WHERE id = ?",
            (new_id,),
        ).fetchone()
    return json.dumps(dict(row), ensure_ascii=False)


# ============================================================
# 工具：list_articles
# ============================================================

@mcp.tool()
def list_articles(limit: int = 10, tag: str = "") -> str:
    """
    列出知識庫文章清單（content 截斷至 200 字，適合概覽用途）。
    可選擇依標籤篩選，標籤使用 LIKE 比對。

    Args:
        limit: 最多回傳筆數（預設 10）
        tag:   標籤篩選（空字串表示不篩選，例如 "python"）

    Returns:
        JSON 字串，格式為 list[dict]，每筆包含 id/title/content(截斷)/tags/created_at
    """
    if tag:
        pattern = f"%{tag}%"
        with get_conn() as conn:
            rows = conn.execute(
                """
                SELECT id, title,
                       substr(content, 1, 200) AS content,
                       tags, created_at
                FROM articles
                WHERE tags LIKE ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (pattern, limit),
            ).fetchall()
    else:
        with get_conn() as conn:
            rows = conn.execute(
                """
                SELECT id, title,
                       substr(content, 1, 200) AS content,
                       tags, created_at
                FROM articles
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
    result = [dict(row) for row in rows]
    return json.dumps(result, ensure_ascii=False)


# ============================================================
# 入口點
# ============================================================

if __name__ == "__main__":
    # stdio transport：透過 stdin/stdout 與 MCP client 溝通
    mcp.run()
