# Case 11 Q&A — Text-to-SQL Agent

---

## Q1：Case 11 的 Text-to-SQL 是怎麼實現的？

整個流程由五個節點串成一條 LangGraph pipeline，對應程式碼在 `backend/agent.py`。

---

### 第一步：classify_node（分類問題）

**程式碼位置**：`agent.py:156`

```python
async def classify_node(state: Text2SQLState):
    response = await self.llm.ainvoke([
        SystemMessage(content=CLASSIFY_PROMPT),
        HumanMessage(content=state["question"]),
    ])
    raw = (_rc if isinstance(_rc, str) else "").strip().lower()
    query_type = "historical" if "historical" in raw else "realtime"
```

LLM 收到 `CLASSIFY_PROMPT`（`agent.py:93`）後，只會回傳 `realtime` 或 `historical` 其中一個字。分類依據：

- **realtime**：問目前/即時庫存 → 查 `inventory.products`
- **historical**：問趨勢/天數/比例/異動 → 查 `inventory.daily_snapshots` 或 `inventory.stock_changes`

分類結果寫入 `state["query_type"]`，後面的節點都會用到。

---

### 第二步：sql_generate_node（生成 SQL）

**程式碼位置**：`agent.py:178`

這是最核心的節點，組合三份素材注入 prompt：

```python
prompt = SQL_GENERATE_PROMPT.format(
    schema_info=state.get("schema_context", SCHEMA_INFO),   # 表結構說明
    alias_map=_format_alias_map(),                           # 術語對應表
    query_type=state.get("query_type", "realtime"),
    few_shot=_format_few_shot(state.get("query_type", ...)), # few-shot 範例
    question=state["question"],
    error_hint=error_hint,                                   # 重試時才有值
)
```

**三份素材各自的作用**：

| 素材 | 檔案 | 功能 |
|------|------|------|
| `schema_info` | `prompts/schema_info.txt` | 告訴 LLM 有哪些表、哪些欄位、資料長什麼樣 |
| `alias_map` | `prompts/alias_map.json` | 業務詞 → SQL 的對應，如「庫存不足」→ `quantity < min_stock` |
| `few_shot` | `prompts/few_shot.json` | 依 `query_type` 過濾出相關範例（`agent.py:55`），以「問/SQL」格式注入 |

**LLM 回傳的 SQL 後處理**（`agent.py:197`）：
```python
if sql.startswith("```"):
    lines = sql.split("\n")
    sql_lines = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
    sql = "\n".join(sql_lines)
```
防止 LLM 多加了 markdown 圍籬（```sql ... ```）。

**重試時的 error_hint**（`agent.py:181`）：
```python
if state.get("sql_error") and not state["sql_error"].startswith("VALIDATION_ERROR"):
    error_hint = f"\n=== 上次執行錯誤（請修正）===\n{state['sql_error']}\n"
```
執行失敗時，把資料庫的錯誤訊息夾進 prompt，讓 LLM 看著錯誤重新生成。

---

### 第三步：sql_validate_node（驗證 SQL）

**程式碼位置**：`agent.py:205`

純 Python 驗證，**不呼叫 LLM**：

```python
def sql_validate_node(state: Text2SQLState):
    sql_upper = sql.upper()
    if not sql_upper.lstrip().startswith("SELECT"):
        return {"sql_error": "VALIDATION_ERROR: 只允許 SELECT 查詢"}
    dangerous = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
                 "TRUNCATE", "EXEC", "EXECUTE", "GRANT", "REVOKE", "--", "/*"]
    for kw in dangerous:
        if kw in sql_upper:
            return {"sql_error": f"VALIDATION_ERROR: 不允許使用 {kw}"}
    return {"sql_error": ""}
```

驗證失敗時，`sql_error` 前綴為 `"VALIDATION_ERROR:"`，後面的路由函數用這個前綴判斷不走 execute、直接到 format。

---

### 第四步：sql_execute_node（執行 SQL）

**程式碼位置**：`agent.py:229`

```python
def sql_execute_node(state: Text2SQLState):
    with engine.connect() as conn:
        result = conn.execute(text(sql))
        columns = list(result.keys())
        rows = [
            {col: str(val) if val is not None else None
             for col, val in zip(columns, row)}
            for row in result
        ]
    return {"sql_result": json.dumps(rows, ensure_ascii=False), "sql_error": ""}
```

所有值轉為字串（`str(val)`），避免 `Decimal`、`datetime` 等型別序列化失敗。
發生例外時：

```python
    except Exception as e:
        return {"sql_error": str(e), "retry_count": retry_count + 1}
```

`retry_count` 在這裡遞增，路由函數（`agent.py:289`）讀到 `retry_count < 2` 才重試：

```python
def route_after_execute(state: Text2SQLState) -> str:
    if state.get("sql_error") and state.get("retry_count", 0) < 2:
        return "generate"   # 回到 sql_generate_node 重試
    return "format"
```

---

### 第五步：format_node（格式化回答）

**程式碼位置**：`agent.py:250`

有三種路徑：

1. **驗證失敗**（`sql_error` 以 `VALIDATION_ERROR:` 開頭）→ 直接回傳錯誤說明
2. **執行失敗且重試耗盡** → 回傳「已重試 N 次」的錯誤訊息
3. **查詢成功** → 組合 `FORMAT_PROMPT`（`agent.py:125`），把問題 + 查詢結果給 LLM，請它用繁體中文回答

```python
prompt = FORMAT_PROMPT.format(
    question=state["question"],
    count=len(rows),
    result=json.dumps(rows[:50], ensure_ascii=False, indent=2),  # 最多 50 筆
)
response = await self.llm.ainvoke([SystemMessage(content=prompt)])
```

---

### 路由邏輯總覽

```
classify → generate → validate
                           │ VALIDATION_ERROR ─────────────────┐
                           ↓                                    ↓
                        execute                              format → END
                           │ 失敗 + retry_count < 2
                           └──── generate（重試，最多 2 次）
                           │ 成功 or 重試耗盡
                           ↓
                        format → END
```

對應程式碼：

```python
# agent.py:284
def route_after_validate(state) -> str:
    return "format" if state.get("sql_error","").startswith("VALIDATION_ERROR") else "execute"

# agent.py:289
def route_after_execute(state) -> str:
    return "generate" if (state.get("sql_error") and state.get("retry_count",0) < 2) else "format"
```

---

### SSE 事件：api.py 如何從 astream_events 抓 SQL

**程式碼位置**：`api.py:170`

`astream_events v2` 會為每個節點的執行發出事件，api.py 監聽兩種：

```python
# 1. generate 節點執行完 → 發出 sql_query 事件（帶 SQL 給前端顯示）
if etype == "on_chain_end" and name == "generate":
    output = event["data"].get("output", {})
    sql = output.get("sql_query", "")
    if sql:
        sql_attempt += 1
        yield {"event": "sql_query",
               "data": json.dumps({"sql": sql, "query_type": qt, "attempt": sql_attempt})}

# 2. format 節點串流 token → 逐字發送給前端
elif etype == "on_chat_model_stream" and node == "format":
    chunk = event["data"]["chunk"].content
    if isinstance(chunk, str) and chunk:
        yield {"event": "token", "data": json.dumps({"content": chunk})}
```

`sql_attempt` 在 api.py 這層計數（不是從 state 讀），每次收到 `on_chain_end + name=="generate"` 就 +1，重試時自然變成 2、3，前端 SqlViewer 用這個數字顯示「重試 #N」徽章。

---

### 為什麼需要 alias_map？

**問題**：LLM 對「庫存不足」的 SQL 翻譯可能是 `stock < 0` 或 `quantity = 0`，但正確定義是 `quantity < min_stock`（低於安全庫存）。

**解法**：`alias_map.json` 把業務術語轉成確定性的 SQL 表達，注入 prompt 後 LLM 就能對齊業務定義：

```json
"庫存不足": "quantity < min_stock  (或 current_stock < min_stock)",
"庫存不足比例": "COUNT(*) FILTER(WHERE quantity < min_stock) * 100.0 / COUNT(*)"
```

`_format_alias_map()`（`agent.py:69`）將它格式化成條列文字注入 prompt。

---

### 為什麼設計 daily_snapshots 而不直接算 stock_changes？

要知道「過去 30 天有幾天庫存不足」，需要知道**每天結束時的庫存量**。從 `stock_changes` 反推需要按時序累加所有異動，SQL 寫起來複雜且 LLM 難以生成正確。

`daily_snapshots` 預先存好每天的快照，查詢「某天是否不足」只需 `quantity < min_stock`，LLM 能直接生成正確 SQL。
