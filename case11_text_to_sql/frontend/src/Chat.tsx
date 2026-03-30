/**
 * Chat.tsx — Text-to-SQL 聊天介面（Case 11）
 *
 * SSE 事件：
 * - sql_query  → 設定 msg.sqlInfo（SqlViewer 顯示）
 * - token      → 累積 content
 * - done       → finalize，content fallback
 * - error      → 顯示錯誤
 *
 * SSE 解析：line.trim() === '' 識別空白分隔行（\r\n 相容）
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import SqlViewer, { type SqlInfo } from './SqlViewer'
import './Chat.css'

// ── 型別 ──────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
  sqlInfo?: SqlInfo
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

const DEFAULT_CONFIG: LlmConfig = {
  api_key: '',
  model: 'gpt-4o-mini',
  base_url: 'https://api.openai.com/v1',
  temperature: 0.1,
}

const API_BASE = '/api'

// ── 範例問題 ──────────────────────────────────────────────────

const EXAMPLES = [
  { icon: '📊', q: '目前有哪些產品庫存不足？',                     type: 'realtime' },
  { icon: '📊', q: '電子產品中庫存最少的 3 個產品是什麼？',         type: 'realtime' },
  { icon: '📈', q: '過去 30 天哪些產品庫存不足天數超過 10 天？',    type: 'historical' },
  { icon: '📈', q: '過去 30 天各產品庫存不足的比例分別是多少？',    type: 'historical' },
  { icon: '📈', q: '本月庫存異動最頻繁的前 5 個產品',              type: 'historical' },
  { icon: '📈', q: '過去 7 天的入庫記錄有哪些？',                  type: 'historical' },
]

// ── Chat ──────────────────────────────────────────────────────

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

  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  const debugEndRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默 */ }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) { ta.style.height = '24px'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px' }
  }, [input])
  useEffect(() => {
    if (debugOpen) debugEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [debugLog, debugOpen])

  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

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

  const handleNewChat = () => {
    setMessages([])
    setConversationId(null)
    setError(null)
    setInput('')
  }

  const handleDeleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`${API_BASE}/conversations/${convId}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== convId))
    if (conversationId === convId) handleNewChat()
  }

  // ── 發送訊息（SSE）────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!llmConfig.api_key) { setError('請先填入 API Key'); return }

    setInput('')
    setError(null)
    setLoading(true)

    const assistantIdx = messages.length + 1
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ])

    const ts = () => new Date().toISOString().slice(11, 23)
    const dbg = (msg: string) => setDebugLog(prev => [...prev.slice(-199), `${ts()} ${msg}`])
    dbg(`─── 串流開始 ───`)

    let streamDone = false
    let finalized = false

    const finalize = (reason: string) => {
      if (finalized) return
      finalized = true
      dbg(`─── 串流結束（${reason}）───`)
      setLoading(false)
    }

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, thread_id: conversationId, llm_config: llmConfig }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('無法讀取串流')

      let buffer = ''
      let sseEvent = ''
      let sseDataLines: string[] = []

      const dispatch = (eventType: string, dataStr: string) => {
        const preview = eventType === 'token' ? `len=${dataStr.length}` : dataStr.slice(0, 120)
        dbg(`  [${eventType}] ${preview}`)
        try {
          const data = JSON.parse(dataStr)

          if (eventType === 'sql_query') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = {
                ...msg,
                sqlInfo: {
                  sql:       data.sql ?? '',
                  queryType: data.query_type ?? '',
                  attempt:   data.attempt ?? 1,
                },
              }
              return updated
            })

          } else if (eventType === 'token') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = { ...msg, content: msg.content + data.content }
              return updated
            })

          } else if (eventType === 'done') {
            if (data.conversation_id) setConversationId(data.conversation_id)
            if (data.content) {
              setMessages(prev => {
                const updated = [...prev]
                const msg = updated[assistantIdx]
                if (!msg || msg.content) return prev
                updated[assistantIdx] = { ...msg, content: data.content }
                return updated
              })
            }
            loadConversations()
            streamDone = true
            finalize('done event')

          } else if (eventType === 'error') {
            setError(data.message || '發生錯誤')
            streamDone = true
            finalize('error event')
          }
        } catch { /* 忽略解析失敗 */ }
      }

      while (true) {
        if (streamDone) { reader.cancel(); break }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            sseEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            sseDataLines.push(line.slice(5).trim())
          } else if (line.trim() === '') {
            if (sseEvent && sseDataLines.length > 0) {
              dispatch(sseEvent, sseDataLines.join('\n'))
            }
            sseEvent = ''
            sseDataLines = []
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '連線失敗')
      setMessages(prev => prev.filter((_, idx) => idx !== assistantIdx))
    } finally {
      finalize('stream closed')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopy = (content: string, idx: number) => {
    navigator.clipboard.writeText(content)
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 2000)
  }

  // ── 渲染 ──────────────────────────────────────────────────

  return (
    <div className={`cb-root${isDark ? '' : ' light'}`}>
      {/* ===== Sidebar ===== */}
      <aside className={`cb-sidebar${sidebarOpen ? '' : ' cb-sidebar--collapsed'}`}>
        <div className="cb-sidebar-top">
          {sidebarOpen && <span className="cb-sidebar-brand">SQL Agent</span>}
          <button className="cb-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
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
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
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
                      <input type={showApiKey ? 'text' : 'password'} className="cb-form-input"
                        placeholder="sk-..." value={llmDraft.api_key}
                        onChange={e => setLlmDraft(p => ({ ...p, api_key: e.target.value }))} />
                      <button className="cb-input-toggle-btn" type="button" onClick={() => setShowApiKey(!showApiKey)}>
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
                    <input type="text" className="cb-form-input cb-form-input--small"
                      placeholder="https://api.openai.com/v1"
                      value={llmDraft.base_url} onChange={e => setLlmDraft(p => ({ ...p, base_url: e.target.value }))} />
                  </div>
                  <div className="cb-form-row">
                    <label className="cb-form-label">
                      Temperature
                      <span className="cb-form-value">{llmDraft.temperature.toFixed(1)}</span>
                    </label>
                    <input type="range" className="cb-form-range" min="0" max="1" step="0.05"
                      value={llmDraft.temperature}
                      onChange={e => setLlmDraft(p => ({ ...p, temperature: parseFloat(e.target.value) }))} />
                  </div>
                  <button className="cb-save-btn" onClick={handleSaveConfig}>
                    {configSaved
                      ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>已儲存</>
                      : '儲存設定'}
                  </button>
                </div>
              )}
            </div>

            {/* Schema 說明 */}
            <div className="cb-settings-section">
              <div className="cb-settings-header" style={{ cursor: 'default' }}>
                <span className="cb-section-label">資料庫 Schema</span>
              </div>
              <div className="cb-schema-info">
                <div className="cb-schema-item cb-schema-products">
                  <span className="cb-schema-name">products</span>
                  <span className="cb-schema-desc">產品主檔（即時庫存）</span>
                </div>
                <div className="cb-schema-item cb-schema-snapshots">
                  <span className="cb-schema-name">daily_snapshots</span>
                  <span className="cb-schema-desc">每日快照（歷史趨勢）</span>
                </div>
                <div className="cb-schema-item cb-schema-changes">
                  <span className="cb-schema-name">stock_changes</span>
                  <span className="cb-schema-desc">異動記錄（補貨/出庫）</span>
                </div>
              </div>
            </div>

            {/* SSE Debug */}
            <div className="cb-settings-section">
              <button className="cb-settings-header" onClick={() => setDebugOpen(!debugOpen)}>
                <span className="cb-section-label">SSE Debug</span>
                <div className="cb-settings-header-right">
                  {debugLog.length > 0 && <span className="cb-debug-count">{debugLog.length}</span>}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    style={{ transform: debugOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </button>
              {debugOpen && (
                <div className="cb-debug-panel">
                  <div className="cb-debug-toolbar">
                    <span className="cb-debug-hint">後端 log 請看 docker logs</span>
                    <button className="cb-debug-clear" onClick={() => setDebugLog([])}>清除</button>
                  </div>
                  <div className="cb-debug-log">
                    {debugLog.length === 0
                      ? <span className="cb-debug-empty">等待 SSE 事件...</span>
                      : debugLog.map((line, i) => (
                          <div key={i} className={`cb-debug-line${
                            line.includes('[sql_query]') ? ' cb-debug-sql' :
                            line.includes('[done]')     ? ' cb-debug-done' :
                            line.includes('[error]')    ? ' cb-debug-error' :
                            line.includes('[token]')    ? ' cb-debug-token' : ''
                          }`}>{line}</div>
                        ))
                    }
                    <div ref={debugEndRef} />
                  </div>
                </div>
              )}
            </div>

            <div className="cb-divider" />

            <button className="cb-new-chat-btn" onClick={handleNewChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
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
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            <span className="cb-topbar-title">庫存 AI 分析師</span>
            <span className="cb-topbar-badge">Case 11</span>
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"
                  strokeLinecap="round" strokeLinejoin="round" width="48" height="48">
                  <ellipse cx="12" cy="5" rx="9" ry="3"/>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">庫存 AI 分析師</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? '用自然語言查詢庫存資料，Agent 自動生成 SQL 並回答'
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && (
                <div className="cb-empty-examples">
                  <p className="cb-empty-examples-label">試試看：</p>
                  {EXAMPLES.map(ex => (
                    <button key={ex.q} className="cb-example-btn" onClick={() => setInput(ex.q)}>
                      <span className="cb-example-icon">{ex.icon}</span>
                      {ex.q}
                    </button>
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
                  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                }
              </div>
              <div className="cb-msg-content-wrap">
                {/* SqlViewer：顯示生成的 SQL */}
                {msg.role === 'assistant' && msg.sqlInfo && (
                  <SqlViewer sqlInfo={msg.sqlInfo} />
                )}
                <div className="cb-msg-bubble">
                  {msg.role === 'assistant'
                    ? msg.content
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : loading
                        ? <div className="cb-typing"><span/><span/><span/></div>
                        : <p className="cb-waiting cb-waiting--empty">（無回應）</p>
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
              placeholder={llmConfig.api_key ? '輸入庫存查詢問題... (Shift+Enter 換行)' : '請先填入 API Key'}
              disabled={loading} rows={1} />
            <button className={`cb-send-btn${loading ? ' cb-send-btn--loading' : ''}`}
              onClick={handleSend} disabled={!input.trim() || loading}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
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
