/**
 * ToolCallPanel.tsx — 工具呼叫視覺化（Case 10）
 *
 * 設計同 Case 3：每個工具呼叫顯示名稱 + 輸入預覽，可點擊展開完整 I/O。
 * 執行中顯示 spinner，完成後顯示 ✓。
 */

import { useState } from 'react'
import './ToolCallPanel.css'

export interface ToolCall {
  run_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_output?: string
  status: 'running' | 'done'
}

// 工具名稱中文對應
const TOOL_LABELS: Record<string, string> = {
  calculate:       '數學計算',
  get_datetime:    '查詢時間',
  query_knowledge: '知識查詢',
}

export default function ToolCallPanel({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (toolCalls.length === 0) return null

  const toggle = (run_id: string) =>
    setExpanded(prev => ({ ...prev, [run_id]: !prev[run_id] }))

  return (
    <div className="tcp-panel">
      {toolCalls.map(tc => (
        <div key={tc.run_id} className={`tcp-item tcp-item--${tc.status}`}>
          {/* 工具標題列（可點擊展開） */}
          <button className="tcp-header" onClick={() => toggle(tc.run_id)}>
            <div className="tcp-header-left">
              {tc.status === 'running'
                ? <span className="tcp-spinner" />
                : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                    strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )
              }
              <span className="tcp-name">
                {TOOL_LABELS[tc.tool_name] ?? tc.tool_name}
              </span>
              <span className="tcp-fn-name">{tc.tool_name}</span>
              {/* 第一個輸入參數預覽 */}
              {Object.values(tc.tool_input)[0] != null && (
                <span className="tcp-preview">
                  {String(Object.values(tc.tool_input)[0]).slice(0, 40)}
                </span>
              )}
            </div>
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="12" height="12"
              style={{
                transform: expanded[tc.run_id] ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
                flexShrink: 0,
                color: 'var(--muted)',
              }}
            >
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {/* 展開：完整輸入 + 輸出 */}
          {expanded[tc.run_id] && (
            <div className="tcp-detail">
              <div className="tcp-section-label">輸入</div>
              <pre className="tcp-code">{JSON.stringify(tc.tool_input, null, 2)}</pre>
              {tc.tool_output !== undefined && (
                <>
                  <div className="tcp-section-label">輸出</div>
                  <pre className="tcp-code">{tc.tool_output}</pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
