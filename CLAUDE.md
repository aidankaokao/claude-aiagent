# CLAUDE.md

此檔案提供 Claude Code 在此專案中操作時的參考指引。

## 專案概述

LangGraph AI Agent 學習教程專案。透過 11 個獨立 Case，從基礎到進階學習 AI Agent 開發。

## 重要前提

**所有工具、套件、模型的選擇，必須以開源免費為原則。** 優先選擇 Apache 2.0、MIT、GPL 等明確開源授權的方案。

**每次修改完成後，必須列出所有異動的檔案**，格式如下：
```
新增：path/file1, path/file2
修改：path/file3
刪除：（無）
```

**不可以執行程式**，只能新增、修改、刪除程式碼。執行由使用者自行操作。

**不可以訪問或修改專案路徑以外的檔案。**

---

## 專案結構

```
claude-aiagent/
├── CLAUDE.md                    # 本文件
├── refenrece/                   # 參考資料（UI 設計 + 程式碼模板）
│   ├── Chat.tsx / Chat.css      # 前端設計系統參考
│   ├── CLAUDE.md                # 原專案文件參考
│   └── langgraph-template.py    # LangGraph Agent 模板
├── tutorials/                   # 教學文件
│   ├── overall.md               # 學習大綱
│   └── case{N}_xxx.md           # 各 Case 教學文件
├── case1_basic_chatbot/         # Case 1: 基礎聊天機器人 ✅
│   ├── backend/
│   ├── frontend/
│   ├── qa.md                    # Q&A 筆記（每個 Case 都有）
│   ├── docker-compose.yaml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── .env.example
├── case2_react_agent/           # Case 2: ReAct Agent ✅
│   ├── backend/
│   ├── frontend/
│   ├── qa.md
│   ├── docker-compose.yaml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── .env.example
├── case3_tool_development/      # Case 3: 進階工具開發 ✅
│   ├── backend/
│   ├── frontend/
│   ├── qa.md
│   ├── docker-compose.yaml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── .env.example
├── case4_plan_execute/          # Case 4: Plan-Execute Agent ✅
│   ├── backend/
│   ├── frontend/
│   ├── qa.md
│   ├── docker-compose.yaml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── .env.example
├── case5_map_reduce/            # Case 5: Map-Reduce 模式 ⏳
├── case6_hitl/                  # Case 6: Human-in-the-Loop ✅
├── case7_prompt_skills/         # Case 7: Prompt & Skills ✅
├── case8_mcp_server/            # Case 8: MCP Server ⏳
├── case9_multi_agent/           # Case 9: 多 Agent 系統 ✅
├── case10_full_stack/           # Case 10: 全端整合 ✅
├── case11_text_to_sql/          # Case 11: Text-to-SQL Agent 🔧
└── case12_procurement_hitl/     # Case 12: 企業採購申請 HITL（PostgreSQL） ⏳
```

---

## 技術棧

| 類別 | 技術 |
|------|------|
| Agent 框架 | LangGraph、LangChain |
| 後端 API | FastAPI、uvicorn、sse-starlette |
| 前端 | React、TypeScript、Vite |
| 資料庫 | SQLite（Case 1-10）、PostgreSQL 15（Case 11+，SQLAlchemy Core，非 ORM） |
| 部署 | Docker、docker-compose |

---

## 開發規範

### API Key 處理原則

- **API Key 不寫入 `.env`，不存於後端**
- 前端 Sidebar 提供設定面板，使用者自行填入（儲存於記憶體，關閉頁面即清除）
- 每次 API 請求將 `llm_config`（含 api_key）隨 request body 傳入後端
- 後端依 `(api_key, base_url, model)` 快取編譯後的 Agent 實例
- `seed_data.py` 等腳本若需要 API Key，改用 CLI 參數：`python seed_data.py --api-key sk-...`

### 伺服器 Port 規範

- 後端本地開發固定監聽 **8000**（hardcode 於 `api.py`）
- `BACKEND_PORT` / `FRONTEND_PORT` 寫在 `.env`，**僅供 docker-compose port mapping 使用**
- `vite.config.ts` 的 proxy 固定指向 `localhost:8000`
- `pydantic-settings` 的 `Settings` 加上 `extra = "ignore"`，忽略 `.env` 中多餘欄位

### Agent 程式碼模板

所有 Agent 遵循 `refenrece/langgraph-template.py` 的類別式結構：
```python
class {Purpose}Agent:
    def __init__(self, llm_config: LlmConfig):
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )

    async def create_agent(self):
        # === node functions ===
        # === route functions ===
        # === build graph ===
        graph = StateGraph(AgentState)
        # add nodes → add edges → compile
        agent = graph.compile(checkpointer=MemorySaver())
        return agent
```

### 資料庫

- SQLAlchemy Core（`Table` + `MetaData`），**不使用 ORM**
- `metadata.create_all(engine)` 自動建表
- 所有查詢使用 `connection.execute(select(...))`
- **PostgreSQL（Case 11+）**：
  - image 使用 `postgres:15`，schema 不使用 `public`（自訂 schema 名稱）
  - `MetaData(schema="<schema_name>")` 指定 schema
  - `init_db()` 先執行 `CREATE SCHEMA IF NOT EXISTS <schema>` 再 `create_all`
  - Container 內 postgres 不對外暴露 port，只供同網路的後端容器使用
  - `seed_data.py` 從 `seed_data.json` 讀取資料，透過 SQLAlchemy Core 寫入 PostgreSQL
- `Settings` 中的 `db_path` 預設相對路徑，Container 內映射至 volume

### Docker 規範

- `docker-compose.yaml` 使用外部網路 `aiagent-network`（`external: true`）
- 對外 port 寫在 `.env`（`BACKEND_PORT`、`FRONTEND_PORT`），**容器內部固定用 8000 / 5173**
- logging: `json-file`、`max-size: 10m`、`max-file: 3`
- labels: `developer=${DEVELOPER_NAME}`、`project.path=${PROJECT_PATH}`
- 部署指令：`docker-compose up -d`

### 前端設計系統

- 深藍金色主題（深色預設，`.light` 類別覆寫）
- CSS 變數：`--bg`, `--surface`, `--border`, `--text`, `--muted`, `--gold`, `--gold-dim` 等（完整清單見 `refenrece/Chat.css`）
- 字型：Noto Sans TC、DM Mono（Google Fonts，定義於 `index.html`）
- 版面：Topbar 56px + Sidebar 260px（可收折 52px）+ Messages + Input
- 訊息泡泡：使用者（金色底，`border-radius: 12px 4px 12px 12px`）、助手（半透明底，`border-radius: 4px 12px 12px 12px`）
- SVG 圖示：inline，`viewBox="0 0 24 24"`, `stroke="currentColor"`, `strokeWidth="1.8"`
- 動畫：`fadeUp`、`fadeIn`、`cubic-bezier(0.16, 1, 0.3, 1)`
- Markdown 渲染：`react-markdown` + `remark-gfm`

### Case 結構規範

每個 Case 資料夾必須包含：
```
case{N}_{name}/
  backend/          # Python 後端
  frontend/         # React 前端
  qa.md             # Q&A 筆記（初始為空，使用者閱讀後提問再補充）
  docker-compose.yaml
  Dockerfile.backend
  Dockerfile.frontend
  .env.example      # 不含 API Key
```

- 每個 Case 資料夾完全獨立，不可跨 Case 引用
- 後續 Case 可複製前面 Case 的共用部分再修改
- 每次完成一個 Case，同步更新 `tutorials/overall.md` 的開發進度

---

## 開發進度

| Case | 狀態 | 說明 |
|------|------|------|
| Case 1 | ✅ 完成 | 基礎聊天機器人（StateGraph、SSE 串流） |
| Case 2 | ✅ 完成 | ReAct Agent（工具綁定、條件路由、工具呼叫視覺化） |
| Case 3 | ✅ 完成 | 進階工具開發（Pydantic args_schema、DB CRUD 工具、雙模式 Ollama/OpenAI、統計工具） |
| Case 4 | ✅ 完成 | Plan-Execute Agent（擴展 State、planner/executor/replanner、PlanTimeline 視覺化） |
| Case 5 | ✅ 完成 | Map-Reduce 模式（Send() 動態扇出、並行分析、ProgressDashboard 視覺化） |
| Case 6 | ✅ 完成 | Human-in-the-Loop（3 階段 interrupt：數量確認→商品選擇→訂單審批、AsyncSqliteSaver、candidate_ids 語意比對） |
| Case 7 | ✅ 完成 | Prompt & Skills 設計（意圖分類條件路由、SKILL.md 檔案式技能、SkillRegistry、few-shot XML 注入、Prompt Playground） |
| Case 8 | ✅ 完成 | MCP Server 開發（FastMCP stdio server、langchain-mcp-adapters、MultiServerMCPClient lifespan、KnowledgeBase 側邊欄） |
| Case 9 | ✅ 完成 | 多 Agent 系統（Supervisor 模式、Command goto、with_structured_output、AgentFlow inline 視覺化、SSE \r\n 行結尾解析） |
| Case 10 | ✅ 完成 | 全端整合（Router 動態路由、ReAct+ToolNode、Research Multi-Agent、mode/tool_start/agent_start 統一 SSE 設計、ModeBadge + ToolCallPanel + AgentFlow 自適應前端） |
| Case 11 | 🔧 開發中 | Text-to-SQL Agent（PostgreSQL 15、inventory schema、schema 注入、alias_map、few-shot SQL、SQL 驗證、錯誤自修正重試、SqlViewer 前端） |
| Case 12 | ⏳ 待開發 | 企業採購申請 HITL（AsyncPostgresSaver、5 道 interrupt 關卡、序列式多層審批、審批歷程記錄） |
