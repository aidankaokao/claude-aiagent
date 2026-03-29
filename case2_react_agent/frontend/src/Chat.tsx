/**
 * Chat.tsx — ReAct Agent 聊天介面
 *
 * 與 Case 1 的差異：
 * - Message 型別新增 toolCalls 欄位，儲存工具呼叫記錄
 * - handleSend() 新增處理 tool_start / tool_end SSE 事件
 * - 每則 assistant 訊息前方顯示工具呼叫面板（ToolCallPanel）
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Chat.css'

// === 型別定義 ===

interface ToolCall {
  run_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_output?: string
  status: 'running' | 'done'
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]   // assistant 訊息可能包含工具呼叫記錄
}

interface Conversation {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

interface LlmConfig {
  api_key: string
  model: string
  base_url: string
  temperature: number
}

// LLM 設定預設值（使用者未填入前的佔位值）
const DEFAULT_CONFIG: LlmConfig = {
  api_key: '',
  model: 'gpt-4o-mini',
  base_url: 'https://api.openai.com/v1',
  temperature: 0.7,
}

// Vite dev proxy 會將 /api/* 轉發到 localhost:8000，避免 CORS 問題
const API_BASE = '/api'

// 工具名稱對應中文顯示（用於 ToolCallPanel 的標題列）
const TOOL_LABELS: Record<string, string> = {
  web_search:       '網路搜尋',
  calculator:       '計算機',
  get_current_time: '取得時間',
}

// ============================================================
// ToolCallPanel — 工具呼叫視覺化元件
// ============================================================
function ToolCallPanel({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggleExpand = (run_id: string) =>
    setExpanded(prev => ({ ...prev, [run_id]: !prev[run_id] }))

  if (toolCalls.length === 0) return null

  return (
    <div className="cb-tool-panel">
      {toolCalls.map(tc => (
        <div key={tc.run_id} className={`cb-tool-item cb-tool-item--${tc.status}`}>
          {/* 工具標題列 */}
          <button className="cb-tool-header" onClick={() => toggleExpand(tc.run_id)}>
            <div className="cb-tool-header-left">
              {tc.status === 'running' ? (
                <span className="cb-tool-spinner" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              <span className="cb-tool-name">
                {TOOL_LABELS[tc.tool_name] ?? tc.tool_name}
              </span>
              {/* 顯示主要輸入參數（預覽） */}
              <span className="cb-tool-preview">
                {Object.values(tc.tool_input)[0] != null
                  ? String(Object.values(tc.tool_input)[0]).slice(0, 40)
                  : ''}
              </span>
            </div>
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="13" height="13"
              style={{ transform: expanded[tc.run_id] ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}
            >
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {/* 展開區：輸入 + 輸出 */}
          {expanded[tc.run_id] && (
            <div className="cb-tool-detail">
              <div className="cb-tool-section-label">輸入</div>
              <pre className="cb-tool-code">{JSON.stringify(tc.tool_input, null, 2)}</pre>
              {tc.tool_output !== undefined && (
                <>
                  <div className="cb-tool-section-label">輸出</div>
                  <pre className="cb-tool-code">{tc.tool_output}</pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================================
// Chat — 主元件
// ============================================================
export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])

  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [configSaved, setConfigSaved] = useState(false)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [isDark, setIsDark] = useState(true)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  // 訊息列表底部的錨點，用來自動捲動到最新訊息
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // 輸入框 ref，用來動態調整高度
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 取得所有對話列表，顯示在側邊欄
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  // 初始掛載時載入對話列表
  useEffect(() => { loadConversations() }, [loadConversations])
  // 每當訊息更新時，自動捲動到底部
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  // 根據輸入內容自動調整 textarea 高度，最高 160px
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) { ta.style.height = '24px'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px' }
  }, [input])

  // 將暫存設定（llmDraft）套用為正式設定（llmConfig），並顯示 2 秒的儲存成功提示
  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  // 從後端載入指定對話的歷史訊息，切換到該對話
  const loadConversation = async (convId: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${convId}`)
      if (res.ok) {
        const data = await res.json()
        setConversationId(convId)
        setMessages(data.messages.map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })))
        setError(null)
      }
    } catch { setError('載入對話失敗') }
  }

  // 重置畫面至空白對話狀態（不刪除後端資料）
  const handleNewChat = () => {
    setMessages([])
    setConversationId(null)
    setError(null)
    setInput('')
  }

  // 刪除對話（同時刪除後端的 tool_calls → messages → conversations）
  // e.stopPropagation() 防止點擊刪除按鈕時觸發外層的 loadConversation
  const handleDeleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`${API_BASE}/conversations/${convId}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== convId))
    if (conversationId === convId) handleNewChat()
  }

  // --- 發送訊息 ---
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!llmConfig.api_key) { setError('請先在左側設定填入 API Key'); return }

    setInput('')
    setError(null)
    setLoading(true)

    // assistantIdx：當前 assistant 訊息在 messages 陣列中的索引
    // 用於後續 token / tool_start / tool_end 事件定位到正確的訊息
    const assistantIdx = messages.length + 1
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', toolCalls: [] },
    ])

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: conversationId, llm_config: llmConfig }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('無法讀取串流')

      // buffer 用來處理跨 chunk 的不完整 SSE 行
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // 將 buffer 切成行，逐行解析 SSE 格式（event: xxx\ndata: {...}）
        const lines = buffer.split('\n')
        buffer = ''

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line.startsWith('event:')) {
            const eventType = line.slice(6).trim()
            if (i + 1 < lines.length && lines[i + 1].startsWith('data:')) {
              const dataStr = lines[i + 1].slice(5).trim()
              i++
              try {
                const data = JSON.parse(dataStr)

                if (eventType === 'token') {
                  // LLM 逐字輸出 → 累加到 content
                  setMessages(prev => {
                    const updated = [...prev]
                    updated[assistantIdx] = {
                      ...updated[assistantIdx],
                      content: updated[assistantIdx].content + data.content,
                    }
                    return updated
                  })

                } else if (eventType === 'tool_start') {
                  // 工具開始執行 → 在 toolCalls 陣列新增一筆 running 狀態
                  setMessages(prev => {
                    const updated = [...prev]
                    const msg = updated[assistantIdx]
                    updated[assistantIdx] = {
                      ...msg,
                      toolCalls: [
                        ...(msg.toolCalls ?? []),
                        {
                          run_id: data.run_id,
                          tool_name: data.tool_name,
                          tool_input: data.tool_input,
                          status: 'running',
                        },
                      ],
                    }
                    return updated
                  })

                } else if (eventType === 'tool_end') {
                  // 工具執行完成 → 依 run_id 找到對應工具，更新 output 與 status
                  setMessages(prev => {
                    const updated = [...prev]
                    const msg = updated[assistantIdx]
                    updated[assistantIdx] = {
                      ...msg,
                      toolCalls: (msg.toolCalls ?? []).map(tc =>
                        tc.run_id === data.run_id
                          ? { ...tc, tool_output: data.tool_output, status: 'done' }
                          : tc
                      ),
                    }
                    return updated
                  })

                } else if (eventType === 'done') {
                  if (data.conversation_id) setConversationId(data.conversation_id)
                  loadConversations()

                } else if (eventType === 'error') {
                  setError(data.message || '發生錯誤')
                }
              } catch { /* 忽略 JSON 解析失敗 */ }
            }
          } else if (!line.startsWith('data:') && line.trim() !== '') {
            buffer = lines.slice(i).join('\n')
            break
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '連線失敗')
      setMessages(prev => prev.filter((_, idx) => idx !== assistantIdx))
    } finally {
      setLoading(false)
    }
  }

  // Enter 送出（Shift+Enter 換行），isComposing 防止中文輸入法確認時誤送
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  // 複製訊息內容到剪貼簿，並短暫顯示「已複製」圖示
  const handleCopy = (content: string, idx: number) => {
    navigator.clipboard.writeText(content)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  // === 渲染 ===
  return (
    <div className={`cb-root${isDark ? '' : ' light'}`}>
      {/* ===== Sidebar ===== */}
      <aside className={`cb-sidebar${sidebarOpen ? '' : ' cb-sidebar--collapsed'}`}>
        <div className="cb-sidebar-top">
          {sidebarOpen && <span className="cb-sidebar-brand">ReAct Agent</span>}
          <button className="cb-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>

        {sidebarOpen && (
          <div className="cb-sidebar-body">
            {/* LLM 設定 */}
            <div className="cb-settings-section">
              <button className="cb-settings-header" onClick={() => setSettingsOpen(!settingsOpen)}>
                <span className="cb-section-label">LLM 設定</span>
                <div className="cb-settings-header-right">
                  {llmConfig.api_key && <span className="cb-status-dot cb-status-dot--ok" />}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    style={{ transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </button>
              {settingsOpen && (
                <div className="cb-settings-body">
                  <div className="cb-form-row">
                    <label className="cb-form-label">API Key</label>
                    <div className="cb-input-with-toggle">
                      <input type={showApiKey ? 'text' : 'password'} className="cb-form-input" placeholder="sk-..."
                        value={llmDraft.api_key} onChange={e => setLlmDraft(p => ({ ...p, api_key: e.target.value }))} />
                      <button className="cb-input-toggle-btn" onClick={() => setShowApiKey(!showApiKey)} type="button">
                        {showApiKey
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        }
                      </button>
                    </div>
                  </div>
                  <div className="cb-form-row">
                    <label className="cb-form-label">Model</label>
                    <input type="text" className="cb-form-input" placeholder="gpt-4o-mini"
                      value={llmDraft.model} onChange={e => setLlmDraft(p => ({ ...p, model: e.target.value }))} />
                  </div>
                  <div className="cb-form-row">
                    <label className="cb-form-label">Base URL</label>
                    <input type="text" className="cb-form-input cb-form-input--small" placeholder="https://api.openai.com/v1"
                      value={llmDraft.base_url} onChange={e => setLlmDraft(p => ({ ...p, base_url: e.target.value }))} />
                  </div>
                  <div className="cb-form-row">
                    <label className="cb-form-label">Temperature <span className="cb-form-value">{llmDraft.temperature.toFixed(1)}</span></label>
                    <input type="range" className="cb-form-range" min="0" max="2" step="0.1"
                      value={llmDraft.temperature} onChange={e => setLlmDraft(p => ({ ...p, temperature: parseFloat(e.target.value) }))} />
                  </div>
                  <button className="cb-save-btn" onClick={handleSaveConfig}>
                    {configSaved
                      ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>已儲存</>
                      : '儲存設定'}
                  </button>
                </div>
              )}
            </div>

            {/* 工具說明 */}
            <div className="cb-settings-section">
              <div className="cb-section-label" style={{ padding: '8px 4px 6px' }}>可用工具</div>
              <div className="cb-tool-list-info">
                {[
                  { icon: '🔍', name: '網路搜尋', desc: 'web_search' },
                  { icon: '🧮', name: '計算機', desc: 'calculator' },
                  { icon: '🕐', name: '取得時間', desc: 'get_current_time' },
                ].map(t => (
                  <div key={t.desc} className="cb-tool-info-item">
                    <span>{t.icon}</span>
                    <div>
                      <div className="cb-tool-info-name">{t.name}</div>
                      <div className="cb-tool-info-fn">{t.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="cb-divider" />

            <button className="cb-new-chat-btn" onClick={handleNewChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              新對話
            </button>

            <div className="cb-conv-list">
              {conversations.map(conv => (
                <div key={conv.id}
                  className={`cb-conv-item${conversationId === conv.id ? ' cb-conv-item--active' : ''}`}
                  onClick={() => loadConversation(conv.id)}>
                  <span className="cb-conv-title">{conv.title || '未命名對話'}</span>
                  <button className="cb-conv-delete" onClick={e => handleDeleteConversation(conv.id, e)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ===== Main ===== */}
      <div className="cb-main">
        <header className="cb-topbar">
          <div className="cb-topbar-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <span className="cb-topbar-title">ReAct Agent</span>
            <span className="cb-topbar-badge">Case 2</span>
          </div>
          <div className="cb-topbar-right">
            {llmConfig.api_key && <span className="cb-model-badge">{llmConfig.model}</span>}
            <button className="cb-ctrl-btn" onClick={() => setIsDark(!isDark)}>
              {isDark
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
              }
            </button>
          </div>
        </header>

        <div className="cb-messages">
          {messages.length === 0 && (
            <div className="cb-empty">
              <div className="cb-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" width="48" height="48">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">ReAct Agent</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? '可使用搜尋、計算機、時間查詢工具'
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && (
                <div className="cb-empty-examples">
                  <p className="cb-empty-examples-label">試試看：</p>
                  {[
                    '現在台北時間幾點？',
                    '計算 (1234 + 5678) * 2 / 3',
                    '幫我搜尋 LangGraph 的介紹',
                    '本金 50000，年利率 3.5%，存 5 年的複利是多少？',
                  ].map(ex => (
                    <button key={ex} className="cb-example-btn" onClick={() => setInput(ex)}>{ex}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`cb-msg cb-msg--${msg.role}`}>
              <div className="cb-msg-avatar">
                {msg.role === 'user'
                  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
                }
              </div>
              <div className="cb-msg-content-wrap">
                {/* 工具呼叫面板（assistant 訊息才顯示） */}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ToolCallPanel toolCalls={msg.toolCalls} />
                )}
                <div className="cb-msg-bubble">
                  {msg.role === 'assistant'
                    ? msg.content
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : (msg.toolCalls?.some(tc => tc.status === 'running')
                          ? null  // 工具執行中時不顯示 typing（已有 spinner）
                          : <div className="cb-typing"><span/><span/><span/></div>)
                    : <p>{msg.content}</p>
                  }
                </div>
              </div>
              {msg.role === 'assistant' && msg.content && (
                <div className="cb-msg-actions">
                  <button className="cb-action-btn" onClick={() => handleCopy(msg.content, idx)}>
                    {copiedIdx === idx
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                    }
                  </button>
                </div>
              )}
            </div>
          ))}

          {error && (
            <div className="cb-error">
              <span>{error}</span>
              <button onClick={() => setError(null)}>✕</button>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="cb-input-area">
          <div className="cb-input-box">
            <textarea ref={textareaRef} className="cb-input" value={input}
              onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder={llmConfig.api_key ? '輸入問題... (Shift+Enter 換行)' : '請先填入 API Key'}
              disabled={loading} rows={1} />
            <button className={`cb-send-btn${loading ? ' cb-send-btn--loading' : ''}`}
              onClick={handleSend} disabled={!input.trim() || loading}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
          <p className="cb-input-hint">Enter 送出 · Shift+Enter 換行</p>
        </div>
      </div>
    </div>
  )
}
