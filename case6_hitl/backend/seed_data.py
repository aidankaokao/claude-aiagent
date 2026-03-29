"""
初始化商品資料 — Case 6: Human-in-the-Loop

執行方式：
  python seed_data.py

寫入 10 件商品到資料庫，涵蓋多種類別與價格範圍。
閾值設定為 2000 元：訂購高單價商品（如螢幕、硬碟）或大量採購時會觸發人工審批。
"""

from database import engine, init_db, products


PRODUCTS = [
    {"id": "P001", "name": "無線滑鼠",    "category": "輸入設備", "price": 299.0,  "stock": 50},
    {"id": "P002", "name": "機械鍵盤",    "category": "輸入設備", "price": 699.0,  "stock": 30},
    {"id": "P003", "name": "27吋螢幕",    "category": "顯示設備", "price": 3999.0, "stock": 10},
    {"id": "P004", "name": "無線耳機",    "category": "音響設備", "price": 899.0,  "stock": 25},
    {"id": "P005", "name": "USB集線器",   "category": "連接設備", "price": 199.0,  "stock": 100},
    {"id": "P006", "name": "網路攝影機",  "category": "視訊設備", "price": 599.0,  "stock": 20},
    {"id": "P007", "name": "2TB硬碟",     "category": "儲存設備", "price": 1299.0, "stock": 15},
    {"id": "P008", "name": "16GB記憶體",  "category": "升級零件", "price": 799.0,  "stock": 40},
    {"id": "P009", "name": "大型滑鼠墊",  "category": "周邊配件", "price": 129.0,  "stock": 80},
    {"id": "P010", "name": "筆電支架",    "category": "周邊配件", "price": 349.0,  "stock": 35},
]


def seed():
    init_db()
    from tools.order import init_order_tables
    init_order_tables()

    from sqlalchemy import delete
    with engine.connect() as conn:
        conn.execute(delete(products))
        conn.commit()
        for p in PRODUCTS:
            conn.execute(products.insert().values(**p))
        conn.commit()

    print(f"成功寫入 {len(PRODUCTS)} 件商品：")
    for p in PRODUCTS:
        print(f"  {p['id']}  {p['name']:<12}  {p['category']:<8}  NT${p['price']:>7.0f}  庫存 {p['stock']}")
    print("\n審批門檻：NT$2,000（可在 config.py 或 .env 調整 APPROVAL_THRESHOLD）")
    print("範例觸發審批的訂購：「我要訂一台27吋螢幕」（NT$3,999 > NT$2,000）")


if __name__ == "__main__":
    seed()
