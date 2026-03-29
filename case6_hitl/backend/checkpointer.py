"""
AsyncSqliteSaver 設定 — Case 6: Human-in-the-Loop

使用方式：
  AsyncSqliteSaver 是 async context manager，必須透過 `async with` 初始化，
  不能直接在模組層級呼叫 .from_conn_string() 後立即使用。

  正確做法：在 FastAPI lifespan 事件中初始化，儲存至模組變數：

    # api.py
    import checkpointer as cp_module
    from checkpointer import get_checkpointer_cm

    @asynccontextmanager
    async def lifespan(app):
        async with get_checkpointer_cm() as cp:
            cp_module.checkpointer = cp   # 設定全域 checkpointer
            yield

  agent.py 在 create_agent() 時透過模組引用讀取（而非 import-time），
  確保取到已初始化的實例：

    import checkpointer as cp_module
    agent = graph.compile(checkpointer=cp_module.checkpointer)

AsyncSqliteSaver vs MemorySaver：
  MemorySaver         — 存在記憶體，程式重啟後 checkpoint 消失
  AsyncSqliteSaver    — 存在 SQLite 檔案，重啟後仍可恢復；async 相容 FastAPI
"""

import os
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from config import settings

# 模組層級變數，由 api.py lifespan 設定；agent.py 透過模組引用讀取
checkpointer = None


def get_checkpointer_cm():
    """回傳 AsyncSqliteSaver 的 async context manager，供 lifespan 使用"""
    cp_path = settings.checkpoint_db_path
    os.makedirs(os.path.dirname(cp_path), exist_ok=True)
    return AsyncSqliteSaver.from_conn_string(cp_path)
