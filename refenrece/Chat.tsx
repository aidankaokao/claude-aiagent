import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toPng } from 'html-to-image'
import { useAuth, reportTokens } from './AuthContext'
import AuthUserIcon from './AuthUserIcon'
import TokenToast from './TokenToast'
import './Chat.css'

/* ─────────────────────────────────────────────
   Types
   ───────────────────────────────────────────── */

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface UploadedFile {
  name: string
  type: 'image'
  content: string    // base64 (no data: prefix)
  mimeType: string
}

type LlmProvider = 'openai' | 'gemini' | 'ollama'
interface LlmConfig {
  openai: { apiKey: string }
  gemini: { apiKey: string }
  ollama: { url: string; model: string }
}
const LLM_INIT: LlmConfig = {
  openai: { apiKey: '' },
  gemini: { apiKey: '' },
  ollama: { url: 'http://localhost:11434', model: 'llama3' },
}

/* ─────────────────────────────────────────────
   CSV export helpers
   ───────────────────────────────────────────── */

function hasMarkdownTable(content: string): boolean {
  return /\|[ \t]*[-:]+[ \t]*\|/.test(content)
}

function markdownToCsv(content: string): string {
  const lines = content.split('\n')
  const csvBlocks: string[] = []
  let currentBlock: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (/^\|[ \t:|-]+\|$/.test(trimmed)) continue // skip separator row
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map(c => {
          const val = c.trim()
          return /[,"\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val
        })
      currentBlock.push(cells.join(','))
    } else if (currentBlock.length > 0) {
      csvBlocks.push(currentBlock.join('\n'))
      currentBlock = []
    }
  }
  if (currentBlock.length > 0) csvBlocks.push(currentBlock.join('\n'))
  return csvBlocks.join('\n\n')
}

function downloadAsCsv(content: string, msgId: string): void {
  const csv = markdownToCsv(content)
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `table-${msgId}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* ─────────────────────────────────────────────
   File helpers
   ───────────────────────────────────────────── */

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}


/* ─────────────────────────────────────────────
   Icons
   ───────────────────────────────────────────── */

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2"  x2="12" y2="5"  />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="4.22" y1="4.22"  x2="6.34" y2="6.34"  />
      <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
      <line x1="2"  y1="12" x2="5"  y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34"  x2="19.78" y2="4.22"  />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z" />
      <polyline points="9 21 9 12 15 12 15 21" />
    </svg>
  )
}
function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  )
}

function ChevronsLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  )
}

function ChevronsRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <line x1="12" y1="7" x2="12" y2="11" />
      <line x1="8" y1="15" x2="8" y2="15" strokeWidth="2.5" />
      <line x1="12" y1="15" x2="12" y2="15" strokeWidth="2.5" />
      <line x1="16" y1="15" x2="16" y2="15" strokeWidth="2.5" />
    </svg>
  )
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function DownloadCsvIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ImageDownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function ImageFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}


function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  )
}

/* ─────────────────────────────────────────────
   Component
   ───────────────────────────────────────────── */

interface Props {
  onBack: () => void
}

export default function Chat({ onBack }: Props) {
  const { user } = useAuth()
  const [isDark, setIsDark] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('openai')
  const [llmSaved, setLlmSaved] = useState<LlmConfig>(LLM_INIT)
  const [llmDraft, setLlmDraft] = useState<LlmConfig>(LLM_INIT)
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [messages, setMessages] = useState<Message[]>([])
  const [convProvider, setConvProvider] = useState<LlmProvider | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null)
  const [processingFile, setProcessingFile] = useState(false)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)
  const [tokenToast, setTokenToast] = useState<{ provider: string; tokens: number } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function isLlmConfigured() {
    if (llmProvider === 'openai') return !!llmSaved.openai.apiKey
    if (llmProvider === 'gemini') return !!llmSaved.gemini.apiKey
    return !!(llmSaved.ollama.url && llmSaved.ollama.model)
  }

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  function handleSaveLlm() {
    setLlmSaved(prev => ({ ...prev, [llmProvider]: { ...llmDraft[llmProvider] } }))
    setError(null)
    if (llmProvider === 'ollama') {
      setOllamaStatus('checking')
      fetch(`${llmDraft.ollama.url}/api/version`, { signal: AbortSignal.timeout(5000) })
        .then(r => setOllamaStatus(r.ok ? 'ok' : 'error'))
        .catch(() => setOllamaStatus('error'))
    }
  }

  function handleClearLlm() {
    const empty = llmProvider === 'ollama'
      ? { url: 'http://localhost:11434', model: 'llama3' } as { url: string; model: string }
      : { apiKey: '' } as { apiKey: string }
    setLlmSaved(prev => ({ ...prev, [llmProvider]: empty }))
    setLlmDraft(prev => ({ ...prev, [llmProvider]: empty }))
    if (llmProvider === 'ollama') setOllamaStatus('idle')
    setMessages([])
    setConvProvider(null)
    setError(null)
  }

  function handleNewConversation() {
    setMessages([])
    setConvProvider(null)
    setError(null)
    setUploadedFile(null)
  }

  async function handleTestOllama() {
    setOllamaStatus('checking')
    try {
      const res = await fetch(`${llmDraft.ollama.url}/api/version`, { signal: AbortSignal.timeout(5000) })
      setOllamaStatus(res.ok ? 'ok' : 'error')
    } catch {
      setOllamaStatus('error')
    }
  }

  async function handleSend() {
    if (!isLlmConfigured() || !input.trim() || loading) return
    if (convProvider === null) setConvProvider(llmProvider)
    setError(null)

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
    }

    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    setLoading(true)

    const assistantId = (Date.now() + 1).toString()
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '' }])

    let lastTokenCount = 0
    try {
      if (llmProvider === 'openai' || llmProvider === 'gemini') {
        const endpoint = llmProvider === 'openai'
          ? 'https://api.openai.com/v1/chat/completions'
          : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        const model = llmProvider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash'
        const apiKey = llmProvider === 'openai' ? llmSaved.openai.apiKey : llmSaved.gemini.apiKey

        const builtMessages: any[] = []
        updatedMessages.forEach((m, i) => {
          const isLastUser = i === updatedMessages.length - 1 && m.role === 'user'
          if (isLastUser && uploadedFile?.type === 'image') {
            builtMessages.push({
              role: 'user',
              content: [
                { type: 'text', text: m.content },
                { type: 'image_url', image_url: { url: `data:${uploadedFile.mimeType};base64,${uploadedFile.content}` } },
              ],
            })
          } else {
            builtMessages.push({ role: m.role, content: m.content })
          }
        })

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: builtMessages, stream: true, stream_options: { include_usage: true } }),
        })
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}))
          throw new Error(errData?.error?.message ?? `HTTP ${response.status}`)
        }
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') break
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content ?? ''
              accumulated += delta
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulated } : m))
              const usageTokens = parsed.usage?.total_tokens ?? 0
              if (usageTokens > 0) lastTokenCount = usageTokens
            } catch { /* skip malformed chunks */ }
          }
        }
      } else {
        // Ollama — NDJSON streaming
        const ollamaMessages: any[] = []
        updatedMessages.forEach((m, i) => {
          const isLastUser = i === updatedMessages.length - 1 && m.role === 'user'
          if (isLastUser && uploadedFile?.type === 'image') {
            ollamaMessages.push({ role: 'user', content: m.content, images: [uploadedFile.content] })
          } else {
            ollamaMessages.push({ role: m.role, content: m.content })
          }
        })

        const response = await fetch(`${llmSaved.ollama.url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: llmSaved.ollama.model,
            messages: ollamaMessages,
            stream: true,
            options: { temperature: 0.7 },
          }),
        })
        if (!response.ok) throw new Error(`Ollama 錯誤：HTTP ${response.status}`)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let accumulated = ''
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line)
              const delta = obj.message?.content ?? ''
              if (delta) {
                accumulated += delta
                setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulated } : m))
              }
              if (obj.done) {
                const ollamaTokens = (obj.prompt_eval_count ?? 0) + (obj.eval_count ?? 0)
                if (ollamaTokens > 0) lastTokenCount = ollamaTokens
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '發生未知錯誤'
      setError(msg)
      setMessages(prev => prev.filter(m => m.id !== assistantId))
    } finally {
      setLoading(false)
      if (lastTokenCount > 0) {
        reportTokens(user, llmProvider, lastTokenCount)
        setTokenToast({ provider: llmProvider, tokens: lastTokenCount })
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleCopy(msgId: string, content: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMsgId(msgId)
      setTimeout(() => setCopiedMsgId(id => id === msgId ? null : id), 2000)
    } catch { /* ignore */ }
  }

  async function handleDownloadPng(msgId: string) {
    const bubbleEl = document.querySelector<HTMLElement>(`[data-msg-id="${msgId}"] .chat-msg-bubble`)
    if (!bubbleEl) return
    try {
      const dataUrl = await toPng(bubbleEl, { pixelRatio: 2 })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `table-${msgId}.png`
      a.click()
    } catch { /* ignore */ }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setProcessingFile(true)
    setError(null)
    try {
      const base64 = await readFileAsBase64(file)
      setUploadedFile({ name: file.name, type: 'image', content: base64, mimeType: file.type })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setError(`圖片讀取失敗：${detail}`)
    } finally {
      setProcessingFile(false)
      e.target.value = ''
    }
  }

  /* ── Render ── */
  return (
    <>
    <div className={`chat-root${isDark ? '' : ' light'}`}>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      {/* Sidebar */}
      <aside className={`chat-sidebar${sidebarOpen ? '' : ' chat-sidebar--collapsed'}`}>
        <div className="sidebar-top">
          {sidebarOpen && (
            <span className="sidebar-brand">設定</span>
          )}
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? '收合側邊欄' : '展開側邊欄'}
          >
            {sidebarOpen ? <ChevronsLeftIcon /> : <ChevronsRightIcon />}
          </button>
        </div>

        {sidebarOpen && (
          <div className="sidebar-body">
            {/* 服務商 tabs */}
            <div className="chat-provider-tabs">
              {(['openai', 'gemini', 'ollama'] as LlmProvider[]).map(p => (
                <button
                  key={p}
                  className={`chat-provider-tab${llmProvider === p ? ' active' : ''}`}
                  onClick={() => setLlmProvider(p)}
                >
                  {p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : 'Ollama'}
                </button>
              ))}
            </div>

            {/* OpenAI / Gemini */}
            {(llmProvider === 'openai' || llmProvider === 'gemini') && (
              <>
                <div className="sidebar-section-label">
                  <KeyIcon />
                  <span>API Key</span>
                </div>
                <input
                  className="sidebar-input"
                  type="password"
                  value={(llmDraft[llmProvider] as { apiKey: string }).apiKey}
                  onChange={e => setLlmDraft(prev => ({ ...prev, [llmProvider]: { apiKey: e.target.value } }))}
                  onKeyDown={e => e.key === 'Enter' && handleSaveLlm()}
                  placeholder={llmProvider === 'openai' ? 'sk-...' : 'AIza...'}
                  autoComplete="off"
                />
                <div className="sidebar-key-actions">
                  <button
                    className="sidebar-btn sidebar-btn--primary"
                    onClick={handleSaveLlm}
                    disabled={!(llmDraft[llmProvider] as { apiKey: string }).apiKey.trim()}
                  >儲存</button>
                  {(llmSaved[llmProvider] as { apiKey: string }).apiKey && (
                    <button className="sidebar-btn sidebar-btn--danger" onClick={handleClearLlm}>清除</button>
                  )}
                </div>
                <div className={`sidebar-key-status${isLlmConfigured() ? ' sidebar-key-status--ok' : ''}`}>
                  <span className="status-dot" />
                  <span>{isLlmConfigured() ? 'API Key 已設定' : '尚未設定 API Key'}</span>
                </div>
                <p className="sidebar-hint">Key 僅存於記憶體，關閉頁面後自動清除。</p>
              </>
            )}

            {/* Ollama */}
            {llmProvider === 'ollama' && (
              <>
                <div className="sidebar-section-label"><span>URL</span></div>
                <input
                  className="sidebar-input"
                  value={llmDraft.ollama.url}
                  onChange={e => setLlmDraft(prev => ({ ...prev, ollama: { ...prev.ollama, url: e.target.value } }))}
                  placeholder="http://localhost:11434"
                />
                <div className="sidebar-section-label" style={{ marginTop: '8px' }}><span>Model</span></div>
                <input
                  className="sidebar-input"
                  value={llmDraft.ollama.model}
                  onChange={e => setLlmDraft(prev => ({ ...prev, ollama: { ...prev.ollama, model: e.target.value } }))}
                  placeholder="llama3"
                />
                <div className="sidebar-key-actions">
                  <button className="sidebar-btn sidebar-btn--primary" onClick={handleSaveLlm}>儲存</button>
                  <button
                    className="sidebar-btn"
                    onClick={handleTestOllama}
                    disabled={ollamaStatus === 'checking'}
                    style={{ border: '1px solid var(--border)' }}
                  >
                    {ollamaStatus === 'checking' ? '測試中...' : '測試連線'}
                  </button>
                </div>
                {ollamaStatus === 'ok' && (
                  <div className="sidebar-key-status sidebar-key-status--ok">
                    <span className="status-dot" /><span>連線成功</span>
                  </div>
                )}
                {ollamaStatus === 'error' && (
                  <p className="sidebar-hint" style={{ color: 'var(--danger)' }}>
                    ⚠ 無法連線，請確認 URL 是否正確，以及 Ollama 服務是否已啟動，並重新修改 LLM 設定。
                  </p>
                )}
                <p className="sidebar-hint">設定僅存於記憶體，關閉頁面後自動清除。</p>
              </>
            )}
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="chat-main">

        {/* Top bar */}
        <div className="chat-topbar">
          <div className="chat-topbar-title">
            <BotIcon />
            <span>AI 問答</span>
            <span className="chat-provider-badge">
              {(convProvider ?? llmProvider) === 'openai' ? 'OpenAI' : (convProvider ?? llmProvider) === 'gemini' ? 'Gemini' : 'Ollama'}
            </span>
          </div>
          <div className="chat-topbar-actions">
            <button className="chat-ctrl-btn" onClick={handleNewConversation}
              aria-label="新對話" title="新對話">
              <NewChatIcon />
            </button>
            <button className="chat-ctrl-btn" onClick={() => setIsDark(!isDark)}
              aria-label={isDark ? '切換亮色' : '切換深色'}>
              {isDark ? <SunIcon /> : <MoonIcon />}
            </button>
            <button className="chat-ctrl-btn" onClick={onBack} aria-label="返回首頁">
              <HomeIcon />
            </button>
            <AuthUserIcon />
          </div>
        </div>

        {/* Messages */}
        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="chat-empty">
              {isLlmConfigured()
                ? <>
                    <BotIcon />
                    <p>你好！有什麼我可以幫你的嗎？</p>
                  </>
                : <>
                    <KeyIcon />
                    <p>{llmProvider === 'ollama'
                      ? '請先在左側側邊欄設定 Ollama URL 與 Model 以開始對話。'
                      : '請先在左側側邊欄設定 API Key 以開始對話。'
                    }</p>
                  </>
              }
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} data-msg-id={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
              <div className="chat-msg-avatar">
                {msg.role === 'assistant' ? <BotIcon /> : <UserIcon />}
              </div>
              <div className="chat-msg-bubble">
                {msg.content
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  : <span className="chat-typing"><span /><span /><span /></span>
                }
              </div>
              {msg.role === 'assistant' && msg.content && (
                <div className="chat-msg-actions">
                  <button
                    className={`chat-action-btn${copiedMsgId === msg.id ? ' chat-action-btn--copied' : ''}`}
                    onClick={() => handleCopy(msg.id, msg.content)}
                    title="複製內容"
                  >
                    {copiedMsgId === msg.id ? <CheckIcon /> : <CopyIcon />}
                  </button>
                  {hasMarkdownTable(msg.content) && (<>
                    <button
                      className="chat-action-btn"
                      onClick={() => handleDownloadPng(msg.id)}
                      title="下載表格為 PNG"
                    >
                      <ImageDownloadIcon />
                    </button>
                    <button
                      className="chat-action-btn"
                      onClick={() => downloadAsCsv(msg.content, msg.id)}
                      title="匯出表格為 CSV"
                    >
                      <DownloadCsvIcon />
                    </button>
                  </>)}
                </div>
              )}
            </div>
          ))}

          {error && (
            <div className="chat-error">
              ⚠ {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="chat-input-area">
          {/* File badge */}
          {(uploadedFile || processingFile) && (
            <div className="chat-file-badge-wrap">
              <div className="chat-file-badge">
                {processingFile ? (
                  <>
                    <span className="file-badge-spinner" />
                    <span className="file-badge-name">處理中…</span>
                  </>
                ) : (
                  <>
                    <ImageFileIcon />
                    <span className="file-badge-name">{uploadedFile!.name}</span>
                    <button
                      className="file-badge-remove"
                      onClick={() => setUploadedFile(null)}
                      aria-label="移除圖片"
                    >
                      <XIcon />
                    </button>
                  </>
                )}
              </div>
              {uploadedFile && llmProvider === 'ollama' && (
                <span className="chat-vision-hint">
                  ⚠ Ollama 需使用支援視覺的模型（如 llava）才能分析圖片
                </span>
              )}
            </div>
          )}

          <div className={`chat-input-box${!isLlmConfigured() ? ' chat-input-box--disabled' : ''}`}>
            <button
              className="input-action-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!isLlmConfigured() || loading || processingFile}
              aria-label="上傳圖片"
              title="上傳圖片"
            >
              <PaperclipIcon />
            </button>

            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                !isLlmConfigured()
                  ? (llmProvider === 'ollama' ? '請先設定 Ollama' : '請先設定 API Key') :
                uploadedFile ? '根據已上傳圖片提問… (Enter 送出，Shift+Enter 換行)' :
                '輸入訊息… (Enter 送出，Shift+Enter 換行)'
              }
              disabled={!isLlmConfigured() || loading}
              rows={1}
            />

            <button
              className={`input-send-btn${loading ? ' input-send-btn--loading' : ''}`}
              onClick={handleSend}
              disabled={!isLlmConfigured() || !input.trim() || loading}
              aria-label="送出"
            >
              <SendIcon />
            </button>
          </div>
        </div>

      </div>
    </div>
    {tokenToast && (
      <TokenToast provider={tokenToast.provider} tokens={tokenToast.tokens} onDone={() => setTokenToast(null)} />
    )}
    </>
  )
}
