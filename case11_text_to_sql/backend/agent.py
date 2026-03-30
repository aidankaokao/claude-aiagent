"""
Text2SQLAgent — Text-to-SQL Agent（Case 11）

Graph 結構：
  START
    ↓
  classify_node      ← 判斷問題類型（realtime / historical），設定 schema_context
    ↓
  sql_generate_node  ← schema + alias_map + few_shot + 錯誤（重試時）→ LLM → SQL
    ↓
  sql_validate_node  ← 純 Python 驗證：只允許 SELECT，無危險關鍵字
    ↓ (驗證失敗→format)
  sql_execute_node   ← 執行 SQL，捕捉錯誤，記錄重試次數
    ↓ (失敗且 retry<2 → sql_generate；否則→format)
  format_node        ← LLM 將查詢結果格式化為自然語言
    ↓
  END

SSE 事件（api.py 發出）：
  sql_query  → {"sql": "...", "query_type": "...", "attempt": N}
  token      → {"content": "..."} （來自 format_node）
  done       → {"conversation_id": "...", "content": "..."}
  error      → {"message": "..."}
"""

import json
from pathlib import Path
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, SystemMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph, add_messages
from sqlalchemy import text

from database import engine
from models import LlmConfig

# ── Prompt 檔案路徑 ────────────────────────────────────────────
_PROMPTS_DIR = Path(__file__).parent / "prompts"


def _load_prompts():
    schema_info = (_PROMPTS_DIR / "schema_info.txt").read_text(encoding="utf-8")
    alias_map = json.loads((_PROMPTS_DIR / "alias_map.json").read_text(encoding="utf-8"))
    few_shot = json.loads((_PROMPTS_DIR / "few_shot.json").read_text(encoding="utf-8"))
    return schema_info, alias_map, few_shot


SCHEMA_INFO, ALIAS_MAP, FEW_SHOT = _load_prompts()


# ── few-shot 格式化 ────────────────────────────────────────────

def _format_few_shot(query_type: str) -> str:
    examples = [ex for ex in FEW_SHOT if ex.get("query_type") == query_type]
    if not examples:
        examples = FEW_SHOT[:3]
    lines = []
    for ex in examples:
        lines.append(f"問：{ex['question']}")
        lines.append(f"SQL：\n{ex['sql']}")
        lines.append("")
    return "\n".join(lines)


# ── alias map 格式化 ───────────────────────────────────────────

def _format_alias_map() -> str:
    return "\n".join(f"  「{k}」→ {v}" for k, v in ALIAS_MAP.items())


# ============================================================
# State
# ============================================================

class Text2SQLState(TypedDict):
    messages:       Annotated[list, add_messages]
    question:       str
    query_type:     str   # "realtime" | "historical"
    schema_context: str   # 注入給 sql_generate_node 的 schema 說明
    sql_query:      str   # 生成的 SQL
    sql_error:      str   # 空字串 = 無錯誤；"VALIDATION_ERROR:..." 或執行錯誤訊息
    sql_result:     str   # JSON 字串（rows list）
    retry_count:    int
    final_answer:   str


# ============================================================
# System Prompts
# ============================================================

CLASSIFY_PROMPT = """你是一個 SQL 查詢分類器。請根據使用者問題判斷應使用哪類資料：

- realtime：查詢目前/即時庫存狀態（使用 inventory.products 表）
  關鍵詞：目前、現在、即時、現有、當前

- historical：查詢歷史趨勢、異動記錄、統計分析（使用 inventory.daily_snapshots 或 inventory.stock_changes）
  關鍵詞：過去N天、上個月、趨勢、天數、比例、次數、頻率、歷史

只回傳一個字：realtime 或 historical。不要解釋。"""

SQL_GENERATE_PROMPT = """你是一個 PostgreSQL 查詢專家。請根據以下資訊生成 SQL 查詢。

=== 資料庫 Schema ===
{schema_info}

=== 業務術語對應 ===
{alias_map}

=== 範例查詢（{query_type} 類型）===
{few_shot}

=== 使用者問題 ===
{question}

{error_hint}

要求：
1. 只生成 SELECT 查詢，禁止 INSERT / UPDATE / DELETE / DROP 等
2. 所有表名必須加 inventory. 前綴
3. 直接輸出 SQL，不要有任何解釋文字、不要 markdown 格式
4. 使用 PostgreSQL 語法（INTERVAL、DATE_TRUNC、NOW() 等）"""

FORMAT_PROMPT = """你是一個資料分析助手。請根據 SQL 查詢結果，以繁體中文回答使用者的問題。

使用者問題：{question}

查詢結果（共 {count} 筆資料）：
{result}

要求：
1. 用清晰的繁體中文回答
2. 如果有具體數字，請明確列出
3. 如果結果為空，說明沒有符合條件的資料
4. 回答要具體、有洞察，不只是複述數據"""


# ============================================================
# Text2SQLAgent
# ============================================================

class Text2SQLAgent:
    def __init__(self, llm_config: LlmConfig):
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )

    async def create_agent(self):

        # ── node functions ──────────────────────────────────

        async def classify_node(state: Text2SQLState):
            """判斷問題是即時查詢還是歷史分析，設定 schema_context"""
            response = await self.llm.ainvoke([
                SystemMessage(content=CLASSIFY_PROMPT),
                HumanMessage(content=state["question"]),
            ])
            _rc = response.content
            raw = (_rc if isinstance(_rc, str) else "").strip().lower()
            query_type = "historical" if "historical" in raw else "realtime"

            # 根據類型選擇 schema 說明重點
            if query_type == "realtime":
                schema_context = SCHEMA_INFO
            else:
                schema_context = SCHEMA_INFO

            print(f"[Classify] query_type={query_type}")
            return {
                "query_type": query_type,
                "schema_context": schema_context,
            }

        async def sql_generate_node(state: Text2SQLState):
            """根據 schema + alias_map + few_shot 生成 SQL"""
            error_hint = ""
            if state.get("sql_error") and not state["sql_error"].startswith("VALIDATION_ERROR"):
                error_hint = f"\n=== 上次執行錯誤（請修正）===\n{state['sql_error']}\n"

            prompt = SQL_GENERATE_PROMPT.format(
                schema_info=state.get("schema_context", SCHEMA_INFO),
                alias_map=_format_alias_map(),
                query_type=state.get("query_type", "realtime"),
                few_shot=_format_few_shot(state.get("query_type", "realtime")),
                question=state["question"],
                error_hint=error_hint,
            )
            response = await self.llm.ainvoke([SystemMessage(content=prompt)])
            _sc = response.content
            sql = (_sc if isinstance(_sc, str) else "").strip()

            # 清除 markdown 圍籬（如果 LLM 加了）
            if sql.startswith("```"):
                lines = sql.split("\n")
                sql_lines = lines[1:-1] if lines and lines[-1].strip() == "```" else lines[1:]
                sql = "\n".join(sql_lines)

            print(f"[SQL Generate] attempt={state.get('retry_count',0)+1}  sql={sql[:80]!r}")
            return {"sql_query": sql, "sql_error": ""}

        def sql_validate_node(state: Text2SQLState):
            """純 Python SQL 安全驗證：只允許 SELECT"""
            sql = state.get("sql_query", "").strip()
            if not sql:
                return {"sql_error": "VALIDATION_ERROR: SQL 為空"}

            sql_upper = sql.upper()

            # 必須以 SELECT 開頭
            if not sql_upper.lstrip().startswith("SELECT"):
                return {"sql_error": "VALIDATION_ERROR: 只允許 SELECT 查詢"}

            # 禁止危險關鍵字
            dangerous = [
                "INSERT", "UPDATE", "DELETE", "DROP", "CREATE",
                "ALTER", "TRUNCATE", "EXEC", "EXECUTE", "GRANT",
                "REVOKE", "--", "/*",
            ]
            for kw in dangerous:
                if kw in sql_upper:
                    return {"sql_error": f"VALIDATION_ERROR: 不允許使用 {kw}"}

            return {"sql_error": ""}

        def sql_execute_node(state: Text2SQLState):
            """執行 SQL，回傳結果或錯誤"""
            sql = state.get("sql_query", "")
            retry_count = state.get("retry_count", 0)
            try:
                with engine.connect() as conn:
                    result = conn.execute(text(sql))
                    columns = list(result.keys())
                    rows = []
                    for row in result:
                        row_dict = {}
                        for col, val in zip(columns, row):
                            row_dict[col] = str(val) if val is not None else None
                        rows.append(row_dict)
                print(f"[SQL Execute] 成功，共 {len(rows)} 筆")
                return {"sql_result": json.dumps(rows, ensure_ascii=False), "sql_error": ""}
            except Exception as e:
                err = str(e)
                print(f"[SQL Execute] 錯誤（retry={retry_count}）: {err[:120]}")
                return {"sql_error": err, "retry_count": retry_count + 1}

        async def format_node(state: Text2SQLState):
            """將 SQL 結果格式化為自然語言回答"""
            sql_error = state.get("sql_error", "")

            if sql_error:
                if sql_error.startswith("VALIDATION_ERROR"):
                    answer = f"查詢失敗：SQL 驗證未通過。{sql_error.replace('VALIDATION_ERROR: ', '')}"
                else:
                    answer = f"查詢執行失敗（已重試 {state.get('retry_count', 0)} 次）：{sql_error[:200]}"
            else:
                result_str = state.get("sql_result", "[]")
                try:
                    rows = json.loads(result_str)
                except Exception:
                    rows = []

                if not rows:
                    answer = "查詢完成，但沒有符合條件的資料。請確認查詢條件是否正確。"
                else:
                    prompt = FORMAT_PROMPT.format(
                        question=state["question"],
                        count=len(rows),
                        result=json.dumps(rows[:50], ensure_ascii=False, indent=2),
                    )
                    response = await self.llm.ainvoke([SystemMessage(content=prompt)])
                    answer = response.content

            return {
                "messages": [AIMessage(content=answer)],
                "final_answer": answer,
            }

        # ── route functions ─────────────────────────────────

        def route_after_validate(state: Text2SQLState) -> str:
            if state.get("sql_error", "").startswith("VALIDATION_ERROR"):
                return "format"
            return "execute"

        def route_after_execute(state: Text2SQLState) -> str:
            if state.get("sql_error") and state.get("retry_count", 0) < 2:
                return "generate"
            return "format"

        # ── build graph ─────────────────────────────────────

        graph = StateGraph(Text2SQLState)

        graph.add_node("classify",  classify_node)
        graph.add_node("generate",  sql_generate_node)
        graph.add_node("validate",  sql_validate_node)
        graph.add_node("execute",   sql_execute_node)
        graph.add_node("format",    format_node)

        graph.add_edge(START,       "classify")
        graph.add_edge("classify",  "generate")
        graph.add_edge("generate",  "validate")
        graph.add_conditional_edges(
            "validate", route_after_validate,
            {"execute": "execute", "format": "format"},
        )
        graph.add_conditional_edges(
            "execute", route_after_execute,
            {"generate": "generate", "format": "format"},
        )
        graph.add_edge("format", END)

        agent = graph.compile(checkpointer=MemorySaver())
        return agent
