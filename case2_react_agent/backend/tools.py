"""
工具定義 — ReAct Agent 可使用的三個工具

學習重點：
- @tool 裝飾器將普通函數轉為 LangChain 工具
- 函數的 docstring 會成為工具的描述，LLM 透過描述決定何時使用此工具
- 函數的參數型別與說明會成為工具的 schema（LLM 填入的參數格式）
- 工具回傳 str，LLM 會收到這個字串作為 ToolMessage

工具清單：
1. web_search    — 模擬網路搜尋（從 mock_search.json 比對關鍵字）
2. calculator    — 數學計算（安全的 AST 求值，支援 +/-×÷ 與次方）
3. get_current_time — 取得當前時間（支援台北 / UTC / 東京時區）
"""

import ast
import json
import operator
import os
from datetime import datetime, timezone, timedelta
from langchain_core.tools import tool


# ============================================================
# 工具 1：web_search
# ============================================================

# 載入模擬搜尋資料（模組載入時執行一次）
_MOCK_DATA_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "mock_search.json")
with open(_MOCK_DATA_PATH, encoding="utf-8") as f:
    _MOCK_SEARCH_DATA: list[dict] = json.load(f)


@tool
def web_search(query: str) -> str:
    """
    搜尋網路上的資訊。當需要查詢某個主題的最新資訊、背景知識或事實時使用此工具。
    查詢應使用關鍵字形式，例如「LangGraph 介紹」或「Python 版本」。
    """
    query_lower = query.lower()

    # 依 keywords 比對，取第一個命中的結果
    for entry in _MOCK_SEARCH_DATA:
        for kw in entry["keywords"]:
            if kw in query_lower:
                return entry["result"]

    # 無命中時回傳通用提示
    return f"搜尋「{query}」未找到相關結果。此工具使用模擬資料，僅包含有限主題。請嘗試換個關鍵字，或直接根據已知知識回答。"


# ============================================================
# 工具 2：calculator
# ============================================================

# 安全的 AST 求值器（只允許數學運算，防止任意程式碼執行）
_ALLOWED_OPS = {
    ast.Add:  operator.add,
    ast.Sub:  operator.sub,
    ast.Mult: operator.mul,
    ast.Div:  operator.truediv,
    ast.Pow:  operator.pow,
    ast.Mod:  operator.mod,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _safe_eval(node: ast.AST) -> float:
    """遞迴求值，只允許數字與基本運算符號"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    elif isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_OPS:
        return _ALLOWED_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_OPS:
        return _ALLOWED_OPS[type(node.op)](_safe_eval(node.operand))
    else:
        raise ValueError(f"不支援的運算: {ast.dump(node)}")


@tool
def calculator(expression: str) -> str:
    """
    計算數學運算式，支援加（+）、減（-）、乘（*）、除（/）、次方（**）、取餘（%）。
    例如：「100 * 1.05 ** 3」、「(80 + 90 + 75) / 3」。
    只能處理純數學運算式，不支援變數或函數。
    """
    try:
        tree = ast.parse(expression.strip(), mode="eval")
        result = _safe_eval(tree.body)
        # 若結果為整數，去掉小數點
        if result == int(result):
            return f"{expression} = {int(result)}"
        return f"{expression} = {round(result, 10)}"
    except ZeroDivisionError:
        return "錯誤：除以零"
    except Exception as e:
        return f"計算失敗：{e}。請確認輸入的是合法數學運算式。"


# ============================================================
# 工具 3：get_current_time
# ============================================================

_TIMEZONES = {
    "taipei": timezone(timedelta(hours=8)),
    "台北": timezone(timedelta(hours=8)),
    "tst": timezone(timedelta(hours=8)),
    "cst": timezone(timedelta(hours=8)),
    "tokyo": timezone(timedelta(hours=9)),
    "東京": timezone(timedelta(hours=9)),
    "jst": timezone(timedelta(hours=9)),
    "utc": timezone.utc,
    "london": timezone.utc,
    "new york": timezone(timedelta(hours=-5)),
    "los angeles": timezone(timedelta(hours=-8)),
}


@tool
def get_current_time(location: str = "taipei") -> str:
    """
    取得指定地區的當前日期與時間。
    支援地區：taipei（台北）、tokyo（東京）、utc、london、new york、los angeles。
    若未指定地區，預設回傳台北時間。
    """
    tz = _TIMEZONES.get(location.lower().strip(), _TIMEZONES["taipei"])
    now = datetime.now(tz)
    offset = now.strftime("%z")
    offset_str = f"UTC{offset[:3]}:{offset[3:]}" if offset else ""
    return (
        f"目前時間（{location}，{offset_str}）：\n"
        f"{now.strftime('%Y 年 %m 月 %d 日 %A')}\n"
        f"{now.strftime('%H:%M:%S')}"
    )


# 所有工具清單（供 agent.py 和其他地方 import）
ALL_TOOLS = [web_search, calculator, get_current_time]
