"""
種子資料 — Case 4: Plan-Execute Agent

建立資料庫並插入範例對話記錄，方便啟動後立即有歷史資料可查看。
"""

import sys
import uuid
import json
from datetime import datetime, timedelta

from database import engine, init_db, conversations, messages


def seed():
    """插入範例旅行規劃對話"""
    init_db()

    example_plan = ["搜尋東京的熱門景點", "查詢東京天氣預報", "尋找東京餐廳推薦", "估算 3 天旅遊費用"]

    # 範例 1：東京 3 天行程
    conv_id = str(uuid.uuid4())
    with engine.connect() as conn:
        conn.execute(conversations.insert().values(
            id=conv_id,
            title="東京 3 天旅遊行程規劃",
            created_at=datetime.now() - timedelta(days=1),
            updated_at=datetime.now() - timedelta(days=1),
        ))
        conn.execute(messages.insert().values(
            conversation_id=conv_id,
            role="user",
            content="幫我規劃東京 3 天的旅遊行程，2 人同行，標準住宿",
            created_at=datetime.now() - timedelta(days=1),
        ))
        conn.execute(messages.insert().values(
            conversation_id=conv_id,
            role="assistant",
            content="# 東京 3 天 2 人旅遊計劃\n\n## 行程概覽\n...",
            plan_json=json.dumps(example_plan, ensure_ascii=False),
            created_at=datetime.now() - timedelta(days=1),
        ))
        conn.commit()

    print(f"[Seed] 已建立範例對話 (id: {conv_id})")
    print("[Seed] 種子資料建立完成")


if __name__ == "__main__":
    seed()
