/**
 * Chat.tsx — 訂單審批聊天介面（Human-in-the-Loop Agent）
 *
 * 與前面 Case 的主要差異：
 * - Message 新增 'approval' 型別，對應 ApprovalQueue 元件
 * - handleSend 偵測 approval_required 事件：以審批卡片替換空白 assistant 泡泡
 * - handleDecide：POST /api/orders/{thread_id}/decide (SSE)，恢復暫停的圖執行
 * - Sidebar：商品目錄 + 待審批 badge 計數
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ApprovalQueue, { ApprovalData, OrderItem } from './ApprovalQueue'
import ProductSelector, { SelectionData, ResolvedItem } from './ProductSelector'
import QuantityClarify, { QuantifyClarifyData, QuantityResolved } from './QuantityClarify'
import './Chat.css'

// ── 型別定義 ──

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'processing'
type SelectionStatus = 'pending' | 'processing' | 'resolved'
type QuantifyStatus = 'pending' | 'processing' | 'resolved'

interface Message {
  role: 'user' | 'assistant' | 'approval' | 'selection' | 'quantity'
  content: string
  approvalData?: ApprovalData
  approvalStatus?: ApprovalStatus
  selectionData?: SelectionData
  selectionStatus?: SelectionStatus
  quantifyData?: QuantifyClarifyData
  quantifyStatus?: QuantifyStatus
}

interface Product {
  id: string
  name: string
  category: string
  price: number
  stock: number
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
  temperature: 0.3,
}

const API_BASE = '/api'

// ── SSE 串流解析工具函式 ──

async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (type: string, data: Record<string, unknown>) => void,
) {
  const decoder = new TextDecoder()
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
      try { onEvent(eventType, JSON.parse(dataStr)) } catch { /* 忽略解析失敗 */ }
    }
  }
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
  const [products, setProducts] = useState<Product[]>([])

  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [configSaved, setConfigSaved] = useState(false)

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [isDark, setIsDark] = useState(true)
  const [showApiKey, setShowApiKey] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 計算待審批數量（顯示於 badge）
  const pendingCount = messages.filter(
    m => m.role === 'approval' && m.approvalStatus === 'pending'
  ).length

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/conversations`)
      if (res.ok) setConversations(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/products`)
      if (res.ok) setProducts(await res.json())
    } catch { /* 靜默失敗 */ }
  }, [])

  useEffect(() => {
    loadConversations()
    loadProducts()
  }, [loadConversations, loadProducts])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = '24px'
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
    }
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
        setMessages(
          data.messages.map((m: { role: string; content: string }) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }))
        )
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

  // ── 發送訊息 ──
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!llmConfig.api_key) { setError('請先在左側設定填入 API Key'); return }

    setInput('')
    setError(null)
    setLoading(true)

    // assistantIdx：空白 assistant 泡泡的位置（user 之後）
    const assistantIdx = messages.length + 1

    setMessages(prev => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ])

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
      if (!reader) throw new Error('無法讀取串流')

      let gotApproval = false

      await readSSEStream(reader, (eventType, data) => {
        if (eventType === 'token') {
          // 正常回覆串流（無需審批的訂單）
          setMessages(prev => {
            const updated = [...prev]
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: updated[assistantIdx].content + (data.content as string),
            }
            return updated
          })

        } else if (eventType === 'quantity_clarify_required') {
          // ask_quantity_node interrupt：使用者未指定數量
          gotApproval = true
          setMessages(prev => {
            const updated = [...prev]
            updated.splice(assistantIdx, 1, {
              role: 'quantity',
              content: '',
              quantifyData: {
                thread_id: data.thread_id as string,
                items: data.items as QuantifyClarifyData['items'],
              },
              quantifyStatus: 'pending',
            })
            return updated
          })

        } else if (eventType === 'product_selection_required') {
          // clarify_node interrupt：商品無法比對，顯示選擇卡片
          gotApproval = true  // 防止 done 時移除 placeholder
          setMessages(prev => {
            const updated = [...prev]
            updated.splice(assistantIdx, 1, {
              role: 'selection',
              content: '',
              selectionData: {
                thread_id: data.thread_id as string,
                unresolved_items: data.unresolved_items as SelectionData['unresolved_items'],
              },
              selectionStatus: 'pending',
            })
            return updated
          })

        } else if (eventType === 'approval_required') {
          // 圖被 interrupt 暫停：將空白 assistant 替換成審批卡片
          gotApproval = true
          setMessages(prev => {
            const updated = [...prev]
            updated.splice(assistantIdx, 1, {
              role: 'approval',
              content: '',
              approvalData: {
                thread_id: data.thread_id as string,
                parsed_items: data.parsed_items as ApprovalData['parsed_items'],
                price_details: data.price_details as ApprovalData['price_details'],
                threshold: data.threshold as number,
              },
              approvalStatus: 'pending',
            })
            return updated
          })

        } else if (eventType === 'done') {
          if (data.conversation_id) setConversationId(data.conversation_id as string)
          // 若未觸發審批且 assistant 泡泡仍為空，移除它
          if (!gotApproval) {
            setMessages(prev => {
              const updated = [...prev]
              if (updated[assistantIdx]?.role === 'assistant' && !updated[assistantIdx].content) {
                updated.splice(assistantIdx, 1)
              }
              return updated
            })
          }
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '發生錯誤')
        }
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '連線失敗')
      // 移除空白 assistant 泡泡
      setMessages(prev => {
        const updated = [...prev]
        if (updated[assistantIdx]?.role === 'assistant' && !updated[assistantIdx].content) {
          updated.splice(assistantIdx, 1)
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  // ── 審批決定：恢復 interrupt 暫停的圖 ──
  const handleDecide = async (
    approvalMsgIdx: number,
    action: 'approved' | 'rejected',
    modifiedItems?: OrderItem[],
  ) => {
    const msg = messages[approvalMsgIdx]
    if (!msg?.approvalData) return
    const threadId = msg.approvalData.thread_id

    // 1. 標記為處理中，同時在末尾插入空白 assistant 串流槽
    setMessages(prev => {
      const updated = [...prev]
      updated[approvalMsgIdx] = { ...updated[approvalMsgIdx], approvalStatus: 'processing' }
      return [...updated, { role: 'assistant', content: '' }]
    })

    setLoading(true)
    setError(null)

    try {
      const body: Record<string, unknown> = { action, llm_config: llmConfig }
      if (modifiedItems) body.items = modifiedItems

      const res = await fetch(`${API_BASE}/orders/${threadId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('無法讀取串流')

      await readSSEStream(reader, (eventType, data) => {
        if (eventType === 'token') {
          // 更新末尾的 assistant 串流槽
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant') {
              updated[last] = {
                ...updated[last],
                content: updated[last].content + (data.content as string),
              }
            }
            return updated
          })

        } else if (eventType === 'done') {
          // 更新審批卡片為最終狀態
          setMessages(prev => {
            const updated = [...prev]
            updated[approvalMsgIdx] = {
              ...updated[approvalMsgIdx],
              approvalStatus: action,
            }
            // 若 agent 沒有回覆任何文字，移除空白 assistant 泡泡
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1)
            }
            return updated
          })
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '審批處理失敗')
          // 復原審批卡片為 pending，移除空白 assistant 泡泡
          setMessages(prev => {
            const updated = [...prev]
            updated[approvalMsgIdx] = { ...updated[approvalMsgIdx], approvalStatus: 'pending' }
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1)
            }
            return updated
          })
        }
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '審批請求失敗')
      setMessages(prev => {
        const updated = [...prev]
        updated[approvalMsgIdx] = { ...updated[approvalMsgIdx], approvalStatus: 'pending' }
        const last = updated.length - 1
        if (updated[last]?.role === 'assistant' && !updated[last].content) {
          updated.splice(last, 1)
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  // ── 商品選擇：恢復 clarify_node interrupt ──
  const handleSelect = async (
    selectionMsgIdx: number,
    resolvedItems: ResolvedItem[],
  ) => {
    const msg = messages[selectionMsgIdx]
    if (!msg?.selectionData) return
    const threadId = msg.selectionData.thread_id

    // 標記為處理中，末尾插入空白 assistant 串流槽
    setMessages(prev => {
      const updated = [...prev]
      updated[selectionMsgIdx] = { ...updated[selectionMsgIdx], selectionStatus: 'processing' }
      return [...updated, { role: 'assistant', content: '' }]
    })

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_BASE}/chat/${threadId}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved_items: resolvedItems, llm_config: llmConfig }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('無法讀取串流')

      let gotApproval = false

      await readSSEStream(reader, (eventType, data) => {
        if (eventType === 'token') {
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant') {
              updated[last] = { ...updated[last], content: updated[last].content + (data.content as string) }
            }
            return updated
          })

        } else if (eventType === 'approval_required') {
          // 商品選擇後金額超過門檻 → 以審批卡片替換空白 assistant 槽
          gotApproval = true
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1, {
                role: 'approval',
                content: '',
                approvalData: {
                  thread_id: data.thread_id as string,
                  parsed_items: data.parsed_items as ApprovalData['parsed_items'],
                  price_details: data.price_details as ApprovalData['price_details'],
                  threshold: data.threshold as number,
                },
                approvalStatus: 'pending',
              })
            }
            return updated
          })

        } else if (eventType === 'done') {
          setMessages(prev => {
            const updated = [...prev]
            updated[selectionMsgIdx] = { ...updated[selectionMsgIdx], selectionStatus: 'resolved' }
            if (!gotApproval) {
              const last = updated.length - 1
              if (updated[last]?.role === 'assistant' && !updated[last].content) {
                updated.splice(last, 1)
              }
            }
            return updated
          })
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '商品選擇處理失敗')
          setMessages(prev => {
            const updated = [...prev]
            updated[selectionMsgIdx] = { ...updated[selectionMsgIdx], selectionStatus: 'pending' }
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1)
            }
            return updated
          })
        }
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '商品選擇請求失敗')
      setMessages(prev => {
        const updated = [...prev]
        updated[selectionMsgIdx] = { ...updated[selectionMsgIdx], selectionStatus: 'pending' }
        const last = updated.length - 1
        if (updated[last]?.role === 'assistant' && !updated[last].content) {
          updated.splice(last, 1)
        }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  // ── 數量確認：恢復 ask_quantity_node interrupt ──
  const handleQuantifyClarify = async (
    quantifyMsgIdx: number,
    quantities: QuantityResolved[],
  ) => {
    const msg = messages[quantifyMsgIdx]
    if (!msg?.quantifyData) return
    const threadId = msg.quantifyData.thread_id

    // 標記為處理中，末尾插入空白 assistant 串流槽
    setMessages(prev => {
      const updated = [...prev]
      updated[quantifyMsgIdx] = { ...updated[quantifyMsgIdx], quantifyStatus: 'processing' }
      return [...updated, { role: 'assistant', content: '' }]
    })

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_BASE}/chat/${threadId}/clarify-quantity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantities, llm_config: llmConfig }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('無法讀取串流')

      let gotNext = false

      await readSSEStream(reader, (eventType, data) => {
        if (eventType === 'token') {
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant') {
              updated[last] = { ...updated[last], content: updated[last].content + (data.content as string) }
            }
            return updated
          })

        } else if (eventType === 'product_selection_required') {
          // 數量確認後，商品仍需選擇 → 顯示商品選擇卡片
          gotNext = true
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1, {
                role: 'selection',
                content: '',
                selectionData: {
                  thread_id: data.thread_id as string,
                  unresolved_items: data.unresolved_items as SelectionData['unresolved_items'],
                },
                selectionStatus: 'pending',
              })
            }
            return updated
          })

        } else if (eventType === 'approval_required') {
          // 數量確認後觸發審批
          gotNext = true
          setMessages(prev => {
            const updated = [...prev]
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1, {
                role: 'approval',
                content: '',
                approvalData: {
                  thread_id: data.thread_id as string,
                  parsed_items: data.parsed_items as ApprovalData['parsed_items'],
                  price_details: data.price_details as ApprovalData['price_details'],
                  threshold: data.threshold as number,
                },
                approvalStatus: 'pending',
              })
            }
            return updated
          })

        } else if (eventType === 'done') {
          setMessages(prev => {
            const updated = [...prev]
            updated[quantifyMsgIdx] = { ...updated[quantifyMsgIdx], quantifyStatus: 'resolved' }
            if (!gotNext) {
              const last = updated.length - 1
              if (updated[last]?.role === 'assistant' && !updated[last].content) {
                updated.splice(last, 1)
              }
            }
            return updated
          })
          loadConversations()

        } else if (eventType === 'error') {
          setError((data.message as string) || '數量確認處理失敗')
          setMessages(prev => {
            const updated = [...prev]
            updated[quantifyMsgIdx] = { ...updated[quantifyMsgIdx], quantifyStatus: 'pending' }
            const last = updated.length - 1
            if (updated[last]?.role === 'assistant' && !updated[last].content) {
              updated.splice(last, 1)
            }
            return updated
          })
        }
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '數量確認請求失敗')
      setMessages(prev => {
        const updated = [...prev]
        updated[quantifyMsgIdx] = { ...updated[quantifyMsgIdx], quantifyStatus: 'pending' }
        const last = updated.length - 1
        if (updated[last]?.role === 'assistant' && !updated[last].content) {
          updated.splice(last, 1)
        }
        return updated
      })
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

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className={`chat-root${isDark ? '' : ' light'}`}>

      {/* ===== Sidebar ===== */}
      <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-top">
          {sidebarOpen && (
            <div className="sidebar-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              <span className="sidebar-logo-text">訂單審批</span>
            </div>
          )}
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>

        {sidebarOpen && (
          <>
            {/* LLM 設定 */}
            <div className="sidebar-section">
              <div className="sidebar-section-title">LLM 設定</div>
              <div className="sidebar-field">
                <label>API Key</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="sidebar-input"
                    placeholder="sk-..."
                    value={llmDraft.api_key}
                    onChange={e => setLlmDraft(p => ({ ...p, api_key: e.target.value }))}
                    style={{ paddingRight: '28px' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    style={{
                      position: 'absolute', right: '6px', top: '50%',
                      transform: 'translateY(-50%)', background: 'none',
                      border: 'none', cursor: 'pointer', color: 'var(--muted)',
                      display: 'flex', padding: 0,
                    }}
                  >
                    {showApiKey
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="12" height="12"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>
              <div className="sidebar-field">
                <label>Model</label>
                <input type="text" className="sidebar-input" placeholder="gpt-4o-mini"
                  value={llmDraft.model}
                  onChange={e => setLlmDraft(p => ({ ...p, model: e.target.value }))} />
              </div>
              <div className="sidebar-field">
                <label>Base URL</label>
                <input type="text" className="sidebar-input" placeholder="https://api.openai.com/v1"
                  value={llmDraft.base_url}
                  onChange={e => setLlmDraft(p => ({ ...p, base_url: e.target.value }))}
                  style={{ fontSize: '11px' }} />
              </div>
              <div className="sidebar-field">
                <label>Temperature: {llmDraft.temperature.toFixed(1)}</label>
                <input
                  type="range" min="0" max="2" step="0.1"
                  value={llmDraft.temperature}
                  onChange={e => setLlmDraft(p => ({ ...p, temperature: parseFloat(e.target.value) }))}
                  style={{ width: '100%', accentColor: 'var(--gold)' }}
                />
              </div>
              <button
                onClick={handleSaveConfig}
                style={{
                  width: '100%', padding: '6px 0',
                  background: configSaved ? 'rgba(52,211,153,0.12)' : 'var(--input-bg)',
                  border: `1px solid ${configSaved ? 'rgba(52,211,153,0.35)' : 'var(--input-border)'}`,
                  borderRadius: '6px',
                  color: configSaved ? '#34d399' : 'var(--muted)',
                  fontSize: '11px', cursor: 'pointer',
                  fontFamily: 'Noto Sans TC, sans-serif',
                  transition: 'all 0.2s',
                }}
              >
                {configSaved ? '✓ 已儲存' : '儲存設定'}
              </button>
            </div>

            {/* 商品目錄 */}
            {products.length > 0 && (
              <div className="sidebar-section">
                <div
                  className="sidebar-section-title"
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  onClick={() => setProductsOpen(!productsOpen)}
                >
                  <span>商品目錄 ({products.length})</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="11" height="11"
                    style={{ transform: productsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </div>
                {productsOpen && (
                  <div className="product-list">
                    {products.map(p => (
                      <div key={p.id} className="product-item">
                        <div>
                          <div className="product-name">{p.name}</div>
                          <div className="product-category">{p.category}</div>
                        </div>
                        <div className="product-price">NT${p.price.toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 分隔線 + 對話清單標題 */}
            <div className="sidebar-section" style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
              <div className="sidebar-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>對話紀錄</span>
                {pendingCount > 0 && (
                  <span className="pending-badge">{pendingCount}</span>
                )}
              </div>
              <button
                onClick={handleNewChat}
                style={{
                  width: '100%', padding: '5px 8px',
                  background: 'transparent',
                  border: '1px dashed var(--border)',
                  borderRadius: '6px', color: 'var(--muted)',
                  fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '5px',
                  fontFamily: 'Noto Sans TC, sans-serif',
                  transition: 'all 0.15s',
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                新對話
              </button>
            </div>

            <div className="sidebar-conversations">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`conv-item${conversationId === conv.id ? ' active' : ''}`}
                  onClick={() => loadConversation(conv.id)}
                >
                  <span className="conv-item-text">{conv.title || '未命名對話'}</span>
                  <button
                    className="conv-delete"
                    onClick={e => handleDeleteConversation(conv.id, e)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14H6L5 6"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* ===== Main ===== */}
      <div className="chat-main">

        {/* Topbar */}
        <div className="topbar">
          <div className="topbar-left">
            <svg className="topbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="19" height="19">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            <span className="topbar-title">訂單審批 Agent</span>
          </div>
          <div className="topbar-right">
            {llmConfig.api_key && (
              <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'DM Mono, monospace' }}>
                {llmConfig.model}
              </span>
            )}
            <button className="icon-btn" onClick={() => setIsDark(!isDark)} title="切換主題">
              {isDark
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
              }
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="messages-wrap">
          {messages.length === 0 && (
            <div className="welcome-wrap">
              <svg className="welcome-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" width="48" height="48">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              <div className="welcome-title">訂單審批 Agent</div>
              <div className="welcome-sub">
                {llmConfig.api_key
                  ? '以自然語言下訂單，金額超過門檻時系統自動暫停，由您決定是否核准。'
                  : '請先在左側填入 API Key 以開始使用。'}
              </div>
              {llmConfig.api_key && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', maxWidth: '360px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '2px' }}>試試看：</div>
                  {[
                    '我想買鍵盤',
                    '我要買 2 個電腦儲存裝置',
                    '我想訂 3 個無線滑鼠跟 2 個機械鍵盤',
                    '幫我訂 15 個 USB集線器',
                  ].map(ex => (
                    <button
                      key={ex}
                      onClick={() => setInput(ex)}
                      style={{
                        padding: '8px 12px',
                        background: 'var(--input-bg)',
                        border: '1px solid var(--input-border)',
                        borderRadius: '8px',
                        color: 'var(--muted)',
                        fontSize: '13px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'Noto Sans TC, sans-serif',
                        transition: 'all 0.15s',
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((msg, idx) => {
            // ── 數量確認卡片 ──
            if (msg.role === 'quantity' && msg.quantifyData && msg.quantifyStatus) {
              return (
                <div key={idx} className="msg-row msg-row--approval" style={{ maxWidth: '560px' }}>
                  <QuantityClarify
                    data={msg.quantifyData}
                    status={msg.quantifyStatus}
                    onConfirm={quantities => handleQuantifyClarify(idx, quantities)}
                  />
                </div>
              )
            }

            // ── 商品選擇卡片 ──
            if (msg.role === 'selection' && msg.selectionData && msg.selectionStatus) {
              return (
                <div key={idx} className="msg-row msg-row--approval" style={{ maxWidth: '640px' }}>
                  <ProductSelector
                    data={msg.selectionData}
                    status={msg.selectionStatus}
                    onSelect={resolvedItems => handleSelect(idx, resolvedItems)}
                  />
                </div>
              )
            }

            // ── 審批卡片 ──
            if (msg.role === 'approval' && msg.approvalData && msg.approvalStatus) {
              return (
                <div key={idx} className="msg-row msg-row--approval" style={{ maxWidth: '640px' }}>
                  <ApprovalQueue
                    data={msg.approvalData}
                    status={msg.approvalStatus}
                    onDecide={(action, items) => handleDecide(idx, action, items)}
                  />
                </div>
              )
            }

            // ── 一般訊息泡泡 ──
            return (
              <div key={idx} className={`msg-row msg-row--${msg.role}`}>
                <div className={`msg-bubble msg-bubble--${msg.role}`}>
                  {msg.role === 'assistant'
                    ? msg.content
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : (loading && idx === messages.length - 1
                          ? <span className="cursor-blink" />
                          : null)
                    : <span>{msg.content}</span>
                  }
                </div>
              </div>
            )
          })}

          {error && (
            <div className="error-bar">
              <span>{error}</span>
              <button
                onClick={() => setError(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', marginLeft: '8px' }}
              >✕</button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="input-area">
          <div className="input-row">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={llmConfig.api_key ? '輸入訂單需求... (Shift+Enter 換行)' : '請先填入 API Key'}
              disabled={loading}
              rows={1}
            />
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim() || loading}
            >
              {loading
                ? <span className="spinner" />
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
              }
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px', paddingLeft: '2px' }}>
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>Enter 送出 · Shift+Enter 換行</span>
            {pendingCount > 0 && (
              <span style={{ fontSize: '11px', color: 'var(--gold)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--gold)', display: 'inline-block' }} />
                {pendingCount} 筆訂單等待審批
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
