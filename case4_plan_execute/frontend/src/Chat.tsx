/**
 * Chat.tsx — 旅行規劃助手聊天介面（Plan-Execute Agent）
 *
 * 與 Case 3 的差異：
 * - 移除庫存面板，新增 PlanTimeline 元件（嵌入在 assistant 訊息中）
 * - 新增三個 SSE 事件的處理：
 *     plan_created → 初始化步驟列表（全部 pending）
 *     step_start   → 將對應步驟改為 running
 *     step_done    → 將對應步驟改為 done，並附加結果摘要
 * - Message 型別新增 planSteps 欄位
 * - 載入歷史對話時，從 plan_json 還原步驟列表（全部顯示為 done）
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import PlanTimeline, { PlanStep } from './PlanTimeline'
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
  planSteps?: PlanStep[]   // Plan-Execute 步驟列表
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
  temperature: 0.7,
}

const API_BASE = '/api'

const TOOL_LABELS: Record<string, string> = {
  search_attractions:   '搜尋景點',
  check_weather:        '查詢天氣',
  find_restaurants:     '尋找餐廳',
  estimate_cost:        '估算費用',
}

// ============================================================
// ToolCallPanel — 工具呼叫視覺化（與 Case 2/3 相同）
// ============================================================
function ToolCallPanel({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }))

  if (toolCalls.length === 0) return null

  return (
    <div className="cb-tool-panel">
      {toolCalls.map(tc => (
        <div key={tc.run_id} className={`cb-tool-item cb-tool-item--${tc.status}`}>
          <button className="cb-tool-header" onClick={() => toggle(tc.run_id)}>
            <div className="cb-tool-header-left">
              {tc.status === 'running' ? (
                <span className="cb-tool-spinner" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
              <span className="cb-tool-name">{TOOL_LABELS[tc.tool_name] ?? tc.tool_name}</span>
              <span className="cb-tool-preview">
                {Object.values(tc.tool_input)[0] != null
                  ? String(Object.values(tc.tool_input)[0]).slice(0, 40)
                  : ''}
              </span>
            </div>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="13" height="13"
              style={{ transform: expanded[tc.run_id] ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) { ta.style.height = '24px'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px' }
  }, [input])

  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  // 載入歷史對話，並從 plan_json 還原步驟列表
  const loadConversation = async (convId: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${convId}`)
      if (res.ok) {
        const data = await res.json()
        setConversationId(convId)
        setMessages(data.messages.map((m: { role: string; content: string; plan_json?: string }) => {
          const msg: Message = {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }
          // 從 plan_json 還原 planSteps（歷史步驟全部顯示為 done）
          if (m.role === 'assistant' && m.plan_json) {
            try {
              const planArr: string[] = JSON.parse(m.plan_json)
              if (planArr.length > 0) {
                msg.planSteps = planArr.map(text => ({ text, status: 'done' as const }))
              }
            } catch { /* 忽略 */ }
          }
          return msg
        }))
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

  // ── 發送訊息，處理 Plan-Execute SSE 事件 ──
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!llmConfig.api_key) { setError('請先在左側設定填入 API Key'); return }

    setInput('')
    setError(null)
    setLoading(true)

    const assistantIdx = messages.length + 1
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', toolCalls: [], planSteps: [] },
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

      // SSE 正確解析：以 \n\n 分隔事件區塊，避免跨 chunk 的事件被截斷丟失
      let buffer = ''

      const handleEvent = (eventType: string, data: Record<string, unknown>) => {
        if (eventType === 'token') {
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content + (data.content as string),
            }
            return updated
          })

        } else if (eventType === 'plan_created') {
          const steps: PlanStep[] = (data.steps as string[]).map(text => ({
            text,
            status: 'pending',
          }))
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], planSteps: steps }
            return updated
          })

        } else if (eventType === 'step_start') {
          const step_index = data.step_index as number
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            const newSteps = (msg.planSteps ?? []).map((s, idx) =>
              idx === step_index ? { ...s, status: 'running' as const } : s
            )
            updated[assistantIdx] = { ...msg, planSteps: newSteps }
            return updated
          })

        } else if (eventType === 'step_done') {
          const step_index = data.step_index as number
          const result = data.result as string
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            const newSteps = (msg.planSteps ?? []).map((s, idx) =>
              idx === step_index ? { ...s, status: 'done' as const, result } : s
            )
            updated[assistantIdx] = { ...msg, planSteps: newSteps }
            return updated
          })

        } else if (eventType === 'tool_start') {
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            updated[assistantIdx] = {
              ...msg,
              toolCalls: [
                ...(msg.toolCalls ?? []),
                {
                  run_id: data.run_id as string,
                  tool_name: data.tool_name as string,
                  tool_input: data.tool_input as Record<string, unknown>,
                  status: 'running' as const,
                },
              ],
            }
            return updated
          })

        } else if (eventType === 'tool_end') {
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            updated[assistantIdx] = {
              ...msg,
              toolCalls: (msg.toolCalls ?? []).map(tc =>
                tc.run_id === data.run_id
                  ? { ...tc, tool_output: data.tool_output as string, status: 'done' as const }
                  : tc
              ),
            }
            return updated
          })

        } else if (eventType === 'done') {
          if (data.conversation_id) setConversationId(data.conversation_id as string)
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '發生錯誤')
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // 以雙換行分隔完整的 SSE 事件區塊；最後一塊可能不完整，留在 buffer
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          if (!block.trim()) continue
          let eventType = ''
          let dataStr = ''
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
          }
          if (!eventType || !dataStr) continue
          try {
            handleEvent(eventType, JSON.parse(dataStr))
          } catch { /* 忽略 JSON 解析失敗 */ }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '連線失敗')
      setMessages(prev => prev.filter((_, idx) => idx !== assistantIdx))
    } finally {
      setLoading(false)
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

  // === 渲染 ===
  return (
    <div className={`cb-root${isDark ? '' : ' light'}`}>
      {/* ===== Sidebar ===== */}
      <aside className={`cb-sidebar${sidebarOpen ? '' : ' cb-sidebar--collapsed'}`}>
        <div className="cb-sidebar-top">
          {sidebarOpen && <span className="cb-sidebar-brand">旅行規劃</span>}
          <button className="cb-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
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
                    <input type="text" className="cb-form-input cb-form-input--small"
                      placeholder="https://api.openai.com/v1"
                      value={llmDraft.base_url} onChange={e => setLlmDraft(p => ({ ...p, base_url: e.target.value }))} />
                  </div>
                  <div className="cb-form-row">
                    <label className="cb-form-label">
                      Temperature <span className="cb-form-value">{llmDraft.temperature.toFixed(1)}</span>
                    </label>
                    <input type="range" className="cb-form-range" min="0" max="2" step="0.1"
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

            {/* 可用工具說明 */}
            <div className="cb-settings-section">
              <div className="cb-section-label" style={{ padding: '8px 4px 6px' }}>可用工具</div>
              <div className="cb-tool-list-info">
                {[
                  { icon: '🗺️', name: '搜尋景點',   desc: 'search_attractions' },
                  { icon: '🌤️', name: '查詢天氣',   desc: 'check_weather' },
                  { icon: '🍜', name: '尋找餐廳',   desc: 'find_restaurants' },
                  { icon: '💰', name: '估算費用',   desc: 'estimate_cost' },
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
              <circle cx="12" cy="12" r="10"/><path d="M12 8l4 4-4 4M8 12h8"/>
            </svg>
            <span className="cb-topbar-title">旅行規劃助手</span>
            <span className="cb-topbar-badge">Case 4</span>
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
                  <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">旅行規劃助手</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? 'Plan-Execute Agent — 自動規劃並逐步執行您的旅遊需求'
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && (
                <div className="cb-empty-examples">
                  <p className="cb-empty-examples-label">試試看：</p>
                  {[
                    '幫我規劃東京 3 天 2 人行程，標準住宿',
                    '大阪 5 天親子旅遊，有小孩要注意什麼？',
                    '首爾 4 天行程，偏愛美食和購物',
                    '台北 2 天 2 人，預算型住宿，有哪些推薦？',
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
                {/* Plan-Execute 步驟時間軸（assistant 訊息，有步驟時顯示） */}
                {msg.role === 'assistant' && msg.planSteps && msg.planSteps.length > 0 && (
                  <PlanTimeline steps={msg.planSteps} />
                )}
                {/* 工具呼叫面板（可選，當工具在 executor 內被呼叫時顯示） */}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ToolCallPanel toolCalls={msg.toolCalls} />
                )}
                <div className="cb-msg-bubble">
                  {msg.role === 'assistant'
                    ? msg.content
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : ((msg.planSteps?.some(s => s.status === 'running') || msg.toolCalls?.some(tc => tc.status === 'running'))
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
              placeholder={llmConfig.api_key ? '輸入旅遊需求... (Shift+Enter 換行)' : '請先填入 API Key'}
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
