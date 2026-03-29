/**
 * Chat.tsx — 主聊天介面元件
 *
 * LLM 設定（API Key、Model、Base URL）由使用者在 Sidebar 填入，
 * 儲存於記憶體（關閉頁面後清除），每次請求都帶上設定。
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Chat.css'

// === 型別定義 ===
interface Message {
  role: 'user' | 'assistant'
  content: string
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

export default function Chat() {
  // --- 核心狀態 ---
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])

  // --- LLM 設定（記憶體，不持久化） ---
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(DEFAULT_CONFIG)  // 編輯中的草稿
  const [configSaved, setConfigSaved] = useState(false)                 // 儲存成功提示

  // --- UI 狀態 ---
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(true)   // 設定面板是否展開
  const [isDark, setIsDark] = useState(true)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)       // 顯示/隱藏 API Key

  // --- Refs ---
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // --- 載入對話列表 ---
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  useEffect(() => { loadConversations() }, [loadConversations])

  // --- 自動捲動 ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // --- 自動調整輸入框高度 ---
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = '24px'
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
    }
  }, [input])

  // --- 儲存 LLM 設定 ---
  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  // --- 載入對話歷史 ---
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

  // --- 新對話 ---
  const handleNewChat = () => {
    setMessages([])
    setConversationId(null)
    setError(null)
    setInput('')
  }

  // --- 刪除對話 ---
  const handleDeleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`${API_BASE}/conversations/${convId}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== convId))
    if (conversationId === convId) handleNewChat()
  }

  // --- 發送訊息（SSE 串流） ---
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    if (!llmConfig.api_key) {
      setError('請先在左側設定填入 API Key')
      return
    }

    setInput('')
    setError(null)
    setLoading(true)

    const assistantIdx = messages.length + 1
    setMessages(prev => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }])

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversation_id: conversationId,
          llm_config: llmConfig,
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('無法讀取串流')

      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

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
                  setMessages(prev => {
                    const updated = [...prev]
                    updated[assistantIdx] = {
                      ...updated[assistantIdx],
                      content: updated[assistantIdx].content + data.content,
                    }
                    return updated
                  })
                } else if (eventType === 'done') {
                  if (data.conversation_id) setConversationId(data.conversation_id)
                  loadConversations()
                } else if (eventType === 'error') {
                  setError(data.message || '發生錯誤')
                }
              } catch { /* 忽略 */ }
            }
          } else if (!line.startsWith('data:') && line.trim() !== '') {
            buffer = lines.slice(i).join('\n')
            break
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '連線失敗'
      setError(errMsg)
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
          {sidebarOpen && <span className="cb-sidebar-brand">Chatbot</span>}
          <button className="cb-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>

        {sidebarOpen && (
          <div className="cb-sidebar-body">
            {/* === LLM 設定面板 === */}
            <div className="cb-settings-section">
              <button
                className="cb-settings-header"
                onClick={() => setSettingsOpen(!settingsOpen)}
              >
                <span className="cb-section-label">LLM 設定</span>
                <div className="cb-settings-header-right">
                  {llmConfig.api_key && (
                    <span className="cb-status-dot cb-status-dot--ok" title="API Key 已設定" />
                  )}
                  <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    style={{ transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </button>

              {settingsOpen && (
                <div className="cb-settings-body">
                  {/* API Key */}
                  <div className="cb-form-row">
                    <label className="cb-form-label">API Key</label>
                    <div className="cb-input-with-toggle">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        className="cb-form-input"
                        placeholder="sk-..."
                        value={llmDraft.api_key}
                        onChange={e => setLlmDraft(prev => ({ ...prev, api_key: e.target.value }))}
                      />
                      <button
                        className="cb-input-toggle-btn"
                        onClick={() => setShowApiKey(!showApiKey)}
                        title={showApiKey ? '隱藏' : '顯示'}
                        type="button"
                      >
                        {showApiKey ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Model */}
                  <div className="cb-form-row">
                    <label className="cb-form-label">Model</label>
                    <input
                      type="text"
                      className="cb-form-input"
                      placeholder="gpt-4o-mini"
                      value={llmDraft.model}
                      onChange={e => setLlmDraft(prev => ({ ...prev, model: e.target.value }))}
                    />
                  </div>

                  {/* Base URL */}
                  <div className="cb-form-row">
                    <label className="cb-form-label">Base URL</label>
                    <input
                      type="text"
                      className="cb-form-input cb-form-input--small"
                      placeholder="https://api.openai.com/v1"
                      value={llmDraft.base_url}
                      onChange={e => setLlmDraft(prev => ({ ...prev, base_url: e.target.value }))}
                    />
                  </div>

                  {/* Temperature */}
                  <div className="cb-form-row">
                    <label className="cb-form-label">
                      Temperature
                      <span className="cb-form-value">{llmDraft.temperature.toFixed(1)}</span>
                    </label>
                    <input
                      type="range"
                      className="cb-form-range"
                      min="0" max="2" step="0.1"
                      value={llmDraft.temperature}
                      onChange={e => setLlmDraft(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                    />
                  </div>

                  {/* 儲存按鈕 */}
                  <button className="cb-save-btn" onClick={handleSaveConfig}>
                    {configSaved ? (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        已儲存
                      </>
                    ) : '儲存設定'}
                  </button>
                </div>
              )}
            </div>

            {/* 分隔線 */}
            <div className="cb-divider" />

            {/* === 對話列表 === */}
            <button className="cb-new-chat-btn" onClick={handleNewChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              新對話
            </button>

            <div className="cb-conv-list">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`cb-conv-item${conversationId === conv.id ? ' cb-conv-item--active' : ''}`}
                  onClick={() => loadConversation(conv.id)}
                >
                  <span className="cb-conv-title">{conv.title || '未命名對話'}</span>
                  <button className="cb-conv-delete" onClick={e => handleDeleteConversation(conv.id, e)} title="刪除">
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

      {/* ===== Main Area ===== */}
      <div className="cb-main">
        {/* --- Topbar --- */}
        <header className="cb-topbar">
          <div className="cb-topbar-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span className="cb-topbar-title">Basic Chatbot</span>
            <span className="cb-topbar-badge">Case 1</span>
          </div>
          <div className="cb-topbar-right">
            {llmConfig.api_key && (
              <span className="cb-model-badge">{llmConfig.model}</span>
            )}
            <button className="cb-ctrl-btn" onClick={() => setIsDark(!isDark)} title={isDark ? '切換亮色' : '切換暗色'}>
              {isDark ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
              )}
            </button>
          </div>
        </header>

        {/* --- Messages Area --- */}
        <div className="cb-messages">
          {messages.length === 0 && (
            <div className="cb-empty">
              <div className="cb-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" width="48" height="48">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
              </div>
              <h2 className="cb-empty-title">開始對話</h2>
              <p className="cb-empty-desc">
                {llmConfig.api_key ? '輸入訊息開始與 AI 聊天' : '請先在左側填入 API Key'}
              </p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`cb-msg cb-msg--${msg.role}`}>
              <div className="cb-msg-avatar">
                {msg.role === 'user' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                    <rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/>
                  </svg>
                )}
              </div>
              <div className="cb-msg-bubble">
                {msg.role === 'assistant' ? (
                  msg.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  ) : (
                    <div className="cb-typing"><span/><span/><span/></div>
                  )
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
              {msg.role === 'assistant' && msg.content && (
                <div className="cb-msg-actions">
                  <button className="cb-action-btn" onClick={() => handleCopy(msg.content, idx)} title="複製">
                    {copiedIdx === idx ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                      </svg>
                    )}
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

        {/* --- Input Area --- */}
        <div className="cb-input-area">
          <div className="cb-input-box">
            <textarea
              ref={textareaRef}
              className="cb-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={llmConfig.api_key ? '輸入訊息... (Shift+Enter 換行)' : '請先填入 API Key'}
              disabled={loading}
              rows={1}
            />
            <button
              className={`cb-send-btn${loading ? ' cb-send-btn--loading' : ''}`}
              onClick={handleSend}
              disabled={!input.trim() || loading}
              title="送出"
            >
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
