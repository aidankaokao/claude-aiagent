/**
 * SkillSelector.tsx — 技能選擇面板
 *
 * 顯示在 Sidebar，列出所有可用技能。
 * 點擊技能 → 強制使用該技能（覆蓋自動偵測）
 * 點擊「自動偵測」或已選技能 → 恢復自動偵測模式
 */

import './SkillSelector.css'

export interface FewShotExampleInfo {
  user_input: string
  expected_output: string
}

export interface SkillParameterInfo {
  name: string
  label: string
  type: 'text' | 'textarea'
  required: boolean
}

export interface SkillInfo {
  name: string
  display_name: string
  description: string
  icon: string
  system_prompt: string
  examples: FewShotExampleInfo[]
  parameters: SkillParameterInfo[]
}

interface Props {
  skills: SkillInfo[]
  selected: string      // '' = 自動偵測
  onSelect: (skillName: string) => void
}

export default function SkillSelector({ skills, selected, onSelect }: Props) {
  const handleClick = (name: string) => {
    // 再次點擊已選的 → 取消選擇（恢復自動）
    onSelect(selected === name ? '' : name)
  }

  return (
    <div className="ss-root">
      <div className="ss-title">選擇技能</div>

      {/* 自動偵測選項 */}
      <button
        className={`ss-item ${!selected ? 'ss-item--selected' : ''}`}
        onClick={() => onSelect('')}
      >
        <span className="ss-icon">✨</span>
        <div className="ss-info">
          <span className="ss-name">自動偵測</span>
          <span className="ss-desc">由 AI 自動判斷意圖</span>
        </div>
        {!selected && (
          <svg className="ss-check" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </button>

      {/* 各技能按鈕 */}
      {skills.map(skill => (
        <button
          key={skill.name}
          className={`ss-item ${selected === skill.name ? 'ss-item--selected' : ''}`}
          onClick={() => handleClick(skill.name)}
        >
          <span className="ss-icon">{skill.icon}</span>
          <div className="ss-info">
            <span className="ss-name">{skill.display_name}</span>
            <span className="ss-desc">{skill.description.slice(0, 30)}…</span>
          </div>
          {selected === skill.name && (
            <svg className="ss-check" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </button>
      ))}
    </div>
  )
}
