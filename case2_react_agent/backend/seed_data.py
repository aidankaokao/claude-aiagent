"""
模擬資料產生器

預先寫入三筆示範對話，讓使用者啟動後能在側邊欄看到歷史記錄。
這些對話模擬了三種工具的使用情境：時間查詢、計算機、網路搜尋。

執行方式：
  python seed_data.py
"""

import uuid
import argparse
from datetime import datetime, timedelta
from sqlalchemy import insert
from database import engine, init_db, conversations, messages


def seed():
    """建立示範對話資料並寫入資料庫"""
    init_db()

    # 三筆示範對話，分別對應三種工具的使用情境
    demo_conversations = [
        {
            "id": str(uuid.uuid4()),
            "title": "現在台北幾點？",
            "messages": [
                {"role": "user",      "content": "現在台北是幾點？"},
                {"role": "assistant", "content": "我使用了 get_current_time 工具查詢。目前台北時間為上午 10:30，UTC+8。"},
            ],
        },
        {
            "id": str(uuid.uuid4()),
            "title": "計算複利",
            "messages": [
                {"role": "user",      "content": "本金 10000 元，年利率 5%，存 3 年，最終金額是多少？"},
                {"role": "assistant", "content": "使用計算機工具計算：10000 * 1.05 ** 3 = 11576 元（複利計算）。"},
            ],
        },
        {
            "id": str(uuid.uuid4()),
            "title": "LangGraph 是什麼",
            "messages": [
                {"role": "user",      "content": "幫我搜尋一下 LangGraph 是什麼"},
                {"role": "assistant", "content": "根據搜尋結果，LangGraph 是 LangChain 團隊開發的 Agent 框架，將 AI Agent 的邏輯建模為有向圖（Directed Graph）。支援 ReAct、Plan-Execute、HITL 等複雜 Agent 模式。"},
            ],
        },
    ]

    with engine.connect() as conn:
        now = datetime.utcnow()
        for i, conv in enumerate(demo_conversations):
            # 讓每筆對話的時間略有差異，以便按時間排序後順序正確
            t = now - timedelta(hours=len(demo_conversations) - i)
            conn.execute(insert(conversations).values(
                id=conv["id"], title=conv["title"], created_at=t, updated_at=t,
            ))
            # 逐則訊息寫入，每則間隔 1 分鐘
            for j, msg in enumerate(conv["messages"]):
                conn.execute(insert(messages).values(
                    conversation_id=conv["id"], role=msg["role"],
                    content=msg["content"], created_at=t + timedelta(minutes=j),
                ))
        conn.commit()

    print(f"[Seed] 已建立 {len(demo_conversations)} 筆模擬對話")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Case 2 模擬資料產生器")
    # 本腳本不呼叫 LLM，保留 --api-key 參數僅為與其他腳本格式統一
    parser.add_argument("--api-key", type=str, default="", help="OpenAI API Key（本腳本不呼叫 LLM，可省略）")
    parser.parse_args()
    seed()
