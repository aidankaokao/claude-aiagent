"""
種子資料腳本 — 為知識庫填入 15 篇範例技術文章

涵蓋主題：LangGraph、FastAPI、React Hooks、Docker、SQLite、
Python asyncio、TypeScript、LLM Prompt Engineering、MCP Protocol、
向量資料庫、RAG、LangChain Tools、GraphQL、Redis、WebSocket

使用方式：
  cd case8_mcp_server/mcp_server
  python seed_data.py

注意：若資料庫已有資料，則不重複新增（冪等操作）。
"""

import sys
from pathlib import Path

# 將 mcp_server 目錄加入 Python 路徑，以便 import server 模組
sys.path.insert(0, str(Path(__file__).parent))

from server import DB_PATH, get_conn  # noqa: E402

# ============================================================
# 種子文章資料
# ============================================================

SEED_ARTICLES = [
    {
        "title": "LangGraph 入門：用狀態機建構 AI Agent",
        "content": (
            "LangGraph 是 LangChain 生態系中專門用來建構有狀態 AI Agent 的框架，其核心概念是將 Agent 的執行流程建模為有向圖（Directed Graph）。"
            "每個節點（Node）是一個 Python 函數，負責處理狀態並回傳更新後的狀態；邊（Edge）決定執行流程的轉移方向，可以是固定邊或由函數決定的條件邊。"
            "相較於 LangChain 的 AgentExecutor，LangGraph 提供更細緻的流程控制，支援循環（Loop）、並行（Parallel）與中斷（Interrupt）等進階功能。"
            "使用 MemorySaver 可在記憶體中保存對話狀態，搭配 thread_id 實現多用戶的獨立對話記憶。"
        ),
        "tags": "langgraph,langchain,ai-agent",
    },
    {
        "title": "FastAPI 非同步端點設計最佳實踐",
        "content": (
            "FastAPI 是基於 Starlette 和 Pydantic 建構的高效能 Python Web 框架，原生支援非同步（async/await）程式設計。"
            "使用 async def 定義端點可以讓 FastAPI 在等待 I/O 操作時釋放 GIL，大幅提升並發效能。"
            "搭配 Pydantic BaseModel 定義請求與回應結構，FastAPI 會自動進行資料驗證、序列化並生成 OpenAPI 文件。"
            "SSE（Server-Sent Events）可透過 sse-starlette 套件實作，適合用於 LLM 串流輸出的即時推送場景。"
        ),
        "tags": "fastapi,python,api",
    },
    {
        "title": "React Hooks 完整指南：useState 到 useCallback",
        "content": (
            "React Hooks 在 React 16.8 引入，讓函數元件（Function Component）能夠使用狀態與生命週期功能，取代了傳統的類別元件。"
            "useState 用於管理元件本地狀態，useEffect 處理副作用（如 API 呼叫、訂閱事件），useCallback 用來記憶函數參考以避免不必要的子元件重渲染。"
            "useRef 可儲存不觸發重渲染的可變數值，常用於 DOM 操作（如自動捲動、聚焦輸入框）或儲存計時器 ID。"
            "自訂 Hook（Custom Hook）以 use 開頭命名，可將複雜的狀態邏輯封裝成可重用的函數，提升程式碼的可維護性。"
        ),
        "tags": "react,hooks,frontend",
    },
    {
        "title": "Docker 容器化部署：從開發到生產",
        "content": (
            "Docker 透過容器（Container）技術將應用程式與其依賴環境打包成可攜式映像（Image），解決了「在我的機器上能跑」的經典問題。"
            "Dockerfile 定義映像的建置步驟，多階段建置（Multi-stage Build）可大幅縮小最終映像大小，例如先用 Node.js 映像編譯前端，再複製產物到 nginx 映像。"
            "docker-compose.yaml 用於定義多容器應用的服務、網路與磁碟區，適合本地開發與 CI/CD 環境。"
            "生產環境中建議使用具名磁碟區（Named Volume）持久化資料，並設定健康檢查（healthcheck）確保服務可靠性。"
        ),
        "tags": "docker,devops,deployment",
    },
    {
        "title": "SQLite 與 SQLAlchemy Core：輕量級資料庫方案",
        "content": (
            "SQLite 是嵌入式關聯式資料庫，無需獨立伺服器行程，適合單機應用與開發測試環境，其資料庫為單一 .db 檔案，易於備份與遷移。"
            "SQLAlchemy Core 提供 Python 原生的 SQL 表達式語言，相較於全功能 ORM，它更貼近原生 SQL，效能更佳且更容易遷移至 PostgreSQL 等其他資料庫。"
            "使用 Table + MetaData 定義資料表結構，透過 metadata.create_all(engine) 自動建表，避免手動執行 DDL 語句。"
            "SQLite 的 check_same_thread=False 選項允許多執行緒共用連線，在 FastAPI 非同步環境中使用時需特別注意連線安全。"
        ),
        "tags": "sqlite,sqlalchemy,database",
    },
    {
        "title": "Python asyncio 並發程式設計實戰",
        "content": (
            "Python asyncio 是標準函式庫中的非同步 I/O 框架，透過事件迴圈（Event Loop）實現單執行緒並發，適合處理大量 I/O 密集型任務。"
            "async def 定義協程（Coroutine），await 關鍵字暫停目前協程並等待另一個非同步操作完成，期間事件迴圈可以執行其他任務。"
            "asyncio.gather() 可並行執行多個協程，asyncio.create_task() 建立背景任務，兩者皆是實現並發的常用模式。"
            "注意：asyncio 並非多執行緒，CPU 密集型任務仍會阻塞事件迴圈，此時應使用 run_in_executor() 或 ProcessPoolExecutor。"
        ),
        "tags": "python,asyncio,concurrency",
    },
    {
        "title": "TypeScript 型別系統：從基礎到進階",
        "content": (
            "TypeScript 是 JavaScript 的超集，透過靜態型別系統在編譯階段捕捉錯誤，大幅提升大型專案的可維護性。"
            "介面（Interface）與型別別名（Type Alias）是定義物件形狀的兩種方式，Interface 支援宣告合併（Declaration Merging），Type 支援聯合與交叉型別。"
            "泛型（Generic）讓函數、類別與介面能夠在保持型別安全的前提下處理多種型別，是建構可重用程式庫的核心工具。"
            "React 與 TypeScript 搭配使用時，透過 interface Props 定義元件 props 型別，結合 useState<T> 標注狀態型別，可大幅減少執行時期錯誤。"
        ),
        "tags": "typescript,javascript,frontend",
    },
    {
        "title": "LLM Prompt Engineering：設計高效提示詞的技巧",
        "content": (
            "Prompt Engineering 是優化大型語言模型（LLM）輸出品質的技術，核心在於清晰表達任務目標、提供足夠的上下文並控制輸出格式。"
            "Few-shot Prompting 透過在提示中提供範例（Example），引導模型學習期望的輸入輸出模式，對結構化輸出尤為有效。"
            "Chain-of-Thought（CoT）提示要求模型逐步推理，顯著提升複雜數學與邏輯問題的準確率；結合 Self-consistency 技術可進一步提升穩定性。"
            "System Prompt 用於設定模型的角色與行為約束，應包含：角色定義、能力範圍、輸出格式要求，以及必要的安全限制。"
        ),
        "tags": "llm,prompt-engineering,ai",
    },
    {
        "title": "MCP（Model Context Protocol）協定介紹",
        "content": (
            "MCP（Model Context Protocol）是 Anthropic 發起的開放標準，旨在標準化 AI 模型與外部工具、資料來源之間的溝通介面。"
            "MCP 定義了 Tool（工具）、Resource（資源）和 Prompt（提示模板）三種基本原語，讓 AI 應用能以統一方式存取各種外部能力。"
            "Transport 層支援 stdio（子程序）和 HTTP/SSE（網路服務）兩種模式：stdio 適合本機整合，HTTP 適合跨網路部署。"
            "FastMCP 是 Python 的高階 MCP 實作，透過裝飾器（@mcp.tool()）語法大幅簡化工具的定義，相較於原生 SDK 減少約 80% 的樣板程式碼。"
        ),
        "tags": "mcp,protocol,ai-tools",
    },
    {
        "title": "向量資料庫：語意搜尋的基礎設施",
        "content": (
            "向量資料庫（Vector Database）專為儲存和查詢高維度向量（Embedding）而設計，是實現語意搜尋（Semantic Search）的核心基礎設施。"
            "相較於傳統的關鍵字搜尋（BM25/TF-IDF），向量搜尋透過計算語意相似度（如餘弦相似度）找到概念相近但措辭不同的結果。"
            "常見開源方案包括：Chroma（Python 原生，適合快速原型）、Qdrant（Rust 實作，高效能）、Weaviate（支援混合搜尋）。"
            "選擇向量資料庫時需考量：嵌入維度、資料量規模、是否需要混合搜尋（向量 + 關鍵字），以及部署環境的資源限制。"
        ),
        "tags": "vector-database,embedding,search",
    },
    {
        "title": "RAG（檢索增強生成）系統架構設計",
        "content": (
            "RAG（Retrieval-Augmented Generation）是一種結合資訊檢索與生成式 AI 的架構，解決 LLM 知識截止日期與幻覺（Hallucination）問題。"
            "RAG 流程分為兩階段：離線索引（Indexing）將文件分塊、生成嵌入並存入向量資料庫；線上查詢（Retrieval）根據使用者問題找到相關文件，注入至 LLM 提示。"
            "文件分塊策略（Chunking Strategy）對 RAG 品質影響重大：固定大小分塊簡單但可能切斷語意，語意分塊或遞迴分塊效果更佳。"
            "進階技術包括 HyDE（假設文件嵌入）、重排序（Re-ranking）與多查詢擴展，可進一步提升檢索準確率。"
        ),
        "tags": "rag,llm,vector-database",
    },
    {
        "title": "LangChain Tools：建構自訂工具的完整指南",
        "content": (
            "LangChain Tools 讓 Agent 能夠呼叫外部函數或 API，是 ReAct Agent 的核心組成部分，每個工具包含名稱、描述（供 LLM 判斷何時使用）和執行函數。"
            "使用 @tool 裝飾器是定義工具最簡便的方式，函數的文件字串（docstring）會自動成為工具描述；對於複雜參數，可繼承 BaseTool 並定義 args_schema（Pydantic 模型）。"
            "工具的錯誤處理很重要：設定 handle_tool_error=True 或提供 handle_tool_error 函數，可在工具失敗時給予 Agent 有用的錯誤訊息而非直接拋出異常。"
            "非同步工具需實作 _arun() 方法，在 async Agent 環境中確保工具不阻塞事件迴圈，提升整體系統效能。"
        ),
        "tags": "langchain,tools,ai-agent",
    },
    {
        "title": "GraphQL API 設計：靈活的資料查詢語言",
        "content": (
            "GraphQL 是 Facebook 開發的 API 查詢語言，相較於 REST API，客戶端可以精確指定所需欄位，避免過度取得（Over-fetching）或不足取得（Under-fetching）資料。"
            "Schema 定義是 GraphQL 的核心，透過 SDL（Schema Definition Language）描述資料型別與查詢/變更操作，提供強型別的 API 合約。"
            "Python 中 Strawberry 和 Ariadne 是兩個主流的 GraphQL 框架：Strawberry 使用 Python 型別標注（type hints）定義 Schema，更符合現代 Python 開發習慣。"
            "N+1 問題是 GraphQL 的常見效能陷阱，可透過 DataLoader 批次化資料庫查詢，將多次單筆查詢合併為一次批次查詢來解決。"
        ),
        "tags": "graphql,api,backend",
    },
    {
        "title": "Redis 快取與資料結構應用",
        "content": (
            "Redis 是高效能的記憶體資料儲存系統，支援豐富的資料結構（字串、雜湊、列表、集合、有序集合），廣泛應用於快取、會話管理與訊息佇列場景。"
            "快取策略設計需考量：Cache-Aside（應用層控制）vs. Write-Through（寫入時同步快取），以及適當的 TTL（存活時間）設定避免快取污染。"
            "Redis Pub/Sub 與 Streams 提供輕量級的訊息傳遞功能，適合即時通知場景；相較於 Kafka，Redis Streams 配置更簡單，適合中小規模應用。"
            "在 Python 中使用 redis-py 或 aioredis（非同步）客戶端，搭配連線池（Connection Pool）可有效管理連線資源，避免頻繁建立連線的開銷。"
        ),
        "tags": "redis,cache,backend",
    },
    {
        "title": "WebSocket 即時通訊：雙向串流實作",
        "content": (
            "WebSocket 是基於 TCP 的全雙工通訊協定，相較於 HTTP 輪詢（Polling）和 SSE（單向推送），WebSocket 支援伺服器與客戶端的雙向即時通訊。"
            "FastAPI 內建 WebSocket 支援，使用 @app.websocket() 裝飾器定義端點，透過 websocket.accept()、send_text() 和 receive_text() 進行連線管理。"
            "多用戶廣播需實作連線管理器（Connection Manager），維護活躍連線清單並在廣播時過濾斷線的連線，避免發送至已關閉的 WebSocket 導致異常。"
            "在 React 前端，可使用原生 WebSocket API 或 socket.io-client 函式庫，搭配 useEffect 管理連線生命週期，useRef 儲存 WebSocket 實例避免重複建立。"
        ),
        "tags": "websocket,realtime,frontend",
    },
]


def main() -> None:
    """執行種子資料填入，若已有資料則跳過"""
    with get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]

    if count > 0:
        print(f"[Seed] 資料庫已有 {count} 篇文章，跳過種子資料填入。")
        return

    with get_conn() as conn:
        for article in SEED_ARTICLES:
            conn.execute(
                "INSERT INTO articles (title, content, tags) VALUES (?, ?, ?)",
                (article["title"], article["content"], article["tags"]),
            )
        conn.commit()

    print(f"[Seed] 成功填入 {len(SEED_ARTICLES)} 篇種子文章至 {DB_PATH}")


if __name__ == "__main__":
    main()
