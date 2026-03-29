/**
 * Chat.tsx — 庫存管理助手聊天介面
 *
 * 與 Case 2 的差異：
 * - 新增右側 InventoryTable 面板（可收折）
 * - 接收到 tool_end 事件且工具名稱為 update_stock 時，遞增 inventoryRefreshTrigger，
 *   觸發 InventoryTable 自動重新拉取最新庫存
 * - Sidebar 工具清單更新為四個庫存相關工具
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import InventoryTable from './InventoryTable'
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
  toolCalls?: ToolCall[]
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

// LLM 設定預設值
const DEFAULT_CONFIG: LlmConfig = {
  api_key: '',
  model: 'gpt-4o-mini',
  base_url: 'https://api.openai.com/v1',
  temperature: 0.7,
}

// Vite dev proxy 將 /api/* 轉發到 localhost:8000
const API_BASE = '/api'

// 工具名稱對應中文顯示
const TOOL_LABELS: Record<string, string> = {
  query_inventory:    '查詢庫存',
  update_stock:       '更新庫存',
  get_weather_forecast: '天氣預報',
  calculate_reorder:  '計算補貨量',
}

// ============================================================
// ToolCallPanel — 工具呼叫視覺化元件（與 Case 2 相同）
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
          {/* 工具標題列（可點擊展開） */}
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
              {/* 顯示第一個輸入參數作為預覽 */}
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

          {/* 展開後顯示完整的輸入 JSON 與輸出結果 */}
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

  // 庫存面板是否顯示（右側面板）
  const [inventoryOpen, setInventoryOpen] = useState(true)
  // 此值每次 update_stock 工具完成時遞增，觸發 InventoryTable 重新拉取資料
  const [inventoryRefreshTrigger, setInventoryRefreshTrigger] = useState(0)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 取得所有對話列表，顯示在側邊欄
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  // 根據輸入內容自動調整 textarea 高度，最高 160px
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) { ta.style.height = '24px'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px' }
  }, [input])

  // 將暫存設定套用為正式設定，並顯示 2 秒的成功提示
  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  // 載入指定對話的歷史訊息
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

  // 重置畫面至空白對話狀態
  const handleNewChat = () => {
    setMessages([])
    setConversationId(null)
    setError(null)
    setInput('')
  }

  // 刪除對話（後端會串連刪除 tool_calls → messages → conversations）
  const handleDeleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`${API_BASE}/conversations/${convId}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== convId))
    if (conversationId === convId) handleNewChat()
  }

  // 發送訊息並處理 SSE 串流
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!llmConfig.api_key) { setError('請先在左側設定填入 API Key'); return }

    setInput('')
    setError(null)
    setLoading(true)

    // assistantIdx：預先計算 assistant 訊息在陣列中的位置，
    // 後續 token / tool_start / tool_end 事件都靠此索引定位
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

        // 逐行解析 SSE 格式（event: xxx\ndata: {...}）
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
                  // LLM 逐字輸出，累加到 assistant 訊息的 content
                  setMessages(prev => {
                    const updated = [...prev]
                    updated[assistantIdx] = {
                      ...updated[assistantIdx],
                      content: updated[assistantIdx].content + data.content,
                    }
                    return updated
                  })

                } else if (eventType === 'tool_start') {
                  // 新增一筆 running 狀態的工具呼叫記錄
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
                  // 依 run_id 找到對應工具，更新輸出與狀態
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

                  // update_stock 執行完成 → 觸發庫存表刷新
                  if (data.tool_name === 'update_stock') {
                    setInventoryRefreshTrigger(n => n + 1)
                  }

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

  // Enter 送出（Shift+Enter 換行），isComposing 防止中文輸入法誤送
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  // 複製訊息內容，短暫顯示「已複製」圖示
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
          {sidebarOpen && <span className="cb-sidebar-brand">庫存管理</span>}
          <button className="cb-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>

        {sidebarOpen && (
          <div className="cb-sidebar-body">
            {/* LLM 設定面板 */}
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

            {/* 可用工具說明 */}
            <div className="cb-settings-section">
              <div className="cb-section-label" style={{ padding: '8px 4px 6px' }}>可用工具</div>
              <div className="cb-tool-list-info">
                {[
                  { icon: '📦', name: '查詢庫存',   desc: 'query_inventory' },
                  { icon: '✏️', name: '更新庫存',   desc: 'update_stock' },
                  { icon: '🌤️', name: '天氣預報',   desc: 'get_weather_forecast' },
                  { icon: '🧮', name: '計算補貨量', desc: 'calculate_reorder' },
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
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
            </svg>
            <span className="cb-topbar-title">庫存管理助手</span>
            <span className="cb-topbar-badge">Case 3</span>
          </div>
          <div className="cb-topbar-right">
            {llmConfig.api_key && <span className="cb-model-badge">{llmConfig.model}</span>}
            {/* 切換庫存面板顯示 */}
            <button className={`cb-ctrl-btn${inventoryOpen ? ' cb-ctrl-btn--active' : ''}`}
              onClick={() => setInventoryOpen(!inventoryOpen)} title="切換庫存面板">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
              </svg>
            </button>
            {/* 切換深色/淺色主題 */}
            <button className="cb-ctrl-btn" onClick={() => setIsDark(!isDark)}>
              {isDark
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
              }
            </button>
          </div>
        </header>

        {/* 工作區：聊天區（左）+ 庫存面板（右，可收折） */}
        <div className="cb-workspace">
          {/* 聊天訊息區 */}
          <div className="cb-chat-section">
            <div className="cb-messages">
              {messages.length === 0 && (
                <div className="cb-empty">
                  <div className="cb-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" width="48" height="48">
                      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                    </svg>
                  </div>
                  <h2 className="cb-empty-title">庫存管理助手</h2>
                  <p className="cb-empty-desc">
                    {llmConfig.api_key
                      ? '可查詢庫存、更新數量、查天氣、計算補貨量'
                      : '請先在左側填入 API Key'}
                  </p>
                  {llmConfig.api_key && (
                    <div className="cb-empty-examples">
                      <p className="cb-empty-examples-label">試試看：</p>
                      {[
                        '目前有哪些產品庫存不足？',
                        '幫我查詢電子產品的庫存狀況',
                        '台北今天天氣如何？對出貨有影響嗎？',
                        '智慧型手機每天賣 2 支，幫我算 30 天的補貨量',
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
                              ? null
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

          {/* 右側庫存面板（可收折） */}
          {inventoryOpen && (
            <div className="cb-inventory-panel">
              <InventoryTable refreshTrigger={inventoryRefreshTrigger} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
