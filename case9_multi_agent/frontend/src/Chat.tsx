/**
 * Chat.tsx — Multi-Agent Supervisor 聊天介面（Case 9）
 *
 * 與 Case 8 的主要差異：
 * - Message 新增 agentSteps 欄位，追蹤每個回答的 Agent 執行流程
 * - AgentFlow 元件嵌在 assistant 泡泡上方（類似 Case 3 的 ToolCallPanel）
 * - agent_start → 新增 running 步驟；agent_end → 更新為 done（附摘要與計時）
 * - SSE 解析使用 line.trim() === '' 識別空白分隔行（\r\n 相容）
 *
 * SSE 事件處理：
 * - agent_start: 追加新步驟至 message.agentSteps（status='running'）
 * - agent_end:   將對應步驟更新為 status='done'（附摘要與 endTime）
 * - token:       累積 Writer 的串流輸出
 * - done:        更新 conversationId、重載對話清單、fallback content
 * - error:       顯示錯誤訊息
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import AgentFlow, { AgentStep } from './AgentFlow'
import './Chat.css'

// ============================================================
// 型別定義
// ============================================================

interface Message {
  role: 'user' | 'assistant'
  content: string
  agentSteps?: AgentStep[]
}

interface Conversation {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export interface LlmConfig {
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
// AgentTeamCard — 空白狀態的 Agent 介紹卡片
// ============================================================
function AgentTeamCard() {
  const agents = [
    {
      name: 'Supervisor',
      role: '主控協調者',
      desc: '分析任務進度，決定下一個呼叫的 Agent',
      colorClass: 'cb-agent-supervisor',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
      ),
    },
    {
      name: 'Researcher',
      role: '研究員',
      desc: '收集事實、探索多個角度，整理背景知識',
      colorClass: 'cb-agent-researcher',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      ),
    },
    {
      name: 'Analyst',
      role: '分析師',
      desc: '分析研究結果，提煉洞察與核心發現',
      colorClass: 'cb-agent-analyst',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
        </svg>
      ),
    },
    {
      name: 'Writer',
      role: '撰寫員',
      desc: '整合所有資訊，撰寫結構完整的最終報告',
      colorClass: 'cb-agent-writer',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      ),
    },
  ]

  return (
    <div className="cb-agent-team">
      {agents.map(a => (
        <div key={a.name} className={`cb-agent-card ${a.colorClass}`}>
          <div className="cb-agent-card-header">
            {a.icon}
            <span className="cb-agent-card-name">{a.name}</span>
            <span className="cb-agent-card-role">{a.role}</span>
          </div>
          <p className="cb-agent-card-desc">{a.desc}</p>
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
      { role: 'assistant', content: '', agentSteps: [] },
    ])

    // ── 宣告在 try 外，讓 finally 也能存取 ──────────────────────
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
    // ─────────────────────────────────────────────────────────────

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

      // SSE 解析：逐行累積，遇到空行才 dispatch 一個完整事件
      // 注意：line.trim() === '' 而非 line === ''，因為 sse-starlette 使用 \r\n 行結尾，
      // 空白分隔行分割後為 "\r" 而非 ""
      let buffer = ''
      let sseEvent = ''
      let sseDataLines: string[] = []

      // 用於為每個 agent_start 產生唯一 ID
      let stepCounter = 0

      const dispatchSseEvent = (eventType: string, dataStr: string) => {
        const preview = eventType === 'token' ? `len=${dataStr.length}` : dataStr.slice(0, 200)
        dbg(`  [${eventType}]  ${preview}`)
        try {
          const data = JSON.parse(dataStr)

          if (eventType === 'agent_start') {
            // 新增一個 running 狀態的步驟到此 assistant 訊息
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

          } else if (eventType === 'agent_end') {
            // 將最後一個同名且 running 的步驟更新為 done
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
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
              // Writer fallback：ainvoke 不發 token stream 時，從 agent_end 取得完整內容
              const newContent = (data.agent === 'writer' && data.content && !msg.content)
                ? data.content
                : msg.content
              updated[assistantIdx] = { ...msg, agentSteps: steps, content: newContent }
              return updated
            })

          } else if (eventType === 'token') {
            // Writer token 串流：逐字累積
            setMessages(prev => {
              const updated = [...prev]
              const msg = updated[assistantIdx]
              if (!msg) return prev
              updated[assistantIdx] = { ...msg, content: msg.content + data.content }
              return updated
            })

          } else if (eventType === 'done') {
            if (data.conversation_id) setConversationId(data.conversation_id)
            // 終極 fallback：token streaming 和 agent_end 都沒帶來內容時使用
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
        } catch { /* 忽略 JSON 解析失敗 */ }
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
            // 空白分隔行：觸發一個完整 SSE 事件的 dispatch
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
      // 保底：若 done/error event 沒收到，在連線關閉時也確保清理
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
          {sidebarOpen && <span className="cb-sidebar-brand">Multi-Agent</span>}
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

            {/* SSE Debug 面板 */}
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
                            line.includes('[agent_start]') ? ' cb-debug-start' :
                            line.includes('[agent_end]')   ? ' cb-debug-end' :
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
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
            </svg>
            <span className="cb-topbar-title">Multi-Agent</span>
            <span className="cb-topbar-badge">Case 9</span>
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
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">AI 研究團隊</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? 'Supervisor 會自動分派任務給 Researcher、Analyst、Writer'
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && (
                <>
                  <AgentTeamCard />
                  <div className="cb-empty-examples">
                    <p className="cb-empty-examples-label">試試看：</p>
                    {[
                      '分析 LangGraph 的優勢與適用場景',
                      'AI Agent 的發展趨勢與未來挑戰',
                      '比較 ReAct 與 Plan-Execute Agent 的差異',
                      '如何評估一個 LLM 應用的生產就緒程度',
                    ].map(ex => (
                      <button key={ex} className="cb-example-btn" onClick={() => setInput(ex)}>{ex}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`cb-msg cb-msg--${msg.role}`}>
              <div className="cb-msg-avatar">
                {msg.role === 'user'
                  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
                }
              </div>
              <div className="cb-msg-content-wrap">
                {/* Agent Pipeline 視覺化（assistant 訊息才顯示，類似 Case 3 的 ToolCallPanel） */}
                {msg.role === 'assistant' && msg.agentSteps && msg.agentSteps.length > 0 && (
                  <AgentFlow steps={msg.agentSteps} />
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
