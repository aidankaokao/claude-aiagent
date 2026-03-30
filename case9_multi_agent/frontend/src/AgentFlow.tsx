/**
 * AgentFlow.tsx — Agent Pipeline 內嵌視覺化（Case 9）
 *
 * 設計：每個 assistant 回答框上方顯示完整的執行流程
 * - 每個步驟可摺疊（點擊展開輸出摘要）
 * - 執行中的步驟顯示即時計時（每 100ms 更新）
 * - 完成的步驟顯示總耗時
 * - Supervisor 步驟顯示路由決策（→ researcher / → analyst / → writer）
 */

import { useState, useEffect } from 'react'
import './AgentFlow.css'

// ── 型別 ──────────────────────────────────────────────────────

export interface AgentStep {
  id: string
  agent: 'supervisor' | 'researcher' | 'analyst' | 'writer'
  status: 'running' | 'done'
  summary?: string
  startTime: number    // performance.now() when agent_start received
  endTime?: number     // performance.now() when agent_end received
}

// ── Agent 顯示設定 ────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; colorClass: string }> = {
  supervisor: { label: 'Supervisor', colorClass: 'af-supervisor' },
  researcher: { label: 'Researcher', colorClass: 'af-researcher' },
  analyst:    { label: 'Analyst',    colorClass: 'af-analyst' },
  writer:     { label: 'Writer',     colorClass: 'af-writer' },
}

// ── Icons ─────────────────────────────────────────────────────

function AgentIcon({ agent }: { agent: string }) {
  if (agent === 'supervisor') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
    </svg>
  )
  if (agent === 'researcher') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
  if (agent === 'analyst') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  )
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  )
}

// ── 計時 hook ─────────────────────────────────────────────────

function useElapsed(startTime: number, endTime: number | undefined, active: boolean): string {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(t => t + 1), 100)
    return () => clearInterval(id)
  }, [active])

  if (endTime !== undefined) {
    return ((endTime - startTime) / 1000).toFixed(1) + 's'
  }
  return ((performance.now() - startTime) / 1000).toFixed(1) + 's'
}

// ── 單一步驟 ──────────────────────────────────────────────────

function AgentStepRow({ step }: { step: AgentStep }) {
  const [expanded, setExpanded] = useState(false)
  const meta = AGENT_META[step.agent] ?? { label: step.agent, colorClass: '' }
  const isRunning = step.status === 'running'
  const elapsed = useElapsed(step.startTime, step.endTime, isRunning)
  const hasSummary = !!(step.summary && step.status === 'done')

  return (
    <div className={`af-step ${meta.colorClass} ${isRunning ? 'af-step--running' : 'af-step--done'}`}>
      {/* 主行：可點擊切換展開 */}
      <div
        className={`af-step-row${hasSummary ? ' af-step-row--clickable' : ''}`}
        onClick={() => hasSummary && setExpanded(e => !e)}
      >
        <div className="af-step-left">
          {/* 狀態圖示 */}
          <div className="af-status-icon">
            {isRunning
              ? <span className="af-spinner" />
              : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )
            }
          </div>
          {/* Agent 圖示 + 名稱 */}
          <span className="af-agent-icon"><AgentIcon agent={step.agent} /></span>
          <span className="af-agent-label">{meta.label}</span>
        </div>

        <div className="af-step-right">
          {/* 計時器 */}
          <span className={`af-timer${isRunning ? ' af-timer--running' : ''}`}>{elapsed}</span>
          {/* 展開箭頭（有 summary 才顯示） */}
          {hasSummary && (
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="12" height="12"
              className={`af-chevron${expanded ? ' af-chevron--open' : ''}`}
            >
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          )}
        </div>
      </div>

      {/* 摺疊內容：summary */}
      {hasSummary && expanded && (
        <div className="af-step-body">
          <p className="af-summary">{step.summary}{(step.summary?.length ?? 0) >= 300 ? '...' : ''}</p>
        </div>
      )}
    </div>
  )
}

// ── 主元件 ────────────────────────────────────────────────────

interface AgentFlowProps {
  steps: AgentStep[]
}

export default function AgentFlow({ steps }: AgentFlowProps) {
  if (steps.length === 0) return null

  const hasRunning = steps.some(s => s.status === 'running')

  return (
    <div className="af-pipeline">
      <div className="af-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <span>Agent Pipeline</span>
        {hasRunning && <span className="af-title-running">執行中</span>}
      </div>

      <div className="af-steps">
        {steps.map(step => (
          <AgentStepRow key={step.id} step={step} />
        ))}
      </div>
    </div>
  )
}
