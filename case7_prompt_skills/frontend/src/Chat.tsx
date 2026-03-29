import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import SkillSelector, { SkillInfo } from './SkillSelector'
import PromptPlayground from './PromptPlayground'
import './Chat.css'

const API_BASE = '/api'

// ── 型別定義 ──

export interface LlmConfig {
  api_key: string
  base_url: string
  model: string
  temperature: number
}

const DEFAULT_CONFIG: LlmConfig = {
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.7,
}

interface Message {
  id?: number
  role: 'user' | 'assistant'
  content: string
  skill?: string
  rated?: boolean
}

interface Conversation {
  id: string
  title: string
  updated_at: string
}

// ── SSE 讀取工具 ──
async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (eventType: string, data: Record<string, unknown>) => void,
) {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    let eventType = 'message'
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5).trim())
          onEvent(eventType, data)
        } catch {
          // ignore parse errors
        }
        eventType = 'message'
      }
    }
  }
}

// ── Skill 顯示名稱與顏色映射 ──
const SKILL_DISPLAY: Record<string, { label: string; icon: string; color: string }> = {
  email:       { label: 'Email 撰寫',  icon: '✉️',  color: '#60a5fa' },
  code_review: { label: '程式碼審查', icon: '🔍', color: '#a78bfa' },
  summarizer:  { label: '文章摘要',   icon: '📝', color: '#34d399' },
  translator:  { label: '語言翻譯',   icon: '🌐', color: '#fb923c' },
  unknown:     { label: '通用回答',   icon: '✨', color: '#94a3b8' },
}

function newThreadId() {
  return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [threadId, setThreadId] = useState(() => newThreadId())
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillOverride, setSkillOverride] = useState('')

  // LLM config (sidebar)
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [configSaved, setConfigSaved] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [showApiKey, setShowApiKey] = useState(false)

  // view & layout
  const [view, setView] = useState<'chat' | 'playground'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isDark, setIsDark] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── 儲存 LLM 設定 ──
  const handleSaveConfig = () => {
    setLlmConfig({ ...llmDraft })
    setConfigSaved(true)
    setTimeout(() => setConfigSaved(false), 2000)
  }

  // ── 載入技能清單 ──
  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/skills`)
      if (res.ok) setSkills(await res.json())
    } catch { /* ignore */ }
  }, [])

  // ── 載入對話列表 ──
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* ignore */ }
  }, [])

  // ── 載入指定對話的歷史訊息 ──
  const loadConversation = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${id}`)
      if (!res.ok) return
      const data = await res.json()
      setMessages(data.messages.map((m: Message & { skill_name?: string }) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        skill: m.skill_name,
      })))
      setThreadId(id)
      setView('chat')
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadSkills()
    loadConversations()
  }, [loadSkills, loadConversations])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── 發送訊息 ──
  const handleSend = async () => {
    if (!input.trim() || loading) return
    if (!llmConfig.api_key) {
      setError('請先在左側設定填入 API Key')
      return
    }

    const userMsg = input.trim()
    setInput('')
    setError(null)

    setMessages(prev => [...prev, { role: 'user', content: userMsg }])
    const assistantIdx = messages.length + 1
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])
    setLoading(true)

    let detectedSkill = ''

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMsg,
          thread_id: threadId,
          skill_override: skillOverride,
          llm_config: llmConfig,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('無法讀取串流')

      await readSSEStream(reader, (eventType, data) => {
        if (eventType === 'skill_detected') {
          detectedSkill = data.skill as string
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], skill: detectedSkill }
            return updated
          })

        } else if (eventType === 'token') {
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content + (data.content as string),
            }
            return updated
          })

        } else if (eventType === 'done') {
          const msgId = data.message_id as number
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              id: msgId,
              skill: (data.skill as string) || detectedSkill,
            }
            return updated
          })
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '發生錯誤')
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = { ...updated[assistantIdx], content: '⚠️ 發生錯誤，請重試' }
            return updated
          })
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '請求失敗')
      setMessages(prev => {
        const updated = [...prev]
        updated[assistantIdx] = { ...updated[assistantIdx], content: '⚠️ 發生錯誤，請重試' }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  // ── 評分 ──
  const handleRate = async (msgIdx: number, rating: number) => {
    const msg = messages[msgIdx]
    if (!msg || msg.rated || !msg.id) return
    try {
      await fetch(`${API_BASE}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: msg.id,
          conversation_id: threadId,
          skill_name: msg.skill || 'unknown',
          rating,
          feedback: '',
        }),
      })
      setMessages(prev => {
        const updated = [...prev]
        updated[msgIdx] = { ...updated[msgIdx], rated: true }
        return updated
      })
    } catch { /* ignore */ }
  }

  // ── 新對話 ──
  const handleNewChat = () => {
    setMessages([])
    setThreadId(newThreadId())
    setError(null)
    setView('chat')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const skillInfo = (name: string) =>
    SKILL_DISPLAY[name] ?? SKILL_DISPLAY.unknown

  return (
    <div className={`chat-root${isDark ? '' : ' light'}${sidebarOpen ? '' : ' sidebar-collapsed'}`}>

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          {sidebarOpen && <span className="sidebar-brand">Skill Agent</span>}
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>

        {sidebarOpen && (
          <div className="sidebar-body">

            {/* LLM 設定 */}
            <div className="settings-section">
              <button className="settings-header" onClick={() => setSettingsOpen(o => !o)}>
                <span className="section-label">LLM 設定</span>
                <div className="settings-header-right">
                  {llmConfig.api_key && <span className="status-dot status-dot--ok" />}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    style={{ transform: settingsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
              </button>
              {settingsOpen && (
                <div className="settings-body">
                  <div className="form-row">
                    <label className="form-label">API Key</label>
                    <div className="input-with-toggle">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        className="form-input"
                        placeholder="sk-..."
                        value={llmDraft.api_key}
                        onChange={e => setLlmDraft(p => ({ ...p, api_key: e.target.value }))}
                      />
                      <button className="input-toggle-btn" onClick={() => setShowApiKey(s => !s)} type="button">
                        {showApiKey
                          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        }
                      </button>
                    </div>
                  </div>
                  <div className="form-row">
                    <label className="form-label">Model</label>
                    <input type="text" className="form-input" placeholder="gpt-4o-mini"
                      value={llmDraft.model} onChange={e => setLlmDraft(p => ({ ...p, model: e.target.value }))} />
                  </div>
                  <div className="form-row">
                    <label className="form-label">Base URL</label>
                    <input type="text" className="form-input form-input--small"
                      placeholder="https://api.openai.com/v1"
                      value={llmDraft.base_url} onChange={e => setLlmDraft(p => ({ ...p, base_url: e.target.value }))} />
                  </div>
                  <div className="form-row">
                    <label className="form-label">
                      Temperature <span className="form-value">{llmDraft.temperature.toFixed(1)}</span>
                    </label>
                    <input type="range" className="form-range" min="0" max="2" step="0.1"
                      value={llmDraft.temperature}
                      onChange={e => setLlmDraft(p => ({ ...p, temperature: parseFloat(e.target.value) }))} />
                  </div>
                  <button className="save-btn" onClick={handleSaveConfig}>
                    {configSaved
                      ? <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>已儲存</>
                      : '儲存設定'}
                  </button>
                </div>
              )}
            </div>

            <div className="sidebar-divider" />

            {/* 技能選擇器 */}
            {skills.length > 0 && (
              <SkillSelector
                skills={skills}
                selected={skillOverride}
                onSelect={setSkillOverride}
              />
            )}

            <div className="sidebar-divider" />

            {/* 新對話按鈕 */}
            <button className="new-chat-btn" onClick={handleNewChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              新對話
            </button>

            {/* 對話歷史 */}
            {conversations.length > 0 && (
              <div className="conv-section">
                <div className="conv-section-title">對話記錄</div>
                {conversations.map(c => (
                  <button
                    key={c.id}
                    className={`conv-item ${c.id === threadId ? 'conv-item--active' : ''}`}
                    onClick={() => loadConversation(c.id)}
                  >
                    <span className="conv-title">{c.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* ── 主內容區 ── */}
      <div className="main-area">

        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <button className="topbar-icon-btn" onClick={() => setSidebarOpen(o => !o)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            <span className="topbar-title">Prompt & Skills</span>
            {/* View 切換 */}
            <div className="view-tabs">
              <button
                className={`view-tab ${view === 'chat' ? 'view-tab--active' : ''}`}
                onClick={() => setView('chat')}
              >對話</button>
              <button
                className={`view-tab ${view === 'playground' ? 'view-tab--active' : ''}`}
                onClick={() => setView('playground')}
              >Prompt Playground</button>
            </div>
          </div>
          <div className="topbar-right">
            {llmConfig.api_key && (
              <span className="model-badge">{llmConfig.model}</span>
            )}
            <button className="theme-toggle-btn" onClick={() => setIsDark(d => !d)} title="切換主題">
              {isDark ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>
          </div>
        </header>

        {/* ── Playground 視圖 ── */}
        {view === 'playground' && (
          <PromptPlayground skills={skills} llmConfig={llmConfig} />
        )}

        {/* ── Chat 視圖 ── */}
        {view === 'chat' && (
          <>
            <div className="messages-area">
              {messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">✨</div>
                  <div className="empty-title">Skill Agent</div>
                  <div className="empty-desc">
                    {llmConfig.api_key
                      ? '自動偵測意圖並選擇合適的技能回覆\n或從左側 Sidebar 手動選擇技能'
                      : '請先在左側設定填入 API Key'}
                  </div>
                  {llmConfig.api_key && (
                    <div className="example-prompts">
                      {[
                        '寫一封道歉信給合作夥伴，因為專案延誤了兩週',
                        '審查這段程式碼：for i in range(len(arr)): print(arr[i])',
                        '幫我摘要：人工智能的快速發展正在改變各行各業的運作方式…',
                        '翻譯成英文：本合約自雙方簽署日起生效，有效期為一年。',
                      ].map(ex => (
                        <button
                          key={ex}
                          className="example-btn"
                          onClick={() => { setInput(ex); textareaRef.current?.focus() }}
                        >
                          {ex.length > 40 ? ex.slice(0, 40) + '…' : ex}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`msg-row ${msg.role === 'user' ? 'msg-row--user' : 'msg-row--assistant'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="msg-avatar">
                      <span>{msg.skill ? skillInfo(msg.skill).icon : '✨'}</span>
                    </div>
                  )}
                  <div className="msg-content-wrap">
                    {msg.role === 'assistant' && msg.skill && (
                      <div
                        className="skill-badge"
                        style={{ '--badge-color': skillInfo(msg.skill).color } as React.CSSProperties}
                      >
                        {skillInfo(msg.skill).icon} {skillInfo(msg.skill).label}
                      </div>
                    )}

                    <div className={`msg-bubble ${msg.role === 'user' ? 'msg-bubble--user' : 'msg-bubble--assistant'}`}>
                      {msg.role === 'assistant' ? (
                        msg.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        ) : (
                          <span className="typing-cursor">▋</span>
                        )
                      ) : (
                        <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                      )}
                    </div>

                    {msg.role === 'assistant' && msg.id && !msg.rated && msg.content && (
                      <div className="rating-row">
                        <span className="rating-label">這個回覆有幫助嗎？</span>
                        {[1, 2, 3, 4, 5].map(star => (
                          <button key={star} className="rating-star" onClick={() => handleRate(idx, star)}>★</button>
                        ))}
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.rated && (
                      <div className="rating-done">✓ 感謝您的評分</div>
                    )}
                  </div>
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="input-area">
              {error && (
                <div className="error-bar">
                  <span>{error}</span>
                  <button onClick={() => setError(null)}>✕</button>
                </div>
              )}

              {skillOverride && (
                <div className="skill-override-bar">
                  <span
                    className="skill-override-badge"
                    style={{ '--badge-color': skillInfo(skillOverride).color } as React.CSSProperties}
                  >
                    {skillInfo(skillOverride).icon} 強制使用：{skillInfo(skillOverride).label}
                  </span>
                  <button className="skill-override-clear" onClick={() => setSkillOverride('')}>✕</button>
                </div>
              )}

              <div className="input-row">
                <textarea
                  ref={textareaRef}
                  className="chat-input"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    skillOverride
                      ? `強制使用「${skillInfo(skillOverride).label}」…`
                      : '輸入訊息，Agent 將自動偵測意圖…（Enter 傳送，Shift+Enter 換行）'
                  }
                  rows={1}
                  disabled={loading}
                />
                <button
                  className={`send-btn ${loading ? 'send-btn--loading' : ''}`}
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                >
                  {loading ? (
                    <span className="spinner" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                      <line x1="22" y1="2" x2="11" y2="13"/>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
