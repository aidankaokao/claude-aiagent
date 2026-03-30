/**
 * ModeBadge.tsx — 執行模式標示（Case 10）
 *
 * 顯示 Router 決策的執行模式（chat / tools / research）
 * 嵌在 assistant 訊息泡泡上方，讓使用者了解系統選擇了哪種策略。
 */

import './ModeBadge.css'

interface ModeBadgeProps {
  mode: 'chat' | 'tools' | 'research'
  reason?: string
}

const MODE_META = {
  chat: {
    label: 'Chat',
    desc: '直接對話',
    colorClass: 'mb-chat',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
    ),
  },
  tools: {
    label: 'Tools',
    desc: '工具查詢',
    colorClass: 'mb-tools',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
      </svg>
    ),
  },
  research: {
    label: 'Research',
    desc: '深度研究',
    colorClass: 'mb-research',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    ),
  },
}

export default function ModeBadge({ mode, reason }: ModeBadgeProps) {
  const meta = MODE_META[mode]

  return (
    <div className={`mb-badge ${meta.colorClass}`}>
      <span className="mb-icon">{meta.icon}</span>
      <span className="mb-label">{meta.label}</span>
      <span className="mb-desc">{meta.desc}</span>
      {reason && <span className="mb-reason">{reason}</span>}
    </div>
  )
}
