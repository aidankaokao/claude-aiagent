/**
 * Chat.tsx — 全端整合聊天介面（Case 10）
 *
 * 核心設計：自適應顯示，根據後端 mode SSE 事件選擇視覺化元件
 *
 * Message 型別擴展（整合 Case 3 + Case 9）：
 * - mode / modeReason  → ModeBadge 顯示路由決策
 * - toolCalls          → ToolCallPanel（tools 模式）
 * - agentSteps         → AgentFlow（research 模式）
 *
 * SSE 事件對應：
 * - mode        → 設定 msg.mode + msg.modeReason
 * - tool_start  → push running ToolCall
 * - tool_end    → 更新 ToolCall 狀態 + output
 * - agent_start → push running AgentStep（research mode）
 * - agent_end   → 更新 AgentStep；writer content fallback；react content fallback
 * - token       → 累積 content
 * - done        → finalize，終極 content fallback
 * - error       → 顯示錯誤訊息
 *
 * SSE 解析注意事項：
 * - sse-starlette 使用 \r\n 行結尾，空白分隔行為 "\r"，需用 line.trim() === '' 識別
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ModeBadge from './ModeBadge'
import ToolCallPanel, { type ToolCall } from './ToolCallPanel'
import AgentFlow, { type AgentStep } from './AgentFlow'
import './Chat.css'

// ============================================================
// 型別定義
// ============================================================

interface Message {
  role: 'user' | 'assistant'
  content: string
  mode?: 'chat' | 'tools' | 'research'
  modeReason?: string
  toolCalls?: ToolCall[]
  agentSteps?: AgentStep[]
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

// ============================================================
// ModeExamples — 三種模式的範例問題
// ============================================================

const MODE_EXAMPLES = [
  { mode: 'chat',     icon: '💬', q: '幫我寫一首關於秋天的短詩' },
  { mode: 'chat',     icon: '💬', q: '解釋什麼是遞迴函式？' },
  { mode: 'tools',    icon: '🔧', q: '計算 (2 ** 10 - 1) * 3 的結果' },
  { mode: 'tools',    icon: '🔧', q: '現在幾點？今天是星期幾？' },
  { mode: 'tools',    icon: '🔧', q: '查詢 LangGraph 的相關知識' },
  { mode: 'research', icon: '🔬', q: '分析 LangGraph 與傳統工作流引擎的差異' },
  { mode: 'research', icon: '🔬', q: 'AI Agent 的發展趨勢與未來挑戰' },
]

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

  // SSE Debug 面板
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  const debugEndRef = useRef<HTMLDivElement>(null)

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

  // ── 發送訊息（SSE 串流）──────────────────────────────────
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
      { role: 'assistant', content: '', toolCalls: [], agentSteps: [] },
    ])

    // ── 宣告在 try 外（讓 finally 也能存取）──────────────────
    const ts = () => new Date().toISOString().slice(11, 23)
    const dbg = (msg: string) => setDebugLog(prev => [...prev.slice(-199), `${ts()} ${msg}`])
    dbg(`─── 串流開始 model=${llmConfig.model} ───`)

    let streamDone = false
    let finalized = false

    const finalize = (reason: string) => {
      if (finalized) return
      finalized = true
      dbg(`─── 串流結束（${reason}）───`)
      setLoading(false)
    }
    // ─────────────────────────────────────────────────────────

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
      let stepCounter = 0

      const dispatchSseEvent = (eventType: string, dataStr: string) => {
        const preview = eventType === 'token' ? `len=${dataStr.length}` : dataStr.slice(0, 160)
        dbg(`  [${eventType}]  ${preview}`)
        try {
          const data = JSON.parse(dataStr)

          // ── mode：設定路由決策 ─────────────────────────────
          if (eventType === 'mode') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = {
                ...msg,
                mode: data.mode,
                modeReason: data.reason || undefined,
              }
              return updated
            })

          // ── tool_start：新增 running 工具呼叫 ────────────
          } else if (eventType === 'tool_start') {
            const newTc: ToolCall = {
              run_id: data.run_id,
              tool_name: data.tool_name,
              tool_input: data.tool_input ?? {},
              status: 'running',
            }
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = {
                ...msg,
                toolCalls: [...(msg.toolCalls ?? []), newTc],
              }
              return updated
            })

          // ── tool_end：更新工具呼叫狀態 ───────────────────
          } else if (eventType === 'tool_end') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = {
                ...msg,
                toolCalls: (msg.toolCalls ?? []).map(tc =>
                  tc.run_id === data.run_id
                    ? { ...tc, tool_output: data.tool_output, status: 'done' as const }
                    : tc
                ),
              }
              return updated
            })

          // ── agent_start：新增 running AgentStep ──────────
          } else if (eventType === 'agent_start') {
            const newStep: AgentStep = {
              id: `${data.agent}-${stepCounter++}`,
              agent: data.agent as AgentStep['agent'],
              status: 'running',
              startTime: performance.now(),
            }
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = {
                ...msg,
                agentSteps: [...(msg.agentSteps ?? []), newStep],
              }
              return updated
            })

          // ── agent_end：更新 AgentStep + content fallback ─
          } else if (eventType === 'agent_end') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev

              // 更新 AgentStep（從尾端找最後一個 running 的同名步驟）
              const steps = [...(msg.agentSteps ?? [])]
              for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].agent === data.agent && steps[i].status === 'running') {
                  steps[i] = {
                    ...steps[i],
                    status: 'done',
                    summary: data.summary || undefined,
                    endTime: performance.now(),
                  }
                  break
                }
              }

              // content fallback（writer 或 react 最終答案）
              const newContent =
                data.content && !msg.content
                  ? data.content
                  : msg.content

              updated[assistantIdx] = { ...msg, agentSteps: steps, content: newContent }
              return updated
            })

          // ── token：累積串流 content ───────────────────────
          } else if (eventType === 'token') {
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = { ...msg, content: msg.content + data.content }
              return updated
            })

          // ── done：完成，終極 content fallback ────────────
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

          // ── error ─────────────────────────────────────────
          } else if (eventType === 'error') {
            setError(data.message || '發生錯誤')
            streamDone = true
            finalize('error event')
          }
        } catch { /* 忽略 JSON 解析失敗 */ }
      }

      // SSE 解析：line.trim() === '' 識別空白分隔行（相容 \r\n）
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
              dispatchSseEvent(sseEvent, sseDataLines.join('\n'))
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

  // ============================================================
  // 渲染
  // ============================================================
  return (
    <div className={`cb-root${isDark ? '' : ' light'}`}>
      {/* ===== Sidebar ===== */}
      <aside className={`cb-sidebar${sidebarOpen ? '' : ' cb-sidebar--collapsed'}`}>
        <div className="cb-sidebar-top">
          {sidebarOpen && <span className="cb-sidebar-brand">Integrated</span>}
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

            {/* 模式說明 */}
            <div className="cb-settings-section">
              <div className="cb-settings-header" style={{ cursor: 'default' }}>
                <span className="cb-section-label">執行模式</span>
              </div>
              <div className="cb-mode-list">
                <div className="cb-mode-item cb-mode-chat">
                  <span className="cb-mode-dot" />
                  <div>
                    <div className="cb-mode-name">Chat</div>
                    <div className="cb-mode-desc">直接對話、創意寫作</div>
                  </div>
                </div>
                <div className="cb-mode-item cb-mode-tools">
                  <span className="cb-mode-dot" />
                  <div>
                    <div className="cb-mode-name">Tools</div>
                    <div className="cb-mode-desc">計算、時間、知識查詢</div>
                  </div>
                </div>
                <div className="cb-mode-item cb-mode-research">
                  <span className="cb-mode-dot" />
                  <div>
                    <div className="cb-mode-name">Research</div>
                    <div className="cb-mode-desc">深度分析、比較研究</div>
                  </div>
                </div>
              </div>
            </div>

            {/* SSE Debug */}
            <div className="cb-settings-section">
              <button className="cb-settings-header" onClick={() => setDebugOpen(!debugOpen)}>
                <span className="cb-section-label">SSE Debug</span>
                <div className="cb-settings-header-right">
                  {debugLog.length > 0 && <span className="cb-debug-count">{debugLog.length}</span>}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
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
                            line.includes('[mode]')        ? ' cb-debug-mode' :
                            line.includes('[agent_start]') ? ' cb-debug-start' :
                            line.includes('[agent_end]')   ? ' cb-debug-end' :
                            line.includes('[tool_start]')  ? ' cb-debug-tool' :
                            line.includes('[tool_end]')    ? ' cb-debug-tool' :
                            line.includes('[done]')        ? ' cb-debug-done' :
                            line.includes('[error]')       ? ' cb-debug-error' :
                            line.includes('token')         ? ' cb-debug-token' : ''
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
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span className="cb-topbar-title">智慧助手</span>
            <span className="cb-topbar-badge">Case 10</span>
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
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">智慧助手</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? 'Router 自動選擇最佳策略：直接對話 / 工具查詢 / 深度研究'
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && (
                <div className="cb-empty-examples">
                  <p className="cb-empty-examples-label">試試看：</p>
                  {MODE_EXAMPLES.map(ex => (
                    <button key={ex.q} className="cb-example-btn" onClick={() => setInput(ex.q)}>
                      <span className="cb-example-mode-icon">{ex.icon}</span>
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
                  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                }
              </div>
              <div className="cb-msg-content-wrap">
                {/* ── 自適應視覺化（assistant 訊息才顯示）── */}
                {msg.role === 'assistant' && (
                  <>
                    {/* 1. 模式標示（Router 決策結果）*/}
                    {msg.mode && (
                      <ModeBadge mode={msg.mode} reason={msg.modeReason} />
                    )}
                    {/* 2. Tools 模式：工具呼叫面板 */}
                    {msg.mode === 'tools' && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <ToolCallPanel toolCalls={msg.toolCalls} />
                    )}
                    {/* 3. Research 模式：Agent Pipeline 視覺化 */}
                    {msg.mode === 'research' && msg.agentSteps && msg.agentSteps.length > 0 && (
                      <AgentFlow steps={msg.agentSteps} />
                    )}
                  </>
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
