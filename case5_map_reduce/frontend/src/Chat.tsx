/**
 * Chat.tsx — 文件分析助手聊天介面（Map-Reduce Agent）
 *
 * 與 Case 4 的差異：
 * - 移除 PlanTimeline，改用 ProgressDashboard 元件
 * - 側邊欄改為顯示可分析的文件清單
 * - 新增四個 SSE 事件處理：
 *     documents_loaded → 初始化文件列表（全部 pending）
 *     doc_start        → 對應文件改為 analyzing
 *     doc_done         → 對應文件改為 done，附加摘要與情感
 *     reduce_start     → 進入最終整合階段
 * - Message 型別新增 docAnalyses 與 reducing 欄位
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ProgressDashboard, { DocAnalysis } from './ProgressDashboard'
import './Chat.css'

// === 型別定義 ===

interface Message {
  role: 'user' | 'assistant'
  content: string
  docAnalyses?: DocAnalysis[]
  reducing?: boolean
}

interface Conversation {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

interface DocumentInfo {
  id: string
  title: string
  category: string
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
// Chat — 主元件
// ============================================================
export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [availableDocs, setAvailableDocs] = useState<DocumentInfo[]>([])

  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [configSaved, setConfigSaved] = useState(false)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [docsOpen, setDocsOpen] = useState(true)
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

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/documents`)
      if (res.ok) setAvailableDocs(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  useEffect(() => {
    loadConversations()
    loadDocuments()
  }, [loadConversations, loadDocuments])

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

  // ── 發送訊息，處理 Map-Reduce SSE 事件 ──
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
      { role: 'assistant', content: '', docAnalyses: [], reducing: false },
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

      const handleEvent = (eventType: string, data: Record<string, unknown>) => {
        if (eventType === 'documents_loaded') {
          // 初始化所有文件為 pending
          const docs = (data.documents as Array<{id: string; title: string; category: string}>)
            .map(d => ({ ...d, status: 'pending' as const }))
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], docAnalyses: docs }
            return updated
          })

        } else if (eventType === 'doc_start') {
          const doc_id = data.doc_id as string
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            const newDocs = (msg.docAnalyses ?? []).map(d =>
              d.id === doc_id ? { ...d, status: 'analyzing' as const } : d
            )
            updated[assistantIdx] = { ...msg, docAnalyses: newDocs }
            return updated
          })

        } else if (eventType === 'doc_done') {
          const doc_id = data.doc_id as string
          const summary = data.summary as string
          const sentiment = data.sentiment as DocAnalysis['sentiment']
          const hasError = data.error as boolean
          setMessages(prev => {
            const updated = [...prev]
            const msg = updated[assistantIdx]
            const newDocs = (msg.docAnalyses ?? []).map(d =>
              d.id === doc_id
                ? { ...d, status: (hasError ? 'error' : 'done') as DocAnalysis['status'], summary, sentiment }
                : d
            )
            updated[assistantIdx] = { ...msg, docAnalyses: newDocs }
            return updated
          })

        } else if (eventType === 'reduce_start') {
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], reducing: true }
            return updated
          })

        } else if (eventType === 'token') {
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content + (data.content as string),
              reducing: false,
            }
            return updated
          })

        } else if (eventType === 'done') {
          if (data.conversation_id) setConversationId(data.conversation_id as string)
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], reducing: false }
            return updated
          })
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '發生錯誤')
        }
      }

      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

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
          try { handleEvent(eventType, JSON.parse(dataStr)) } catch { /* 忽略 JSON 解析失敗 */ }
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
          {sidebarOpen && <span className="cb-sidebar-brand">文件分析</span>}
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

            {/* 可分析文件 */}
            {availableDocs.length > 0 && (
              <div className="cb-settings-section">
                <button className="cb-settings-header" onClick={() => setDocsOpen(!docsOpen)}>
                  <span className="cb-section-label">可分析文件 ({availableDocs.length})</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    style={{ transform: docsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {docsOpen && (
                  <div className="cb-doc-list">
                    {availableDocs.map(doc => (
                      <div key={doc.id} className="cb-doc-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                          strokeLinecap="round" strokeLinejoin="round" width="12" height="12" style={{ color: 'var(--muted)', flexShrink: 0 }}>
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span className="cb-doc-item-title">{doc.title}</span>
                        <span className="cb-doc-category">{doc.category}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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
              <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
            <span className="cb-topbar-title">文件分析助手</span>
            <span className="cb-topbar-badge">Case 5</span>
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
                  <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
                  <polyline points="13 2 13 9 20 9"/>
                  <line x1="8" y1="13" x2="16" y2="13"/>
                  <line x1="8" y1="17" x2="16" y2="17"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">文件分析助手</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key
                  ? `Map-Reduce Agent — 並行分析 ${availableDocs.length} 份公司報告，生成跨文件洞察`
                  : '請先在左側填入 API Key'}
              </p>
              {llmConfig.api_key && availableDocs.length > 0 && (
                <div className="cb-empty-examples">
                  <p className="cb-empty-examples-label">試試看：</p>
                  {[
                    '分析所有公司的財務狀況與成長潛力',
                    '哪些公司面臨較大的風險？請比較並排序',
                    '從投資角度，哪些公司最值得關注？',
                    '分析各產業的整體趨勢與競爭態勢',
                  ].map(ex => (
                    <button key={ex} className="cb-example-btn" onClick={() => setInput(ex)}>{ex}</button>
                  ))}
                </div>
              )}
              {llmConfig.api_key && availableDocs.length === 0 && (
                <p className="cb-empty-desc" style={{ marginTop: '8px', fontFamily: 'DM Mono, monospace', fontSize: '12px' }}>
                  請先執行：python seed_data.py
                </p>
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
                {/* 並行文件分析進度面板 */}
                {msg.role === 'assistant' && msg.docAnalyses && msg.docAnalyses.length > 0 && (
                  <ProgressDashboard docs={msg.docAnalyses} reducing={msg.reducing} />
                )}
                <div className="cb-msg-bubble">
                  {msg.role === 'assistant'
                    ? msg.content
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : (msg.reducing
                          ? <div className="cb-typing"><span/><span/><span/></div>
                          : (msg.docAnalyses && msg.docAnalyses.some(d => d.status === 'analyzing' || d.status === 'pending')
                              ? null
                              : <div className="cb-typing"><span/><span/><span/></div>))
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
              placeholder={llmConfig.api_key ? '輸入分析問題... (Shift+Enter 換行)' : '請先填入 API Key'}
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
