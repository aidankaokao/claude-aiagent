# Case 1: Basic Chatbot — Q&A

---

## Q1. 後端每個 API 是怎麼設計的？

> 相關檔案：`backend/api.py`、`backend/models.py`、`backend/database.py`

後端共有 4 個端點，全部定義在 `backend/api.py`。

---

### POST `/api/chat`

**用途**：接收使用者訊息，回傳 SSE 串流的 AI 回覆。

**Request body**（定義於 `backend/models.py` → `class ChatRequest`、`class LlmConfig`）：
```json
{
  "message": "你好",
  "conversation_id": "550e8400-...",
  "llm_config": {
    "api_key": "sk-...",
    "model": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "temperature": 0.7
  }
}
```
> `conversation_id` 可為 `null`，表示新對話。

**Response**：`text/event-stream`（SSE），不是一次性 JSON。

**執行流程**（`api.py` → `async def chat(req: ChatRequest)`）：

```
1. conversation_id 為 null
   → 產生新 UUID
   → INSERT INTO conversations（title = 訊息前 50 字）
     （database.py → conversations 表）

2. INSERT INTO messages（role="user", content=req.message）
   （database.py → messages 表）

3. get_or_create_agent(req.llm_config)
   （agent.py → 以 (api_key, base_url, model) 為 key 查快取，
     沒有則建立新的 ChatAgent 實例並編譯）

4. agent.astream_events({"messages": [user_msg]}, config)
   config = {"configurable": {"thread_id": conversation_id}}
   （LangGraph 以 thread_id 區分不同對話的記憶體）

5. 過濾事件 event["event"] == "on_chat_model_stream"
   → 每個 chunk yield SSE event: token

6. 串流結束
   → INSERT INTO messages（role="assistant", content=完整回覆）
   → yield SSE event: done
```

**SSE 事件格式**：
```
event: token
data: {"content": "你"}

event: token
data: {"content": "好"}

event: done
data: {"conversation_id": "550e8400-..."}

event: error
data: {"message": "Invalid API key"}
```

---

### GET `/api/conversations`

**用途**：取得所有對話的摘要列表（給 Sidebar 顯示）。

**Response**（定義於 `models.py` → `class ConversationResponse`）：
```json
[
  {
    "id": "550e8400-...",
    "title": "你好，請問...",
    "created_at": "2025-01-01T00:00:00",
    "updated_at": "2025-01-01T00:05:00"
  }
]
```

**執行流程**（`api.py` → `async def list_conversations()`）：
```
SELECT * FROM conversations ORDER BY updated_at DESC
→ 回傳 list[ConversationResponse]
```

---

### GET `/api/conversations/{conversation_id}`

**用途**：取得單一對話的完整訊息，點擊歷史對話時載入用。

**Response**（定義於 `models.py` → `class ConversationDetailResponse`）：
```json
{
  "id": "550e8400-...",
  "title": "你好，請問...",
  "messages": [
    {"id": 1, "role": "user", "content": "你好", "created_at": "..."},
    {"id": 2, "role": "assistant", "content": "你好！...", "created_at": "..."}
  ]
}
```

**執行流程**（`api.py` → `async def get_conversation(conversation_id)`）：
```
SELECT * FROM conversations WHERE id = :id
→ 不存在 → raise HTTPException(404)

SELECT * FROM messages
  WHERE conversation_id = :id
  ORDER BY created_at ASC
→ 回傳 ConversationDetailResponse
```

---

### DELETE `/api/conversations/{conversation_id}`

**用途**：刪除對話及其所有訊息。

**Response**：`{"status": "ok"}`

**執行流程**（`api.py` → `async def delete_conversation(conversation_id)`）：
```
DELETE FROM messages WHERE conversation_id = :id
DELETE FROM conversations WHERE id = :id
→ 回傳 {"status": "ok"}
```

---

## Q2. 前端如何接後端的 API？

> 相關檔案：`frontend/src/Chat.tsx`、`frontend/vite.config.ts`

前端所有 API 呼叫都集中在 `frontend/src/Chat.tsx`，分為兩種方式：一般 `fetch`（JSON 回應）與 SSE 串流（`fetch` + `ReadableStream`）。

---

### 代理設定

開發時前端跑在 `localhost:5173`、後端跑在 `localhost:8000`，直接呼叫會有 CORS 問題。
`vite.config.ts` 設定代理，讓所有 `/api/*` 自動轉發：

```ts
// vite.config.ts
proxy: {
  '/api': {
    target: 'http://localhost:8000',
    changeOrigin: true,
  },
},
```

前端統一用 `API_BASE = '/api'`（`Chat.tsx` 頂部），不寫死完整 URL：

```ts
// Chat.tsx（頂部常數）
const API_BASE = '/api'
```

---

### 呼叫 POST `/api/chat`（SSE 串流）

> `Chat.tsx` → `handleSend()` 函數

SSE 串流不能用 `EventSource`（只支援 GET），改用 `fetch` + `res.body.getReader()` 手動讀取：

```ts
// Chat.tsx → handleSend()

const res = await fetch(`${API_BASE}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: text,
    conversation_id: conversationId,  // state，null = 新對話
    llm_config: llmConfig,            // state，從 Sidebar 設定取得
  }),
})

const reader = res.body?.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  // 解析 SSE...
}
```

**SSE 解析邏輯**（`handleSend()` 內的 `for` 迴圈）：

每個 SSE 事件由 `event:` 與 `data:` 兩行組成，需手動拆解：

```ts
const lines = buffer.split('\n')
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('event:')) {
    const eventType = lines[i].slice(6).trim()       // "token" / "done" / "error"
    const dataStr   = lines[i + 1].slice(5).trim()   // JSON 字串
    const data = JSON.parse(dataStr)

    if (eventType === 'token') {
      // 累加到畫面上最後一則 assistant 訊息（逐字顯示效果）
      setMessages(prev => {
        const updated = [...prev]
        updated[assistantIdx].content += data.content
        return updated
      })
    } else if (eventType === 'done') {
      setConversationId(data.conversation_id)
      loadConversations()   // 重整 Sidebar 對話列表
    } else if (eventType === 'error') {
      setError(data.message)
    }
  }
}
```

**`assistantIdx`** 是在 `handleSend()` 開頭預先插入一個空 assistant 訊息時記錄的 index，後續 token 事件才能定位到正確位置更新：

```ts
// Chat.tsx → handleSend() 開頭
const assistantIdx = messages.length + 1
setMessages(prev => [
  ...prev,
  { role: 'user', content: text },
  { role: 'assistant', content: '' },   // 空殼，等待 token 填入
])
```

---

### 呼叫 GET `/api/conversations`（載入對話列表）

> `Chat.tsx` → `loadConversations()` 函數

```ts
// Chat.tsx → loadConversations()
const res = await fetch(`${API_BASE}/conversations`)
if (res.ok) {
  setConversations(await res.json())   // 更新 Sidebar 的 conversations state
}
```

觸發時機（`Chat.tsx`）：
- `useEffect(() => { loadConversations() }, [loadConversations])` — 頁面載入時
- `handleSend()` 收到 `done` 事件後 — 每次新對話產生後

---

### 呼叫 GET `/api/conversations/{id}`（載入歷史對話）

> `Chat.tsx` → `loadConversation(convId)` 函數

```ts
// Chat.tsx → loadConversation(convId)
const res = await fetch(`${API_BASE}/conversations/${convId}`)
if (res.ok) {
  const data = await res.json()
  setConversationId(convId)
  setMessages(data.messages.map(m => ({ role: m.role, content: m.content })))
}
```

觸發時機：Sidebar 對話項目的 `onClick={() => loadConversation(conv.id)}`

---

### 呼叫 DELETE `/api/conversations/{id}`（刪除對話）

> `Chat.tsx` → `handleDeleteConversation(convId, e)` 函數

```ts
// Chat.tsx → handleDeleteConversation()
await fetch(`${API_BASE}/conversations/${convId}`, { method: 'DELETE' })
setConversations(prev => prev.filter(c => c.id !== convId))  // 樂觀更新 UI
if (conversationId === convId) handleNewChat()                // 若刪除當前對話則清空畫面
```

觸發時機：hover 對話項目後出現的刪除按鈕，`onClick={e => handleDeleteConversation(conv.id, e)}`
> `e.stopPropagation()` 防止觸發外層 `loadConversation`。

---

### 前端 API 呼叫總覽

| 函數 | 方法 + 路徑 | 觸發時機 |
|------|------------|---------|
| `handleSend()` | POST `/api/chat` | Enter 鍵或送出按鈕 |
| `loadConversations()` | GET `/api/conversations` | 頁面載入、每次對話結束後 |
| `loadConversation(id)` | GET `/api/conversations/{id}` | 點擊 Sidebar 對話項目 |
| `handleDeleteConversation()` | DELETE `/api/conversations/{id}` | 點擊刪除按鈕 |
