# Case 8: MCP Server 開發

## 前置知識

建議先完成：
- **Case 2**：ReAct Agent（工具綁定、ToolNode、條件路由）

---

## 概念說明

### 核心問題

Case 2 的工具定義在後端的 `tools.py` 裡，工具和 Agent 綁在一起。如果另一個團隊也需要這些工具，他們要嗎複製程式碼，要嗎依賴你的後端。

**MCP（Model Context Protocol）的解法**：把工具獨立成一個可被任何 MCP 客戶端連接的 Server。工具的定義、執行邏輯、資料庫存取都在 Server 端；Agent 只負責呼叫，不需要知道工具怎麼實作的。

### 架構圖

```
使用者
  ↓
Frontend（React）
  ↓ HTTP / SSE
FastAPI（backend/api.py）
  │  lifespan: MultiServerMCPClient 建立連線
  │
  └──── stdio ────► python mcp_server/server.py（FastMCP）
                          │
                          └── data/kb.db（SQLite 知識庫）
```

兩個進程，一個 SQLite 檔案，透過 stdin/stdout 的 JSON-RPC 溝通。

### 關鍵元件

| 元件 | 角色 |
|------|------|
| `fastmcp` | 建立 MCP Server，用 `@mcp.tool()` 定義工具 |
| `langchain-mcp-adapters` | 連接 MCP Server，把工具轉成 LangChain `BaseTool` |
| `MultiServerMCPClient` | MCP 客戶端，管理連線生命週期 |
| `ToolNode` | LangGraph 內建節點，執行工具（和 Case 2 完全一樣） |

---

## 實踐內容

### 資料夾結構

```
case8_mcp_server/
  mcp_server/
    server.py         # FastMCP stdio server，4 個工具
    seed_data.py      # 15 篇範例文章
    requirements.txt  # fastmcp
  backend/
    agent.py          # KBAgent（手動 ReAct 圖，工具從外部注入）
    api.py            # FastAPI + lifespan（MCP Client）+ SSE
    config.py         # 含 mcp_server_path / kb_db_path 自動解析（絕對路徑）
    database.py       # conversations + messages
    models.py
    requirements.txt  # langchain-mcp-adapters + fastapi + langgraph
  frontend/
    src/
      App.tsx           # 3 欄佈局：Chat（中）+ KnowledgeBase（右）
      Chat.tsx          # 聊天介面（同 Case 2，SSE 邏輯不變）
      Chat.css
      KnowledgeBase.tsx # 右側文章瀏覽器
      KnowledgeBase.css
      main.tsx
  docker-compose.yaml
  Dockerfile.backend    # 同時複製 mcp_server/ 和 backend/ 進同一映像
  Dockerfile.frontend
  .env.example
  qa.md
```

---

## 程式碼導讀

### 1. MCP Server（`mcp_server/server.py`）

用 `fastmcp` 定義工具，比直接用 `mcp` SDK 少很多樣板程式碼：

```python
from fastmcp import FastMCP
mcp = FastMCP("Knowledge Base")

@mcp.tool()
def search_articles(query: str, limit: int = 5) -> str:
    """根據關鍵字搜尋知識庫文章。"""   # docstring 自動成為工具描述
    pattern = f"%{query}%"
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT ... FROM articles WHERE title LIKE ? OR content LIKE ? OR tags LIKE ? LIMIT ?",
            (pattern, pattern, pattern, limit),
        ).fetchall()
    return json.dumps([dict(r) for r in rows], ensure_ascii=False)  # 回傳值必須是 str

if __name__ == "__main__":
    mcp.run()   # stdio transport，等待 stdin 的 JSON-RPC 請求
```

工具的回傳值是 `str`（JSON 序列化），MCP 協定會把它包成 `TextContent` 傳回給客戶端。

**DB 路徑自動解析**：
```python
DB_PATH = Path(os.getenv("KB_DB_PATH", str(Path(__file__).parent.parent / "data" / "kb.db")))
```
`Path(__file__)` 是 `server.py` 自己的路徑，不依賴執行時的工作目錄，本機開發和 Docker 容器都能正確找到 `data/kb.db`。

---

### 2. MCP Client 生命週期（`backend/api.py`）

**注意**：`langchain-mcp-adapters 0.1.0+` 移除了 context manager 用法，改為直接實例化後呼叫 `await client.get_tools()`（`get_tools()` 現在是 async）。

```python
_mcp_tools: list = []      # lifespan 取得後快取，所有請求共用
_agent_cache: dict = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mcp_tools
    client = MultiServerMCPClient({
        "kb": {
            "command": "python",
            "args": [settings.mcp_server_path],
            "transport": "stdio",
        }
    })
    # get_tools() 同時負責：spawn 子程序 → MCP 握手 → 取得工具清單 → 包裝成 BaseTool
    _mcp_tools = await client.get_tools()
    init_db()
    yield
```

為什麼不能每次請求都建立？啟動一個 Python 子程序 + MCP 握手約需 200-500ms，對 API 請求來說太貴。

**串接多個 server**（設定 dict 加 key 即可，工具自動合併）：
```python
# api.py 的 MultiServerMCPClient 設定中有完整的註釋範例：
# - 本機另一個 stdio server（server2.py）
# - 遠端 streamable-http server
```

---

### 3. Agent 工具注入（`backend/agent.py` + `api.py`）

**Case 2 的方式**（工具在類別內部 import）：
```python
from tools import ALL_TOOLS
class ReActAgent:
    def __init__(self, llm_config):
        self.llm = ChatOpenAI(...).bind_tools(ALL_TOOLS)
```

**Case 8 的方式**（工具從外部注入）：
```python
# agent.py
class KBAgent:
    def __init__(self, llm_config, tools: list):  # tools 從外部傳入
        self.llm = ChatOpenAI(...).bind_tools(tools)

# api.py
async def get_or_create_agent(llm_config):
    # _mcp_tools 已在 lifespan 取得，直接使用
    _agent_cache[cache_key] = KBAgent(llm_config, _mcp_tools).create_agent()
```

`_mcp_tools` 裡的每個 `BaseTool` 內部封裝了「透過 stdio 呼叫 server.py」的邏輯，`ToolNode` 完全無感知。

---

### 4. 資料庫路徑（`backend/config.py`）

`kb_db_path` 和 `mcp_server_path` 都使用絕對路徑，以 `Path(__file__)` 為基準推算：

```python
kb_db_path: str = str(Path(__file__).parent.parent / "data" / "kb.db")
mcp_server_path: str = str(Path(__file__).parent.parent / "mcp_server" / "server.py")
```

`config.py` 在 `backend/`，`.parent.parent` 是 `case8_mcp_server/`，路徑在任何工作目錄下都正確。**若使用相對路徑，從 `backend/` 執行時會找錯位置（`backend/data/kb.db`）。**

---

### 5. SSE 工具事件序列化（`backend/api.py`）

MCP 工具的 `on_tool_start` 事件中，`tool_input` 包含 `ToolRuntime` 物件（langchain-mcp-adapters 注入的 runtime context），無法直接 `json.dumps`。解法：加上 `default=str` 讓非序列化物件退回字串：

```python
yield {
    "event": "tool_start",
    "data": json.dumps({
        "tool_input": tool_input,
        ...
    }, ensure_ascii=False, default=str),   # ← default=str 處理 ToolRuntime
}
```

本地 `@tool` 函數不會有這個問題，因為它們的 input 是純 Python dict。

---

### 6. Dockerfile.backend 複製兩個目錄

MCP Server 是後端的子程序，必須在同一個 Docker 映像裡：

```dockerfile
WORKDIR /app
COPY mcp_server/requirements.txt /tmp/mcp_req.txt
COPY backend/requirements.txt /tmp/back_req.txt
RUN pip install --no-cache-dir -r /tmp/mcp_req.txt -r /tmp/back_req.txt
COPY mcp_server/ /app/mcp_server/   # ← MCP Server
COPY backend/ /app/backend/         # ← FastAPI
WORKDIR /app/backend
CMD ["python", "api.py"]
```

和其他 Case 不同，`context: .`（專案根目錄），而非 `context: ./backend`。

---

### 7. KnowledgeBase 側邊欄（`frontend/src/KnowledgeBase.tsx`）

右側文章瀏覽器，直接呼叫 `GET /api/articles`（後端直接讀 `kb.db`，不走 MCP）：

```tsx
useEffect(() => {
  fetch('/api/articles').then(r => r.json()).then(setArticles)
}, [])

// 點擊「在對話中搜尋」→ 呼叫 onSearch callback → App.tsx 把字串傳給 Chat.tsx
<button onClick={() => onSearch?.(`搜尋「${article.title}」的相關內容`)}>
  在對話中搜尋
</button>
```

`/api/articles` 繞過 MCP 直接讀資料庫，避免每次刷新側邊欄都要透過 LLM。這是有意識的設計取捨：側邊欄不需要 AI，只需要快速列資料。

---

## 執行方式

### 本地開發（seed 資料 + 啟動）

```bash
# 1. 安裝相依套件
cd case8_mcp_server/mcp_server && pip install -r requirements.txt
cd ../backend && pip install -r requirements.txt

# 2. 載入範例資料（15 篇文章，冪等操作）—— 必須先執行，否則 /api/articles 會報錯
cd ../mcp_server && python seed_data.py

# 3. 啟動後端（會自動啟動 MCP Server 子程序）
cd ../backend && python api.py

# 4. 前端（另一個終端）
cd case8_mcp_server/frontend && npm install && npm run dev
```

### Docker

```bash
docker network create aiagent-network
cd case8_mcp_server
cp .env.example .env
docker-compose up -d
```

---

## 測試驗證

1. **MCP 連線**：`GET /api/health` 應回傳 `{"status": "ok", "mcp_tools_loaded": 4}`
2. **列出文章**：輸入「列出所有文章」→ Agent 應呼叫 `list_articles` 工具，前端顯示 `tool_start` + `tool_end` 面板
3. **搜尋**：輸入「搜尋 LangGraph 相關文章」→ Agent 呼叫 `search_articles`
4. **建立文章**：輸入「建立一篇關於 Kubernetes 的文章」→ Agent 自行生成內容並呼叫 `create_article`，重新整理側邊欄後應看到新文章
5. **KnowledgeBase 側邊欄**：點擊文章卡片的「在對話中搜尋」→ 聊天輸入框自動填入搜尋文字

---

## 延伸挑戰

1. **新增工具**：在 `server.py` 新增 `update_article(article_id: int, content: str)` 工具，不需要修改 backend 的任何程式碼
2. **streamable-http transport**：把 MCP Server 改為 streamable-http transport，讓它成為獨立的網路服務，`docker-compose.yaml` 拆成兩個服務；參考 `api.py` 中的註釋範例
3. **多 Server**：在 `MultiServerMCPClient` 的設定裡加入第二個本機 MCP Server（`server2.py`），觀察 `get_tools()` 回傳的工具清單如何合併；參考 `api.py` 中的註釋範例
