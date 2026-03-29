/**
 * KnowledgeBase.tsx — 知識庫右側面板元件
 *
 * 功能：
 * - 從 GET /api/articles 取得文章清單（直接讀取 kb.db，不透過 MCP）
 * - 客戶端依標題/標籤即時篩選
 * - 點擊文章卡片展開/收合內容摘要
 * - 「在對話中搜尋」按鈕：呼叫 onSearch callback，將查詢字串送至聊天輸入框
 */

import { useState, useEffect, useCallback } from 'react'
import './KnowledgeBase.css'

// === 型別定義 ===

interface Article {
  id: number
  title: string
  content: string   // 後端已截斷至 200 字
  tags: string
  created_at: string
}

interface Props {
  onSearch?: (query: string) => void  // 點擊「在對話中搜尋」時的 callback
}

const API_BASE = '/api'

// ============================================================
// KnowledgeBase — 右側面板主元件
// ============================================================
export default function KnowledgeBase({ onSearch }: Props) {
  const [articles, setArticles] = useState<Article[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 從後端取得文章清單
  const fetchArticles = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/articles`)
      if (res.ok) {
        const data: Article[] = await res.json()
        setArticles(data)
      } else {
        setError('無法載入文章')
      }
    } catch {
      setError('連線失敗')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 初始掛載時取得文章
  useEffect(() => { fetchArticles() }, [fetchArticles])

  // 客戶端篩選：依標題或標籤過濾
  const filteredArticles = articles.filter(a => {
    if (!filter.trim()) return true
    const keyword = filter.toLowerCase()
    return (
      a.title.toLowerCase().includes(keyword) ||
      a.tags.toLowerCase().includes(keyword)
    )
  })

  // 切換文章展開狀態
  const toggleExpand = (id: number) => {
    setExpanded(prev => prev === id ? null : id)
  }

  // 點擊「在對話中搜尋」：組合搜尋字串並送至聊天
  const handleSearchInChat = (article: Article) => {
    onSearch?.(`搜尋「${article.title}」的相關內容`)
  }

  // 將 tags 字串分割為陣列（過濾空字串）
  const parseTags = (tags: string): string[] =>
    tags.split(',').map(t => t.trim()).filter(Boolean)

  // 格式化日期（只顯示日期部分）
  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleDateString('zh-TW', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      })
    } catch {
      return dateStr
    }
  }

  return (
    <div className="kb-root">
      {/* 標題列 */}
      <div className="kb-header">
        <div className="kb-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
          <span className="kb-title">知識庫</span>
          <span className="kb-count">{articles.length}</span>
        </div>
        <button
          className="kb-refresh-btn"
          onClick={fetchArticles}
          disabled={isLoading}
          title="重新載入"
        >
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
            style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }}
          >
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>

      {/* 篩選輸入框 */}
      <div className="kb-filter-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" width="13" height="13" className="kb-filter-icon">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          className="kb-filter"
          placeholder="篩選標題或標籤..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {filter && (
          <button className="kb-filter-clear" onClick={() => setFilter('')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* 文章列表 */}
      <div className="kb-list">
        {/* 錯誤提示 */}
        {error && (
          <div className="kb-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* 載入中 */}
        {isLoading && articles.length === 0 && (
          <div className="kb-loading">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="20" height="20"
              style={{ animation: 'spin 1s linear infinite' }}>
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            <span>載入中...</span>
          </div>
        )}

        {/* 空白狀態 */}
        {!isLoading && filteredArticles.length === 0 && (
          <div className="kb-empty">
            {filter ? `找不到符合「${filter}」的文章` : '知識庫尚無文章'}
          </div>
        )}

        {/* 文章卡片 */}
        {filteredArticles.map(article => (
          <div key={article.id} className={`kb-card${expanded === article.id ? ' kb-card--expanded' : ''}`}>
            {/* 卡片標題（點擊展開） */}
            <button className="kb-card-header" onClick={() => toggleExpand(article.id)}>
              <div className="kb-card-header-left">
                <span className="kb-card-id">#{article.id}</span>
                <span className="kb-card-title">{article.title}</span>
              </div>
              <svg
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" width="12" height="12"
                style={{
                  transform: expanded === article.id ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.2s',
                  flexShrink: 0,
                  color: 'var(--kb-muted)',
                }}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {/* 標籤列 */}
            {parseTags(article.tags).length > 0 && (
              <div className="kb-tags">
                {parseTags(article.tags).map(tag => (
                  <span key={tag} className="kb-tag">{tag}</span>
                ))}
              </div>
            )}

            {/* 展開內容 */}
            {expanded === article.id && (
              <div className="kb-card-body">
                <p className="kb-snippet">{article.content}</p>
                <div className="kb-card-footer">
                  <span className="kb-date">{formatDate(article.created_at)}</span>
                  <button
                    className="kb-search-btn"
                    onClick={() => handleSearchInChat(article)}
                    title="在聊天中搜尋此文章"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                      strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    在對話中搜尋
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
