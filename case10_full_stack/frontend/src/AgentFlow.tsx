/**
 * AgentFlow.tsx — Research Agent Pipeline 視覺化（Case 10）
 *
 * 簡化版（相較 Case 9）：只有 researcher 和 writer 兩個步驟。
 * 設計完全相同：可展開摘要、即時計時、spinner/checkmark 狀態圖示。
 */

import { useState, useEffect } from 'react'
import './AgentFlow.css'

export interface AgentStep {
  id: string
  agent: 'researcher' | 'writer'
  status: 'running' | 'done'
  summary?: string
  startTime: number
  endTime?: number
}

const AGENT_META: Record<string, { label: string; colorClass: string }> = {
  researcher: { label: 'Researcher', colorClass: 'af-researcher' },
  writer:     { label: 'Writer',     colorClass: 'af-writer' },
}

// ── Agent 圖示 ──────────────────────────────────────────────

function AgentIcon({ agent }: { agent: string }) {
  if (agent === 'researcher') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  )
}

// ── 計時 hook ───────────────────────────────────────────────

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

// ── 單一步驟 ────────────────────────────────────────────────

function AgentStepRow({ step }: { step: AgentStep }) {
  const [expanded, setExpanded] = useState(false)
  const meta = AGENT_META[step.agent] ?? { label: step.agent, colorClass: '' }
  const isRunning = step.status === 'running'
  const elapsed = useElapsed(step.startTime, step.endTime, isRunning)
  const hasSummary = !!(step.summary && step.status === 'done')

  return (
    <div className={`af-step ${meta.colorClass} ${isRunning ? 'af-step--running' : 'af-step--done'}`}>
      <div
        className={`af-step-row${hasSummary ? ' af-step-row--clickable' : ''}`}
        onClick={() => hasSummary && setExpanded(e => !e)}
      >
        <div className="af-step-left">
          <div className="af-status-icon">
            {isRunning
              ? <span className="af-spinner" />
              : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )
            }
          </div>
          <span className="af-agent-icon"><AgentIcon agent={step.agent} /></span>
          <span className="af-agent-label">{meta.label}</span>
        </div>

        <div className="af-step-right">
          <span className={`af-timer${isRunning ? ' af-timer--running' : ''}`}>{elapsed}</span>
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

      {hasSummary && expanded && (
        <div className="af-step-body">
          <p className="af-summary">{step.summary}{(step.summary?.length ?? 0) >= 300 ? '...' : ''}</p>
        </div>
      )}
    </div>
  )
}

// ── 主元件 ──────────────────────────────────────────────────

export default function AgentFlow({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) return null

  const hasRunning = steps.some(s => s.status === 'running')

  return (
    <div className="af-pipeline">
      <div className="af-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <span>Research Pipeline</span>
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
