/**
 * SqlViewer.tsx — SQL 查詢視覺化元件（Case 11）
 *
 * 功能：
 * - 顯示 Agent 生成並執行的 SQL
 * - 可展開/收合
 * - 顯示查詢類型（即時/歷史）和嘗試次數（重試時）
 */

import { useState } from 'react'
import './SqlViewer.css'

export interface SqlInfo {
  sql: string
  queryType: string  // "realtime" | "historical" | ""
  attempt: number
}

const QUERY_TYPE_LABEL: Record<string, string> = {
  realtime:   '即時查詢',
  historical: '歷史分析',
}

export default function SqlViewer({ sqlInfo }: { sqlInfo: SqlInfo }) {
  const [expanded, setExpanded] = useState(false)

  if (!sqlInfo.sql) return null

  const typeLabel = QUERY_TYPE_LABEL[sqlInfo.queryType] ?? sqlInfo.queryType

  return (
    <div className="sv-panel">
      <button className="sv-header" onClick={() => setExpanded(e => !e)}>
        <div className="sv-header-left">
          {/* SQL 圖示 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="13" height="13"
            className="sv-icon">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          <span className="sv-title">生成的 SQL</span>
          {typeLabel && (
            <span className={`sv-type-badge sv-type-${sqlInfo.queryType}`}>
              {typeLabel}
            </span>
          )}
          {sqlInfo.attempt > 1 && (
            <span className="sv-retry-badge">重試 #{sqlInfo.attempt}</span>
          )}
        </div>
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" width="12" height="12"
          className={`sv-chevron${expanded ? ' sv-chevron--open' : ''}`}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {expanded && (
        <div className="sv-body">
          <pre className="sv-code">{sqlInfo.sql}</pre>
        </div>
      )}
    </div>
  )
}
