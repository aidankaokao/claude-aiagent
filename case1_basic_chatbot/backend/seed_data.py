"""
模擬資料產生器

執行方式：
  python seed_data.py --api-key sk-your-key-here

  若不需要實際呼叫 LLM（只建立固定的模擬對話），可省略 --api-key：
  python seed_data.py
"""

import uuid
import argparse
from datetime import datetime, timedelta
from sqlalchemy import insert
from database import engine, init_db, conversations, messages


def seed():
    init_db()

    demo_conversations = [
        {
            "id": str(uuid.uuid4()),
            "title": "什麼是 LangGraph？",
            "messages": [
                {"role": "user", "content": "請簡單介紹一下 LangGraph 是什麼？"},
                {"role": "assistant", "content": "LangGraph 是由 LangChain 團隊開發的框架，專門用來建構有狀態的、多步驟的 AI Agent 應用。\n\n核心概念：\n- **節點（Node）**：Agent 的每個處理步驟\n- **邊（Edge）**：步驟之間的流向\n- **狀態（State）**：在節點之間傳遞的共享資料\n\n與簡單的 LLM 呼叫鏈不同，LangGraph 支援**循環**和**條件分支**。"},
                {"role": "user", "content": "它和 LangChain 有什麼不同？"},
                {"role": "assistant", "content": "| 特性 | LangChain | LangGraph |\n|------|-----------|----------|\n| 定位 | LLM 工具箱 | Agent 框架 |\n| 流程 | 線性鏈式 | 有向圖（支援循環） |\n| 狀態管理 | 基礎 | 完整（Checkpoint） |\n\nLangGraph 底層使用 LangChain 提供的模型介面，但提供了更強大的流程控制能力。"},
            ],
        },
        {
            "id": str(uuid.uuid4()),
            "title": "FastAPI SSE 串流教學",
            "messages": [
                {"role": "user", "content": "如何用 FastAPI 實現 SSE 串流？"},
                {"role": "assistant", "content": "```python\nfrom sse_starlette.sse import EventSourceResponse\n\nasync def event_generator():\n    for chunk in [\"Hello\", \" World\"]:\n        yield {\"event\": \"token\", \"data\": json.dumps({\"content\": chunk})}\n    yield {\"event\": \"done\", \"data\": \"{}\"}\n\n@app.post(\"/api/chat\")\nasync def chat():\n    return EventSourceResponse(event_generator())\n```"},
            ],
        },
    ]

    with engine.connect() as conn:
        now = datetime.utcnow()
        for i, conv in enumerate(demo_conversations):
            conv_time = now - timedelta(hours=len(demo_conversations) - i)
            conn.execute(insert(conversations).values(
                id=conv["id"], title=conv["title"],
                created_at=conv_time, updated_at=conv_time,
            ))
            for j, msg in enumerate(conv["messages"]):
                conn.execute(insert(messages).values(
                    conversation_id=conv["id"],
                    role=msg["role"], content=msg["content"],
                    created_at=conv_time + timedelta(minutes=j),
                ))
        conn.commit()

    print(f"[Seed] 已建立 {len(demo_conversations)} 筆模擬對話")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Case 1 模擬資料產生器")
    parser.add_argument(
        "--api-key",
        type=str,
        default="",
        help="OpenAI API Key（本腳本只建立固定模擬資料，不呼叫 LLM，可省略）",
    )
    args = parser.parse_args()
    seed()
