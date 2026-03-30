# LangGraph AI Agent 學習大綱

## 課程簡介

本課程透過 11 個獨立的實作案例（Case），從零開始學習使用 LangGraph 開發 AI Agent。每個 Case 都是一個完整的專案，包含 Python 後端（FastAPI + LangGraph）、React 前端、以及 Docker 部署配置。

## 技術棧

| 類別 | 技術 |
|------|------|
| Agent 框架 | LangGraph、LangChain |
| 後端 API | FastAPI、uvicorn、sse-starlette |
| 前端 | React、TypeScript、Vite |
| 資料庫 | SQLite（Case 1-10）、PostgreSQL 15（Case 11+，SQLAlchemy Core，非 ORM） |
| LLM | OpenAI API（相容介面，可替換為 Gemini / Ollama） |
| 部署 | Docker、docker-compose |
| 語言 | Python 3.11+、TypeScript |

## 前置準備

1. 安裝 [Conda](https://docs.conda.io/) 並建立 Python 3.11+ 虛擬環境
2. 安裝 [Node.js](https://nodejs.org/) 18+（前端開發）
3. 安裝 [Docker](https://www.docker.com/) 與 docker-compose
4. 準備 OpenAI API Key（或相容的 LLM API）
5. 建立 Docker 外部網路：`docker network create aiagent-network`

---

## 學習路線圖

```
Phase 1: 基礎篇
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Case 1          │    │  Case 2          │    │  Case 3          │
│  基礎聊天機器人   │ ──▶│  ReAct Agent     │ ──▶│  進階工具開發     │
│  StateGraph      │    │  工具 + 條件路由   │    │  Pydantic + DB   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
Phase 2: Agent 模式篇                                   ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Case 6          │    │  Case 5          │    │  Case 4          │
│  HITL            │◀── │  Map-Reduce      │◀── │  Plan-Execute    │
│  interrupt/resume│    │  Send() 並行     │    │  子圖 + 重規劃    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │
Phase 3: 進階篇       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Case 7          │    │  Case 8          │    │  Case 9          │
│  Prompt & Skills │ ──▶│  MCP Server      │ ──▶│  Multi-Agent     │
│  SKILL.md + 路由  │    │  工具封裝 + 協定  │    │  Supervisor 模式  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
Phase 4: 整合篇                                         ▼
                       ┌─────────────────┐
                       │  Case 10         │
                       │  全端整合         │
                       │  所有模式 + 生產級 │
                       └─────────────────┘
                                │
Phase 5: 專題篇                  ▼
                       ┌─────────────────┐
                       │  Case 11         │
                       │  Text-to-SQL     │
                       │  NL2SQL Agent    │
                       └─────────────────┘
```

> Case 4-5 可互換順序，Case 7-8 可互換順序，其餘建議按順序推進。

---

## 各 Case 總覽

### Phase 1: 基礎篇

#### Case 1: 基礎聊天機器人 (`case1_basic_chatbot`)
- **情境**：對話聊天機器人，SSE 串流回應
- **核心概念**：`StateGraph`、`AgentState`、`add_messages`、`MemorySaver`、`START/END`
- **學到什麼**：如何用 LangGraph 建立最基本的 Agent，連接 FastAPI 提供 SSE 串流 API，搭配 React 前端
- **教學文件**：[case1_basic_chatbot.md](./case1_basic_chatbot.md)

#### Case 2: ReAct Agent (`case2_react_agent`)
- **情境**：智慧研究助手，可使用搜尋、計算機、時間查詢工具
- **核心概念**：`bind_tools()`、`add_conditional_edges`、`ToolNode`、ReAct 迴圈
- **學到什麼**：Agent 如何自主判斷是否使用工具、條件路由的設計、工具呼叫的訊息流
- **教學文件**：[case2_react_agent.md](./case2_react_agent.md)

#### Case 3: 進階工具開發 (`case3_tool_development`)
- **情境**：庫存管理助手，CRUD + 計算 + 外部 API 工具
- **核心概念**：Pydantic `BaseModel` 工具參數、DB CRUD 工具、錯誤處理
- **學到什麼**：如何開發生產級工具、工具錯誤如何回饋給 LLM、多工具協作
- **教學文件**：[case3_tool_development.md](./case3_tool_development.md)

### Phase 2: Agent 模式篇

#### Case 4: Plan-Execute Agent (`case4_plan_execute`)
- **情境**：旅行規劃 Agent，多步驟行程規劃與執行
- **核心概念**：擴展 `AgentState`、子圖、`Command`、重新規劃
- **學到什麼**：如何分離規劃與執行、如何處理步驟失敗、複雜 State 設計
- **教學文件**：[case4_plan_execute.md](./case4_plan_execute.md)

#### Case 5: Map-Reduce 模式 (`case5_map_reduce`)
- **情境**：文件分析流水線，並行摘要多份文件
- **核心概念**：`Send()` 動態扇出、自訂 Reducer、`operator.add`
- **學到什麼**：並行處理模式、結果聚合、部分失敗處理
- **教學文件**：[case5_map_reduce.md](./case5_map_reduce.md)

#### Case 6: HITL (`case6_hitl`)
- **情境**：訂單處理 Agent，所有訂單皆需人工審批，商品模糊或數量未知時主動向使用者確認
- **核心概念**：`interrupt()`、`Command(resume=...)`、`AsyncSqliteSaver`、三階段 interrupt 鏈
- **學到什麼**：如何設計多個連續 interrupt 節點（數量確認 → 商品選擇 → 訂單審批）、AsyncSqliteSaver 的 lifespan 初始化模式、LLM 結構化輸出用於商品解析與語意比對（candidate_ids）
- **教學文件**：[case6_hitl.md](./case6_hitl.md)

### Phase 3: 進階篇

#### Case 7: Prompt & Skills 設計 (`case7_prompt_skills`)
- **情境**：多技能寫作助手（email、程式碼審查、摘要、翻譯）
- **核心概念**：SKILL.md 檔案式技能定義、SkillRegistry、意圖分類、few-shot XML 注入、Prompt Playground
- **學到什麼**：如何以純文字檔管理 prompt 與範例、意圖分類驅動條件路由、few-shot 業界注入慣例
- **教學文件**：[case7_prompt_skills.md](./case7_prompt_skills.md)

#### Case 8: MCP Server 開發 (`case8_mcp_server`)
- **情境**：知識庫 MCP Server + LangGraph Agent 消費者
- **核心概念**：MCP 協定、工具/資源/提示封裝、stdio + SSE 傳輸
- **學到什麼**：如何將工具標準化為 MCP Server、Agent 動態發現外部工具
- **教學文件**：[case8_mcp_server.md](./case8_mcp_server.md)

#### Case 9: 多 Agent 系統 (`case9_multi_agent`)
- **情境**：專案管理中心，Supervisor 分派任務給三個專家 Agent
- **核心概念**：Supervisor 模式、子圖封裝、`Command(goto=...)`、並行 Agent
- **學到什麼**：多 Agent 架構設計、Agent 間通訊、任務分派與結果聚合
- **教學文件**：[case9_multi_agent.md](./case9_multi_agent.md)

### Phase 4: 整合篇

#### Case 10: 全端整合 (`case10_full_stack`)
- **情境**：多模式 AI 助手，同一介面支援三種模式：一般聊天（Chat）、工具呼叫（Tools）、研究多 Agent（Research）
- **核心概念**：Router 動態路由（依使用者選擇分派 Agent）、ReAct+ToolNode 工具迴圈、Research Supervisor 多 Agent、統一 SSE 事件設計（`mode` / `tool_start` / `agent_start` / `token` / `done`）、自適應前端
- **學到什麼**：如何在單一後端整合不同 Agent 架構並用一套 SSE 協定對外、前端如何依模式動態切換視覺元件（ModeBadge、ToolCallPanel、AgentFlow）、10 個前端整合常見陷阱（langgraph_node 過濾、run_id 配對、assistantIdx 固定等）
- **教學文件**：[case10_full_stack.md](./case10_full_stack.md)

### Phase 5: 專題篇

#### Case 11: Text-to-SQL Agent (`case11_text_to_sql`)

**情境**：庫存歷史分析助手。使用者用自然語言詢問即時庫存狀況，也能查詢歷史趨勢（如「過去 30 天哪些產品庫存不足時間超過 50%」）。Agent 將問題轉為 SQL 查詢，完成無法用預定義工具回答的任意分析需求。

**為什麼需要 Text-to-SQL？**
延續 Case 3 的觀察：預定義工具只能處理「設計時想到的問題」，換個統計角度就要再寫新工具。歷史趨勢查詢的變體更多，用 Text-to-SQL 讓 LLM 自行生成 SQL，一個查詢介面回答所有問法。

**核心學習目標**：

| 技術點 | 說明 |
|--------|------|
| Schema 注入 | 將資料表結構（欄位名、型別、外鍵）注入 prompt，讓 LLM 知道「有什麼可以查」 |
| 術語對應表（alias mapping） | 建立業務用語 → 欄位名的對應（如「庫存不足」→ `quantity < min_stock`），解決專有名詞問題 |
| Few-shot SQL 範例 | prompt 中提供 7 個問答範例，顯著提升複雜查詢的生成品質 |
| SQL 安全驗證節點 | Agent graph 中加入驗證節點，拒絕 DDL/DML，只允許 SELECT |
| 錯誤自修正迴圈 | SQL 執行失敗時，將錯誤訊息回饋給 LLM，讓它重新生成（最多重試 2 次） |
| PostgreSQL 15 + 自訂 schema | `MetaData(schema="inventory")` 讓所有資料表自動帶 schema 前綴；`init_db()` 先建 schema 再 `create_all` |

**資料庫 Schema（PostgreSQL 15，schema = `inventory`）**：

```
inventory.products        — 產品主檔（id, name, category, unit, min_stock, current_stock, unit_price）
inventory.stock_changes   — 每次異動記錄（product_id, change_type, quantity, created_at）
inventory.daily_snapshots — 每日庫存快照（product_id, snapshot_date, quantity, min_stock）
                            用於時間序列計算，30 天快照（10 產品 × 30 天 = 300 筆）
```

`daily_snapshots` 是關鍵設計：直接從快照計算「某天庫存是否不足」，比從異動記錄推算簡單得多，SQL 也更容易讓 LLM 生成正確。

**Agent Graph 設計**：

```
START
  │
  ▼
[classify_node]        ← 判斷問題是即時查詢（realtime）還是歷史分析（historical）
  │
  ▼
[sql_generate_node]    ← schema_info.txt + alias_map.json + few_shot.json → LLM 生成 SQL
  │
  ▼
[sql_validate_node]    ← 驗證只含 SELECT，無危險關鍵字（純 Python，不呼叫 LLM）
  │ 驗證失敗 → route_after_validate → format_node（直接回傳錯誤說明）
  ▼
[sql_execute_node]     ← 執行 SQL，捕捉錯誤，retry_count++
  │ 執行失敗 + retry_count < 2 → route_after_execute → sql_generate_node（帶入錯誤訊息重試）
  ▼
[format_node]          ← LLM 將查詢結果格式化為易讀文字（串流輸出）
  │
  ▼
END
```

**State 設計**：

```python
class Text2SQLState(TypedDict):
    messages:       Annotated[list, add_messages]
    question:       str
    query_type:     str    # "realtime" | "historical"
    schema_context: str    # 注入的 schema 文字
    sql_query:      str    # 生成的 SQL
    sql_error:      str    # "" = 無錯誤；"VALIDATION_ERROR:..." 或執行期錯誤
    sql_result:     str    # JSON 格式的查詢結果
    retry_count:    int    # 重試次數（≤ 2）
    final_answer:   str
```

**SSE 事件設計**：

| 事件 | 觸發時機 | payload |
|------|---------|---------|
| `sql_query` | `sql_generate_node` 完成後（`on_chain_end` name=="generate"） | `{sql, query_type, attempt}` |
| `token` | `format_node` 串流中（`on_chat_model_stream` node=="format"） | `{content}` |
| `done` | 串流結束 | `{conversation_id}` |
| `error` | 例外捕捉 | `{message}` |

**資料夾結構**：

```
case11_text_to_sql/
  backend/
    agent.py              # Text2SQLAgent（5 個節點 + 2 個路由函數）
    api.py                # FastAPI：/api/conversations、/api/chat（SSE）
    database.py           # PostgreSQL + MetaData(schema="inventory") + init_db()
    models.py             # LlmConfig、ChatRequest、ConversationResponse
    config.py             # Settings（postgres_url、db_schema="inventory"）
    seed_data.py          # 從 seed_data.json 寫入 PostgreSQL（CLI --postgres-url）
    seed_data.json        # 10 產品、29 異動記錄、300 每日快照
    prompts/
      schema_info.txt     # PostgreSQL schema 說明（inventory. 前綴、日期函數）
      alias_map.json      # 業務術語 → SQL 表達對應表
      few_shot.json       # 7 個問答 + SQL 範例（含 query_type 標注）
    requirements.txt
  frontend/
    src/
      App.tsx
      Chat.tsx            # SSE dispatch：sql_query→SqlViewer、token→bubble 串流
      Chat.css
      SqlViewer.tsx       # 顯示 SQL + 查詢類型徽章 + 重試徽章（可展開/收合）
      SqlViewer.css
      main.tsx
    index.html
    package.json
    vite.config.ts
    tsconfig.json / tsconfig.node.json
  docker-compose.yaml     # case11-postgres（postgres:15，無對外 port）+ backend + frontend
  Dockerfile.backend
  Dockerfile.frontend
  .env.example            # BACKEND_PORT=8016, FRONTEND_PORT=8017
  qa.md
```

**前端特色**：`SqlViewer` 元件顯示 Agent 本次生成並執行的 SQL，附查詢類型徽章（即時查詢＝藍、歷史分析＝紫）及重試徽章（重試次數 > 1 時顯示），讓使用者能驗證查詢邏輯是否符合預期（透明度設計）。

**能回答的問題範例**：
- 「查詢目前所有庫存不足的電子產品」（即時）
- 「過去 30 天哪些產品庫存不足時間超過 50%？」（歷史趨勢）
- 「上個月庫存異動最頻繁的前 3 個產品」（歷史統計）
- 「辦公用品的平均庫存覆蓋率趨勢」（時間序列）

**教學文件**：[case11_text_to_sql.md](./case11_text_to_sql.md)

---

#### Case 12: 企業採購申請暨多層審批 Agent (`case12_procurement_hitl`)

**情境**：員工以自然語言提交辦公設備採購申請，系統依需求的完整程度與採購金額，依序觸發多達五道確認/審批關卡。相較於 Case 6 的三道關卡，本案例設計更複雜的中斷鏈與序列式多層審批（部門主管→財務長），並以 PostgreSQL 取代 SQLite 作為 checkpointer 後端。

**為什麼要在 Case 6 之後做這個案例？**

Case 6 示範了 HITL 的核心機制，但情境相對單純（最多三道關卡，金額門檻固定）。真實企業場景往往需要：
- 依採購金額觸發不同層級的審批（小額自動、中額主管、大額財務）
- 序列式審批：財務長審批必須在部門主管核准之後才出現
- 保存完整的審批歷程（誰在什麼時間做了什麼決定）
- 生產環境的 PostgreSQL 持久化（高並發、可查詢審批報表）

**核心學習目標**：

| 技術點 | 說明 |
|--------|------|
| `AsyncPostgresSaver` | 取代 SQLite；`await cp.setup()` 建立 checkpoint 資料表 |
| 序列式多層審批 | 主管核准後 state 流入財務審批節點，每層結果記錄在 `approval_history` |
| 動態路由依金額分級 | `< NT$5,000` 自動通過、`5,000~50,000` 主管審批、`> 50,000` 雙層審批 |
| 審批歷程追蹤 | `approval_history: list[dict]` 累積每層決定，最終寫入 DB |
| PostgreSQL + Docker | compose 加入 postgres service、healthcheck、volume 持久化 |

**五道 interrupt 節點（依觸發順序）**：

| # | 節點 | 觸發條件 | 前端卡片 |
|---|------|---------|---------|
| 1 | `spec_clarify_node` | 商品規格不明確（如「一台電腦」未說用途/等級） | `SpecClarify`（規格選項卡） |
| 2 | `quantity_clarify_node` | 採購數量未指定 | `QuantityClarify`（數量輸入卡） |
| 3 | `vendor_clarify_node` | 多個合格供應商，需申請人確認偏好 | `VendorSelector`（供應商選擇卡） |
| 4 | `manager_approval_node` | 採購金額 NT$5,000~NT$50,000 | `ApprovalCard`（主管審批） |
| 5 | `finance_approval_node` | 採購金額 > NT$50,000（且主管已核准） | `ApprovalCard`（財務審批） |

**完整圖結構**：

```
START → parse_request_node（LLM 解析 + 商品目錄比對）
    ↓ route_after_parse
    ├── spec_unclear → spec_clarify_node (interrupt #1)
    │       ↓ 規格確認後，可能仍觸發 quantity / vendor
    ├── qty_unknown → quantity_clarify_node (interrupt #2)
    │       ↓ 數量確認後，可能觸發 vendor
    └── vendor_ambiguous → vendor_clarify_node (interrupt #3)
    ↓（所有規格/數量/供應商確認後）
check_catalog_node（確認品項在核准供應商目錄內）
    ↓
calculate_cost_node（含批量折扣計算）
    ↓ route_by_amount
    ├── < 5,000 → auto_approve_node → create_request_node
    ├── 5,000~50,000 → manager_approval_node (interrupt #4)
    │       ↓ approved → create_request_node
    │       └ rejected → respond_node → END
    └── ≥ 50,000 → manager_approval_node (interrupt #4)
            ↓ approved → finance_approval_node (interrupt #5)
            │       ↓ approved → create_request_node
            │       └ rejected → respond_node → END
            └ rejected → respond_node → END
create_request_node → respond_node → END
```

**State 設計**：

```python
class ProcurementState(TypedDict):
    messages:               Annotated[list, add_messages]
    thread_id:              str
    requester_name:         str
    department:             str

    # 解析結果（依完整程度分配到不同列表）
    parsed_items:           list[dict]  # [{catalog_id,name,qty,unit_price,vendor_id}]
    spec_unclear_items:     list[dict]  # [{item_name, spec_options:[...]}]
    qty_unknown_items:      list[dict]  # [{item_name, matched_catalog, vendors:[...]}]
    vendor_options:         list[dict]  # [{item_name, candidates:[{vendor_id,name,price}]}]

    # 金額
    cost_details:           dict        # {items,subtotal,bulk_discount,total}

    # 審批鏈
    approval_tier:          str         # "auto"|"manager"|"finance"
    approval_history:       list[dict]  # [{level,action,comment,timestamp}]

    # 結果
    error_message:          str
    request_id:             str
    response:               str
```

**資料庫 Schema**：

```
departments          — 部門主檔（id, name, manager_email, budget_remaining）
approved_vendors     — 核准供應商（id, name, category, contact）
catalog_items        — 採購目錄（id, name, category, spec_level, unit_price, vendor_id, min_order）
purchase_requests    — 採購申請主表（id, thread_id, requester, dept_id, total, status, created_at）
request_items        — 採購申請明細（request_id, catalog_id, qty, unit_price）
approval_log         — 審批歷程（request_id, level, approver_role, action, comment, decided_at）
```

約 30 個目錄品項（辦公設備、IT 硬體、辦公家具、會議室設備、消耗品等五大類）、3 個供應商。

**PostgreSQL Checkpointer 設定（與 Case 6 SQLite 的差異）**：

```python
# checkpointer.py
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

def get_checkpointer_cm():
    return AsyncPostgresSaver.from_conn_string(settings.postgres_url)
```

```python
# api.py — lifespan（多一行 await cp.setup()）
async with get_checkpointer_cm() as cp:
    await cp.setup()   # 在 PostgreSQL 建立 checkpoint 系統資料表
    cp_module.checkpointer = cp
    yield
```

**資料夾結構**：

```
case12_procurement_hitl/
  backend/
    agent.py              # ProcurementAgent（5 個 interrupt 節點 + 序列審批）
    api.py                # FastAPI：7 個端點
    checkpointer.py       # AsyncPostgresSaver（取代 AsyncSqliteSaver）
    config.py             # postgres_url、approval_thresholds（雙門檻）
    database.py           # 6 張資料表（含 approval_log）
    models.py             # ParsedProcurementItem（含 spec_unknown、vendor_options）
    tools/
      catalog.py          # check_catalog（驗證品項在核准目錄內）
      pricing.py          # calculate_cost（批量折扣規則）
      request.py          # create_purchase_request、log_approval
    seed_data.py          # 3 個部門、3 個供應商、30 個目錄品項
    requirements.txt      # 含 langgraph-checkpoint-postgres、psycopg[binary,pool]
  frontend/
    src/
      Chat.tsx            # 5 種特殊訊息卡片
      Chat.css
      SpecClarify.tsx     # 規格選項卡（多選按鈕）
      SpecClarify.css
      QuantityClarify.tsx # 數量輸入（複用 Case 6 設計）
      QuantityClarify.css
      VendorSelector.tsx  # 供應商選擇卡
      VendorSelector.css
      ApprovalCard.tsx    # 審批卡（顯示審批層級：主管/財務）
      ApprovalCard.css
      ApprovalHistory.tsx # 審批歷程時間軸（申請提交後可展開）
      ApprovalHistory.css
      App.tsx
      main.tsx
    ...
  docker-compose.yaml     # 含 postgres service + healthcheck
  Dockerfile.backend
  Dockerfile.frontend
  .env.example            # 含 POSTGRES_URL、MANAGER_APPROVAL_THRESHOLD、FINANCE_APPROVAL_THRESHOLD
  qa.md
```

**前端特色**：`ApprovalHistory` 元件在審批流程完成後顯示完整時間軸（申請送出→主管核准→財務核准→採購建立），讓申請人清楚追蹤每個關卡的處理時間與結論。

**API 端點**：

| 端點 | 說明 |
|------|------|
| `POST /api/chat` | 初始採購請求，偵測 5 種 interrupt |
| `POST /api/chat/{id}/clarify-spec` | 規格確認後恢復 |
| `POST /api/chat/{id}/clarify-quantity` | 數量確認後恢復 |
| `POST /api/chat/{id}/select-vendor` | 供應商選擇後恢復 |
| `POST /api/requests/{id}/manager-decide` | 部門主管審批決定 |
| `POST /api/requests/{id}/finance-decide` | 財務長審批決定 |
| `GET /api/requests/pending` | 取得待審批清單（依層級分組） |

**教學文件**：[case12_procurement_hitl.md](./case12_procurement_hitl.md)（待建立）

---

## 專案結構

```
claude-aiagent/
├── CLAUDE.md                      # 專案規範與指引
├── refenrece/                     # 參考資料（UI 設計、程式碼模板）
│   ├── Chat.tsx                   # 前端聊天介面參考
│   ├── Chat.css                   # 設計系統參考
│   ├── CLAUDE.md                  # 原專案文件參考
│   └── langgraph-template.py      # LangGraph 程式碼模板
├── tutorials/                     # 教學文件
│   ├── overall.md                 # 本文件（學習大綱）
│   ├── case1_basic_chatbot.md
│   ├── case2_react_agent.md
│   └── ...
├── case1_basic_chatbot/           # Case 1 完整專案
│   ├── backend/
│   ├── frontend/
│   ├── docker-compose.yaml
│   └── ...
├── case2_react_agent/             # Case 2 完整專案
└── ...
```

## 共用規範

### Agent 程式碼模板
所有 Agent 遵循 `refenrece/langgraph-template.py` 的類別式結構：
```python
class {Purpose}Agent:
    def __init__(self):
        self.llm = ChatOpenAI(...)

    async def create_agent(self):
        # node functions → route functions → build graph → compile
        return agent
```

### 資料庫
- SQLAlchemy Core（不使用 ORM），Case 1-10 用 SQLite，Case 11+ 用 PostgreSQL 15
- PostgreSQL 使用自訂 schema（非 public），`MetaData(schema=...)` 自動帶 schema 前綴
- `init_db()` 先執行 `CREATE SCHEMA IF NOT EXISTS` 再 `create_all`

### 前端設計
- 深藍金色主題（深色預設，`.light` 亮色覆寫）
- Sidebar + Topbar + Messages + Input 佈局
- SSE 串流、Markdown 渲染

### Docker
- `docker-compose.yaml` 使用外部網路 `aiagent-network`
- 對外 port 寫在 `.env`
- logging: 3 份檔案、每份 10m
- labels: 開發者名稱 + 專案路徑

---

## 開發進度

| Case | 狀態 | 備註 |
|------|------|------|
| Case 1 | ✅ 完成 | 基礎聊天機器人（StateGraph、SSE 串流） |
| Case 2 | ✅ 完成 | ReAct Agent（工具綁定、條件路由、工具視覺化） |
| Case 3 | ✅ 完成 | 進階工具開發（Pydantic schema、DB CRUD、雙模式 Ollama/OpenAI） |
| Case 4 | ✅ 完成 | Plan-Execute Agent（擴展 State、planner/executor/replanner、PlanTimeline 視覺化） |
| Case 5 | ✅ 完成 | Map-Reduce 模式（Send() 動態扇出、並行分析、ProgressDashboard 視覺化） |
| Case 6 | ✅ 完成 | Human-in-the-Loop（3 階段 interrupt：數量確認→商品選擇→訂單審批、AsyncSqliteSaver、candidate_ids 語意比對） |
| Case 7 | ✅ 完成 | Prompt & Skills（SKILL.md 檔案式技能、意圖分類→條件路由、few-shot XML 注入、Prompt Playground） |
| Case 8 | ✅ 完成 | MCP Server（FastMCP stdio、langchain-mcp-adapters、MultiServerMCPClient lifespan、知識庫側邊欄） |
| Case 9 | ✅ 完成 | Multi-Agent Supervisor（Command goto 動態路由、with_structured_output 路由決策、langgraph_node 事件過濾、AgentFlow inline 視覺化、SSE \r\n 行結尾解析） |
| Case 10 | ✅ 完成 | 全端整合（Router 動態路由 3 模式、ReAct+ToolNode 工具迴圈、Research Multi-Agent、統一 SSE 事件設計、自適應前端 ModeBadge + ToolCallPanel + AgentFlow） |
| Case 11 | ✅ 完成 | Text-to-SQL Agent（PostgreSQL 15、inventory schema、classify→generate→validate→execute 重試迴圈、SqlViewer 前端） |
| Case 12 | ⏳ 待開始 | 企業採購申請（5 道 interrupt、序列多層審批、AsyncPostgresSaver） |
