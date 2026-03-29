"""
模擬資料產生器 — 50 個產品（5 個分類，每類 10 個）

執行方式：
  python seed_data.py

庫存狀態設計：
- 少數產品設為低庫存（quantity < min_stock），讓使用者能立即看到警示
- 多數產品庫存正常
- 少數產品庫存充足（quantity >= min_stock * 3）
"""

import argparse
from sqlalchemy import insert
from database import engine, init_db, products


# 50 個模擬產品（name, category, quantity, min_stock, unit_price）
SEED_PRODUCTS = [
    # ── 電子產品 ──
    ("筆記型電腦",   "電子產品",  12,  5,  35000),
    ("智慧型手機",   "電子產品",   8, 10,  25000),  # 低庫存
    ("平板電腦",     "電子產品",  15,  8,  18000),
    ("無線耳機",     "電子產品",   6, 15,   3500),  # 低庫存
    ("智慧手錶",     "電子產品",  22, 10,   8000),
    ("行動電源",     "電子產品",  45, 20,    800),
    ("藍牙音箱",     "電子產品",  18, 12,   1500),
    ("網路攝影機",   "電子產品",   5,  8,   1200),  # 低庫存
    ("機械鍵盤",     "電子產品",  30, 10,   2800),
    ("無線滑鼠",     "電子產品",  50, 15,    600),

    # ── 文具 ──
    ("原子筆組",     "文具",      80, 30,    150),
    ("自動鉛筆",     "文具",      25, 25,     80),
    ("筆記本",       "文具",     120, 40,    120),
    ("資料夾",       "文具",      18, 30,     60),  # 低庫存
    ("訂書機",       "文具",      20, 15,    200),
    ("桌上型計算機", "文具",      12, 10,    350),
    ("膠帶台",       "文具",      35, 20,     90),
    ("橡皮擦",       "文具",     150, 50,     25),
    ("修正帶",       "文具",      90, 40,     45),
    ("便利貼",       "文具",     100, 35,     55),

    # ── 食品 ──
    ("礦泉水(24入)", "食品",     200, 50,    250),
    ("綠茶飲料",     "食品",      40, 60,     35),  # 低庫存
    ("咖啡粉",       "食品",      30, 20,    380),
    ("餅乾禮盒",     "食品",      15, 25,    280),  # 低庫存
    ("即食拉麵",     "食品",      80, 40,     45),
    ("蜂蜜",         "食品",      25, 15,    450),
    ("燕麥片",       "食品",      45, 20,    220),
    ("能量棒",       "食品",      60, 30,     60),
    ("柳橙汁",       "食品",      50, 35,     45),
    ("黑巧克力",     "食品",      35, 25,    120),

    # ── 服飾 ──
    ("純棉T恤",      "服飾",      55, 20,    399),
    ("牛仔褲",       "服飾",      28, 15,    890),
    ("運動鞋",       "服飾",      10, 12,   1290),
    ("防風夾克",     "服飾",       6, 10,   1580),  # 低庫存
    ("棒球帽",       "服飾",      40, 18,    380),
    ("運動襪組",     "服飾",      70, 25,    180),
    ("羊毛圍巾",     "服飾",       8, 12,    550),  # 低庫存
    ("保暖手套",     "服飾",      20, 15,    280),
    ("皮帶",         "服飾",      15, 10,    450),
    ("雨衣",         "服飾",       5,  8,    680),  # 低庫存

    # ── 家居 ──
    ("純棉毛巾組",   "家居",      60, 20,    280),
    ("記憶枕",       "家居",       6,  8,    890),  # 低庫存
    ("洗碗精",       "家居",      90, 30,     85),
    ("抽取式衛生紙", "家居",     120, 40,    120),
    ("洗手液",       "家居",      80, 35,     99),
    ("垃圾袋(100入)","家居",      75, 30,     65),
    ("保鮮膜",       "家居",      50, 25,     55),
    ("廚房紙巾",     "家居",      65, 30,     75),
    ("香氛蠟燭",     "家居",      12, 10,    350),
    ("多功能收納盒", "家居",       5,  8,    480),  # 低庫存
]


def seed():
    """將 50 個產品寫入資料庫（若已存在則跳過）"""
    init_db()

    with engine.connect() as conn:
        # 若已有資料則不重複寫入
        from sqlalchemy import select, func as sqlfunc
        count = conn.execute(select(sqlfunc.count()).select_from(products)).scalar()
        if count > 0:
            print(f"[Seed] 資料庫已有 {count} 筆產品，跳過初始化。")
            return

        for name, category, quantity, min_stock, unit_price in SEED_PRODUCTS:
            conn.execute(insert(products).values(
                name=name,
                category=category,
                quantity=quantity,
                min_stock=min_stock,
                unit_price=float(unit_price),
            ))
        conn.commit()

    print(f"[Seed] 已建立 {len(SEED_PRODUCTS)} 筆產品資料")

    # 統計低庫存產品數量，方便確認
    low_stock = [(n, q, m) for n, _, q, m, _ in SEED_PRODUCTS if q < m]
    print(f"[Seed] 其中 {len(low_stock)} 筆產品為低庫存：")
    for name, qty, min_qty in low_stock:
        print(f"       - {name}：庫存 {qty} / 安全庫存 {min_qty}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Case 3 模擬資料產生器")
    # 本腳本不呼叫 LLM，保留 --api-key 參數與其他腳本格式統一
    parser.add_argument("--api-key", type=str, default="", help="OpenAI API Key（本腳本不呼叫 LLM，可省略）")
    parser.parse_args()
    seed()
