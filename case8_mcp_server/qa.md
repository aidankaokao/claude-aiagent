# Case 8 Q&A 筆記 — MCP Server + LangGraph ReAct Agent

---

## Q1：langchain-mcp-adapters vs 直接使用 MCP SDK，差異是什麼？

### 兩種方式的程式碼比較

**方式 A：使用 langchain-mcp-adapters（本 Case 採用）**

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "kb": {
        "command": "python",
        "args": ["mcp_server/server.py"],
        "transport": "stdio",
    }
}) as client:
    tools = client.get_tools()  # 直接取得 list[BaseTool]，可直接用於 LangGraph
    llm_with_tools = ChatOpenAI(...).bind_tools(tools)
    tool_node = ToolNode(tools)
    # 正常建構 LangGraph 圖...
```

**方式 B：直接使用 MCP SDK（手動橋接）**

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from langchain_core.tools import StructuredTool

async with stdio_client(StdioServerParameters(command="python", args=["server.py"])) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        mcp_tools = (await session.list_tools()).tools

        # 手動將每個 MCP Tool 包裝成 LangChain StructuredTool
        lc_tools = []
        for t in mcp_tools:
            async def call_tool(tool_name=t.name, **kwargs):
                result = await session.call_tool(tool_name, kwargs)
                return result.content[0].text if result.content else ""
            lc_tools.append(StructuredTool.from_function(
                coroutine=call_tool,
                name=t.name,
                description=t.description,
            ))
        # 之後才能用於 LangGraph...
```

### 比較表

| 面向 | langchain-mcp-adapters | 直接使用 MCP SDK |
|------|------------------------|-----------------|
| 程式碼量 | 少（5-10 行） | 多（20-40 行，需手動橋接） |
| 工具轉換 | 自動（內部處理） | 手動（需逐一包裝為 StructuredTool） |
| 多 Server 支援 | 原生（dict key 區分多個 Server） | 需自行實作連線管理邏輯 |
| 型別安全 | 高（BaseTool 標準介面） | 中（手動包裝時容易出錯） |
| 彈性 | 中（依賴 langchain-mcp-adapters 版本） | 高（完全控制每個細節） |
| 適用場景 | LangChain / LangGraph 專案 | 非 LangChain 的框架或自定義 AI runtime |

### 結論

使用 LangChain / LangGraph 時，`langchain-mcp-adapters` 是正確選擇，可以大幅減少橋接程式碼，讓開發者專注於 Agent 邏輯。

直接使用 MCP SDK 的情境：
- 自行開發 AI Runtime（不依賴 LangChain）
- 需要精細控制工具呼叫的序列化格式
- 整合至其他框架（如 LlamaIndex、AutoGen）

---

## Q2：MultiServerMCPClient 的 lifespan 模式是什麼？為什麼不在每次請求時建立？

### Lifespan 模式說明

`langchain-mcp-adapters 0.1.0+` 版本的正確用法（舊版 context manager 寫法已移除）：

```python
# api.py

_mcp_tools: list = []   # 啟動時取得一次，後續 Agent 建立直接使用
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
    # 0.1.0+ get_tools() 改為 async，同時負責啟動子程序並取得工具清單
    _mcp_tools = await client.get_tools()
    init_db()
    yield
```

### 為什麼必須 Keep-Alive？

**如果在每次 `/api/chat` 請求時建立 MCP Client（❌ 錯誤做法）：**

```python
@app.post("/api/chat")
async def chat(req):
    client = MultiServerMCPClient({...})
    tools = await client.get_tools()   # 每次都啟動新子程序！
    agent = KBAgent(llm_config, tools).create_agent()
    # 處理請求...
```

這樣做的代價：
1. **每次請求都需要 spawn 一個新 Python 子程序**（`python mcp_server/server.py`），開銷約 200-500ms
2. **每次都需要完成 MCP 協定握手**（初始化、列出工具），又是數十毫秒
3. **每次請求後子程序立即終止**，下次又重啟，CPU/記憶體浪費嚴重

**使用 lifespan keep-alive（✅ 正確做法）：**

- 子程序只在應用程式啟動時建立一次
- 後續請求直接使用已初始化的連線，工具呼叫延遲極低
- 子程序在應用程式關閉時才終止，資源管理乾淨

### Agent 快取如何與 MCP Client 互動

```
應用程式啟動
    │
    ├── MCP Client 建立 ──► mcp_server/server.py 子程序啟動
    │                                             │
    ├── 第一次請求 (model=gpt-4o-mini)           │
    │   ├── cache miss → 建立 KBAgent            │
    │   │   └── tools = _mcp_client.get_tools()◄─┘ (已連線，直接取得)
    │   └── _agent_cache["xxxx:gpt-4o-mini"] = agent
    │
    ├── 第二次請求 (model=gpt-4o-mini)
    │   └── cache hit → 直接使用已建立的 agent（tools 仍指向同一個 MCP Client）
    │
    └── 應用程式關閉 → MCP Client context manager 終止子程序
```

---

## Q3：MCP Server 與 Agent 分別跑在哪裡？stdio transport 的運作方式？

### 執行架構

```
宿主機（或 Docker 容器）

  FastAPI 行程（backend/api.py）
    │
    │  lifespan 啟動時呼叫 MultiServerMCPClient
    │
    └── 以子行程（subprocess）方式啟動：
        python /app/mcp_server/server.py
            │
            │  stdout（工具回應：JSON-RPC response）
            │◄────────────────────────────────────
            │  stdin（工具呼叫：JSON-RPC request）
            │────────────────────────────────────►
            │
            └── SQLite (data/kb.db)
```

### stdio 通訊流程（JSON-RPC over stdin/stdout）

1. FastAPI 行程透過 `subprocess.Popen` 啟動 `mcp_server/server.py`
2. 雙方透過 **標準輸入輸出（stdin/stdout）** 交換 JSON-RPC 2.0 格式的訊息
3. 工具呼叫流程：
   ```
   FastAPI          JSON-RPC（stdin）          mcp_server
   ──────────────────────────────────────────────────────
   LLM 要呼叫        ──────────────────────►   解析請求
   search_articles   {"method": "tools/call",   執行 SQLite
                      "params": {...}}          查詢
                    ◄──────────────────────    回傳結果
                     {"result": {"content": [...] }}
   ```

### 為什麼選擇 stdio 而非 HTTP transport？

| 比較 | stdio | HTTP/SSE |
|------|-------|----------|
| 部署複雜度 | 低（同映像） | 高（需獨立服務） |
| 效能 | 極高（行程間通訊） | 較低（HTTP 開銷） |
| 適合場景 | 本機整合、同容器 | 跨網路、多客戶端共用 |
| 本 Case 採用 | ✅ | ─ |

---

## Q5：MCP Server 如何實現一個工具？從 `@mcp.tool()` 到實際執行的完整流程

### 定義一個工具只需三步

**Step 1：建立 FastMCP 實例（`server.py` 第 65 行）**

```python
from fastmcp import FastMCP
mcp = FastMCP("Knowledge Base")   # "Knowledge Base" 是 server 的名稱
```

**Step 2：用 `@mcp.tool()` 裝飾一個普通函數（`server.py` 第 72-102 行）**

```python
@mcp.tool()
def search_articles(query: str, limit: int = 5) -> str:
    """根據關鍵字搜尋知識庫文章。"""  # ← docstring 自動成為工具的 description
    pattern = f"%{query}%"
    with get_conn() as conn:
        rows = conn.execute("SELECT ... FROM articles WHERE title LIKE ? ...", ...).fetchall()
    return json.dumps([dict(r) for r in rows], ensure_ascii=False)  # ← 回傳值必須是 str
```

FastMCP 從這個函數自動推斷三件事：
- **工具名稱**：函數名稱 `search_articles`
- **工具描述**：docstring 第一行
- **參數 schema**：Python 型別標注（`str`、`int`）→ 自動產生 JSON Schema，供 LLM 知道要傳什麼參數

**Step 3：啟動 stdio server（`server.py` 第 215-217 行）**

```python
if __name__ == "__main__":
    mcp.run()   # 預設 transport = stdio，進入事件迴圈等待 stdin 的 JSON-RPC 請求
```

`mcp.run()` 之後，這個程序就會阻塞等待，從 stdin 讀取 JSON-RPC 請求，執行對應工具函數，再把結果寫回 stdout。

### 工具回傳值的規則

MCP 協定規定工具回傳的是 `TextContent`（一種包裹文字的物件）。FastMCP 做了自動轉換：

```
Python 函數 return "..." (str)
    → FastMCP 自動包成 TextContent(type="text", text="...")
    → 透過 stdout 以 JSON-RPC response 格式傳出
```

這就是為什麼工具函數都 `return json.dumps(...)` 而不是 `return dict`：因為最終傳到 LLM 的是純文字，LLM 自己解讀 JSON 字串。

### 資料庫路徑的自動解析（`server.py` 第 29-33 行）

```python
DB_PATH = Path(
    os.getenv("KB_DB_PATH", str(Path(__file__).parent.parent / "data" / "kb.db"))
)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
```

`Path(__file__)` 是 `server.py` 自己的路徑，`.parent.parent` 往上兩層就是 `case8_mcp_server/`，所以 db 固定在 `case8_mcp_server/data/kb.db`。這個寫法在本機開發和 Docker 容器內都正確，不依賴執行時的工作目錄。

---

## Q6：MCP Client 如何連線並使用工具？`MultiServerMCPClient` 做了什麼事

### 連線的完整流程（對照 `backend/api.py`）

**Phase 1：啟動子程序（lifespan，`api.py` 第 96-108 行）**

```python
client = MultiServerMCPClient({
    "kb": {                                     # "kb" 是這個 server 的別名
        "command": "python",
        "args": [settings.mcp_server_path],     # mcp_server/server.py 的絕對路徑
        "transport": "stdio",
    }
})
_mcp_tools = await client.get_tools()
```

`await client.get_tools()` 做了以下這些事（你看不到，但在內部發生）：

```
1. subprocess.Popen(["python", "mcp_server/server.py"])  ← 啟動子程序
2. 透過 stdin 送出 JSON-RPC initialize request
3. 透過 stdin 送出 JSON-RPC tools/list request
4. 從 stdout 讀取回應，解析出工具清單
5. 把每個 MCP tool 包裝成 LangChain BaseTool
6. 回傳 list[BaseTool]
```

這也是為什麼必須用 `await`：底層有 I/O 操作（等子程序回應）。

**Phase 2：工具已就緒，注入 Agent（`api.py` 第 131-140 行）**

```python
async def get_or_create_agent(llm_config):
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
    if cache_key not in _agent_cache:
        _agent_cache[cache_key] = KBAgent(llm_config, _mcp_tools).create_agent()
    return _agent_cache[cache_key]
```

`_mcp_tools` 是 lifespan 階段取得的 `list[BaseTool]`，直接傳入 `KBAgent`。這些 `BaseTool` 內部已經封裝了「透過 stdio 呼叫 server.py」的邏輯，`ToolNode` 不需要知道這件事。

**Phase 3：實際工具呼叫（LangGraph 內部，每次對話）**

```
LLM 回傳 tool_calls: [{"name": "search_articles", "args": {"query": "docker"}}]
    ↓
ToolNode 找到對應的 BaseTool（即 MCP 包裝的 search_articles）
    ↓
BaseTool._arun(query="docker")
    ↓
透過 stdin 送出 JSON-RPC:
{"method": "tools/call", "params": {"name": "search_articles", "arguments": {"query": "docker"}}}
    ↓
server.py 執行 search_articles("docker")，從 SQLite 查詢
    ↓
server.py 透過 stdout 回傳:
{"result": {"content": [{"type": "text", "text": "[{\"id\": 4, ...}]"}]}}
    ↓
BaseTool 把 TextContent.text 取出，包成 ToolMessage 加入 state
    ↓
LLM 收到 ToolMessage，根據查詢結果生成回答
```

### 工具的「透明性」

`ToolNode` 完全不知道工具是本地函數還是 MCP 工具，因為 `langchain-mcp-adapters` 把 MCP 工具包裝成標準的 `BaseTool`，對外介面完全一樣。這就是 MCP 協定的核心設計目標：**解耦工具的定義與使用**。

| 程式碼位置 | 看到的 | 實際發生的 |
|-----------|-------|-----------|
| `agent.py` 的 `bind_tools(tools)` | `list[BaseTool]` | MCP 工具包裝成 BaseTool |
| `agent.py` 的 `ToolNode(self.tools)` | 標準 ToolNode | 呼叫時透過 stdio 通訊 |
| `api.py` 的 `on_tool_start` event | 普通工具呼叫事件 | 底層是跨程序 JSON-RPC |

---

## Q7：工具一定要寫在 server.py 嗎？可以串接第三方 MCP Server 嗎？

### 工具不必全寫在 server.py

FastMCP 支援模組化拆分，你可以把工具定義在不同檔案，再 mount 到主 server：

```python
# mcp_server/tools/search.py
from fastmcp import FastMCP
search_mcp = FastMCP("Search Tools")

@search_mcp.tool()
def search_articles(query: str, limit: int = 5) -> str: ...
```

```python
# mcp_server/server.py
from fastmcp import FastMCP
from tools.search import search_mcp
from tools.write import write_mcp

mcp = FastMCP("Knowledge Base")
mcp.mount("search", search_mcp)   # 工具名稱會變成 search_search_articles
mcp.mount("write", write_mcp)

if __name__ == "__main__":
    mcp.run()
```

不過本 Case 工具數量少（4 個），直接寫在 server.py 最清楚。分檔的優點是：工具變多時維護更容易，也可以讓不同人各自負責不同模組。

---

### 可以串接第三方 MCP Server（stdio）

只要第三方 server 支援 stdio transport，`MultiServerMCPClient` 的設定 dict 加一個 key 就行，不需要改任何其他程式碼：

```python
# backend/api.py（lifespan）
client = MultiServerMCPClient({
    # 自己的知識庫 server
    "kb": {
        "command": "python",
        "args": [settings.mcp_server_path],
        "transport": "stdio",
    },
    # 第三方 server：Anthropic 官方的 filesystem server（npm 套件）
    "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "transport": "stdio",
    },
    # 第三方 server：Python 套件
    "brave": {
        "command": "python",
        "args": ["-m", "mcp_server_brave_search"],
        "env": {"BRAVE_API_KEY": "..."},
        "transport": "stdio",
    },
})
_mcp_tools = await client.get_tools()
# _mcp_tools 會包含所有 server 的工具，自動合併成一個 list
```

`MultiServerMCPClient` 同時 spawn 多個子程序，分別握手，再把所有工具合併回傳。`ToolNode` 收到的仍然是一個平坦的 `list[BaseTool]`，不需要知道工具來自哪個 server。

---

### 可以串接第三方 MCP Server（streamable-http）

streamable-http 是 MCP 協定 2025-03 版規範的標準 HTTP transport（取代舊的 SSE transport），server 以獨立網路服務形式運行，不需要在本機安裝或 spawn 子程序。

```python
client = MultiServerMCPClient({
    # 自己的 stdio server（本機）
    "kb": {
        "command": "python",
        "args": [settings.mcp_server_path],
        "transport": "stdio",
    },
    # 遠端 streamable-http server
    "remote_kb": {
        "url": "https://my-mcp-server.example.com/mcp",
        "transport": "streamable_http",
        "headers": {"Authorization": "Bearer sk-..."},   # 若需要認證
    },
})
```

| 比較 | stdio | streamable-http |
|------|-------|-----------------|
| server 位置 | 同一台機器（子程序） | 任意位置（網路） |
| 啟動方式 | `command` + `args`，由 Client spawn | server 獨立運行，Client 只需 URL |
| 適合場景 | 自己的工具、本機整合 | SaaS 工具服務、跨團隊共用 |
| 認證方式 | 環境變數（`env` 欄位） | HTTP Header（`headers` 欄位） |
| langchain-mcp-adapters 支援 | ✅ | ✅（`transport: "streamable_http"`） |

---

### 舊版 SSE transport 的說明

你可能在文件或範例中看到 `transport: "sse"` 的寫法，這是 MCP 協定 2024 版的 HTTP transport（用 Server-Sent Events 實作），在 2025-03 版已被 streamable-http 取代。兩者的 Client 設定差異：

```python
# 舊版 SSE（2024 版，langchain-mcp-adapters 仍支援）
"server": {
    "url": "http://localhost:8001/sse",
    "transport": "sse",
}

# 新版 streamable-http（2025-03 版）
"server": {
    "url": "http://localhost:8001/mcp",
    "transport": "streamable_http",
}
```

---

## Q4：Case 2 的工具 vs Case 8 的工具，有什麼不同？

### Case 2：本地 @tool 函數

```python
# tools.py
from langchain_core.tools import tool

@tool
def web_search(query: str) -> str:
    """搜尋網路"""
    ...

@tool
def calculator(expression: str) -> str:
    """數學計算"""
    ...

ALL_TOOLS = [web_search, calculator, get_current_time]

# agent.py
from tools import ALL_TOOLS

class ReActAgent:
    def __init__(self, llm_config):
        self.llm = ChatOpenAI(...).bind_tools(ALL_TOOLS)  # 直接使用本地工具

    def create_agent(self):
        tool_node = ToolNode(ALL_TOOLS)  # ToolNode 包裝本地工具
        ...
```

工具的生命週期：**在同一個 Python 行程中直接呼叫**

### Case 8：MCP @mcp.tool() 函數

```python
# mcp_server/server.py
from fastmcp import FastMCP
mcp = FastMCP("Knowledge Base")

@mcp.tool()
def search_articles(query: str, limit: int = 5) -> str:
    """搜尋知識庫文章"""
    # 存取 SQLite...
    return json.dumps(results)

# agent.py — 工具清單在建構時注入
class KBAgent:
    def __init__(self, llm_config, tools: list):  # 工具從外部傳入
        self.llm = ChatOpenAI(...).bind_tools(tools)

    def create_agent(self):
        tool_node = ToolNode(self.tools)  # ToolNode 包裝 MCP 工具（實為代理呼叫）
        ...

# api.py — 透過 MCP Client 取得工具
tools = _mcp_client.get_tools()  # langchain-mcp-adapters 將 MCP 工具轉換為 BaseTool
agent = KBAgent(llm_config, tools).create_agent()
```

工具的生命週期：**JSON-RPC over stdio → mcp_server 子行程執行 → 結果回傳**

### 關鍵差異一覽

| 面向 | Case 2（本地工具） | Case 8（MCP 工具） |
|------|-------------------|-------------------|
| 定義位置 | 同一 Python 行程內 | 獨立的 mcp_server 子行程 |
| 裝飾器 | `@tool`（LangChain） | `@mcp.tool()`（FastMCP） |
| 呼叫機制 | 直接函數呼叫 | JSON-RPC over stdio |
| 工具載入 | `import` 直接使用 | `_mcp_client.get_tools()` 動態取得 |
| LangGraph 圖結構 | **完全相同**（ToolNode 自動處理） | **完全相同** |
| 工具的可移植性 | 低（綁定在後端程式碼） | 高（可被任何 MCP 客戶端使用） |
| 適合新增工具時 | 修改 `tools.py` 並重啟後端 | 修改 `server.py` 即可（若協定不變則無需重啟後端） |

### 小結

**LangGraph 圖的結構在兩個 Case 中完全相同**，差異只在工具的定義方式與載入機制。
`langchain-mcp-adapters` 把 MCP 工具轉換成 LangChain `BaseTool`，讓 `ToolNode` 無感知地執行 MCP 工具——這正是 MCP 協定的設計目標：解耦工具的實作與使用方。
