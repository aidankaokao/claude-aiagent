/**
 * PlanTimeline.tsx — Plan-Execute 步驟視覺化元件
 *
 * 將 Plan-Execute Agent 的執行步驟以時間軸形式呈現：
 * - pending：待執行（灰色圓點）
 * - running：執行中（旋轉動畫）
 * - done：已完成（金色勾選）
 *
 * Props：
 *   steps — PlanStep 陣列，由 Chat.tsx 根據 SSE 事件維護
 */

import './PlanTimeline.css'

export interface PlanStep {
  text: string
  status: 'pending' | 'running' | 'done'
  result?: string
}

interface PlanTimelineProps {
  steps: PlanStep[]
}

export default function PlanTimeline({ steps }: PlanTimelineProps) {
  if (steps.length === 0) return null

  const doneCount = steps.filter(s => s.status === 'done').length
  const progress = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0

  return (
    <div className="pt-root">
      {/* 標題列 */}
      <div className="pt-header">
        <div className="pt-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
            <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          <span className="pt-header-title">執行計劃</span>
          <span className="pt-step-count">{doneCount} / {steps.length}</span>
        </div>
        <div className="pt-progress-bar">
          <div className="pt-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* 步驟列表 */}
      <ol className="pt-steps">
        {steps.map((step, idx) => (
          <li key={idx} className={`pt-step pt-step--${step.status}`}>
            {/* 狀態圖示 */}
            <div className="pt-step-icon">
              {step.status === 'running' ? (
                <span className="pt-spinner" />
              ) : step.status === 'done' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              ) : (
                <span className="pt-step-dot" />
              )}
            </div>

            {/* 連接線（最後一項不顯示） */}
            {idx < steps.length - 1 && <div className="pt-connector" />}

            {/* 步驟內容 */}
            <div className="pt-step-content">
              <span className="pt-step-text">{step.text}</span>
              {step.result && (
                <p className="pt-step-result">{step.result}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
