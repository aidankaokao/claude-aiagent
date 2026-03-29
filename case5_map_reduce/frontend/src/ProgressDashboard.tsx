/**
 * ProgressDashboard.tsx — 文件並行分析進度面板
 *
 * 顯示所有文件的分析狀態：
 *   pending   → 灰色，等待分析
 *   analyzing → 藍色 + 旋轉動畫，正在分析
 *   done      → 依情感（positive/neutral/negative）顯示顏色 + 摘要
 *   error     → 紅色，分析失敗
 */

import './ProgressDashboard.css'

export interface DocAnalysis {
  id: string
  title: string
  category: string
  status: 'pending' | 'analyzing' | 'done' | 'error'
  summary?: string
  sentiment?: 'positive' | 'neutral' | 'negative'
}

interface Props {
  docs: DocAnalysis[]
  reducing?: boolean   // true = reduce_node 正在整合
}

const SENTIMENT_LABEL: Record<string, string> = {
  positive: '正面',
  neutral: '中性',
  negative: '負面',
}

const CATEGORY_COLOR: Record<string, string> = {
  科技: '#3b82f6',
  食品飲料: '#10b981',
  再生能源: '#f59e0b',
  金融: '#8b5cf6',
  軟體服務: '#06b6d4',
  製藥: '#ec4899',
  物流: '#64748b',
  教育科技: '#f97316',
  零售: '#a855f7',
  公用事業: '#14b8a6',
}

export default function ProgressDashboard({ docs, reducing = false }: Props) {
  const total = docs.length
  const done = docs.filter(d => d.status === 'done' || d.status === 'error').length
  const analyzing = docs.filter(d => d.status === 'analyzing').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="pd-root">
      {/* 進度標題列 */}
      <div className="pd-header">
        <div className="pd-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          <span className="pd-title">並行文件分析</span>
        </div>
        <div className="pd-header-right">
          {analyzing > 0 && (
            <span className="pd-analyzing-badge">
              <span className="pd-spinner-sm" />
              {analyzing} 份分析中
            </span>
          )}
          {reducing && (
            <span className="pd-reducing-badge">
              <span className="pd-spinner-sm" />
              整合報告中
            </span>
          )}
          <span className="pd-count">{done} / {total}</span>
        </div>
      </div>

      {/* 進度條 */}
      <div className="pd-progress-track">
        <div
          className="pd-progress-fill"
          style={{ width: `${pct}%`, transition: 'width 0.4s ease' }}
        />
      </div>

      {/* 文件卡片網格 */}
      <div className="pd-grid">
        {docs.map(doc => (
          <div
            key={doc.id}
            className={`pd-card pd-card--${doc.status}${doc.sentiment ? ` pd-card--${doc.sentiment}` : ''}`}
          >
            <div className="pd-card-top">
              {/* 狀態指示器 */}
              <div className="pd-status-icon">
                {doc.status === 'pending' && (
                  <span className="pd-dot pd-dot--pending" />
                )}
                {doc.status === 'analyzing' && (
                  <span className="pd-spinner-card" />
                )}
                {doc.status === 'done' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    className={`pd-check pd-check--${doc.sentiment ?? 'neutral'}`}>
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
                {doc.status === 'error' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
                    className="pd-error-icon">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                )}
              </div>

              {/* 標題 */}
              <div className="pd-card-title">{doc.title}</div>
            </div>

            {/* 類別 + 情感 */}
            <div className="pd-card-meta">
              <span
                className="pd-category-badge"
                style={{ borderColor: CATEGORY_COLOR[doc.category] ?? '#64748b',
                         color: CATEGORY_COLOR[doc.category] ?? '#64748b' }}
              >
                {doc.category}
              </span>
              {doc.status === 'done' && doc.sentiment && (
                <span className={`pd-sentiment-badge pd-sentiment--${doc.sentiment}`}>
                  {SENTIMENT_LABEL[doc.sentiment]}
                </span>
              )}
              {doc.status === 'analyzing' && (
                <span className="pd-status-text pd-status-text--analyzing">分析中</span>
              )}
              {doc.status === 'pending' && (
                <span className="pd-status-text pd-status-text--pending">待分析</span>
              )}
            </div>

            {/* 分析摘要（完成後顯示） */}
            {doc.status === 'done' && doc.summary && !doc.summary.startsWith('分析失敗') && (
              <div className="pd-summary">{doc.summary}</div>
            )}
            {doc.status === 'error' && doc.summary && (
              <div className="pd-error-msg">{doc.summary}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
