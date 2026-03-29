/**
 * PromptPlayground.tsx — Prompt 測試場（SKILL.md 版，支援參數表單）
 *
 * 功能：
 * 1. 選擇技能
 * 2. 預覽 SKILL.md 的 system prompt 與 few-shot 範例（唯讀）
 * 3. 若技能有 ## Parameters：顯示動態表單，自動組合 input_text
 *    若無參數：顯示普通 textarea
 * 4. 輸入 / 填表 → SSE 串流輸出
 */

import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SkillInfo } from './SkillSelector'
import { LlmConfig } from './Chat'
import './PromptPlayground.css'

const API_BASE = '/api'

interface Props {
  skills: SkillInfo[]
  llmConfig: LlmConfig
}

/** 將參數表單值組合為結構化 input_text，送給 LLM */
function assembleParamInput(skill: SkillInfo, values: Record<string, string>): string {
  const lines = ['[週報資訊]']
  for (const p of skill.parameters) {
    const val = values[p.name]?.trim() ?? ''
    lines.push(`${p.label}：`)
    if (val) lines.push(val)
  }
  return lines.join('\n')
}

export default function PromptPlayground({ skills, llmConfig }: Props) {
  const [selectedSkill, setSelectedSkill] = useState<string>(skills[0]?.name ?? '')
  const [inputText, setInputText] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [output, setOutput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isDone, setIsDone] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const currentSkill = skills.find(s => s.name === selectedSkill)
  const hasParams = (currentSkill?.parameters?.length ?? 0) > 0

  // 切換技能時重置輸入
  useEffect(() => {
    setInputText('')
    setParamValues({})
    setOutput('')
    setIsDone(false)
  }, [selectedSkill])

  const isRunDisabled = hasParams
    ? !currentSkill?.parameters.filter(p => p.required).every(p => paramValues[p.name]?.trim())
    : !inputText.trim()

  const handleRun = async () => {
    if (isRunDisabled || isLoading) return
    if (!llmConfig.api_key) {
      alert('請先設定 API Key')
      return
    }

    const finalInput = hasParams
      ? assembleParamInput(currentSkill!, paramValues)
      : inputText

    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setOutput('')
    setIsDone(false)
    setIsLoading(true)

    try {
      const res = await fetch(`${API_BASE}/playground/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input_text: finalInput,
          skill_name: selectedSkill,
          llm_config: llmConfig,
        }),
        signal: abortRef.current.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('無法讀取串流')

      const decoder = new TextDecoder()
      let buffer = ''
      let eventType = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim())
              if (eventType === 'token') {
                setOutput(prev => prev + (data.content as string))
              } else if (eventType === 'done') {
                setIsDone(true)
              } else if (eventType === 'error') {
                setOutput(`⚠️ 錯誤：${data.message as string}`)
                setIsDone(true)
              }
            } catch { /* ignore */ }
            eventType = 'message'
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setOutput(`⚠️ ${(err as Error).message}`)
        setIsDone(true)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    setIsLoading(false)
  }

  return (
    <div className="pg-root">
      {/* ── 左側控制面板 ── */}
      <div className="pg-controls">

        {/* 技能選擇 */}
        <div className="pg-section-title">選擇技能</div>
        <div className="pg-skill-list">
          {skills.map(skill => (
            <button
              key={skill.name}
              className={`pg-skill-btn ${selectedSkill === skill.name ? 'pg-skill-btn--active' : ''}`}
              onClick={() => setSelectedSkill(skill.name)}
            >
              <span>{skill.icon}</span>
              <span>{skill.display_name}</span>
              {skill.parameters.length > 0 && (
                <span className="pg-skill-badge">表單</span>
              )}
            </button>
          ))}
        </div>

        {/* System Prompt 預覽（唯讀） */}
        {currentSkill && (
          <>
            <div className="pg-section-title" style={{ marginTop: 16 }}>
              System Prompt
              <button
                className="pg-prompt-toggle"
                onClick={() => setShowPrompt(s => !s)}
              >
                {showPrompt ? '收合' : '展開'}
              </button>
            </div>

            {showPrompt && (
              <div className="pg-prompt-preview">
                <pre className="pg-prompt-text">{currentSkill.system_prompt}</pre>

                {currentSkill.examples.length > 0 && (
                  <>
                    <div className="pg-prompt-subtitle">
                      Few-shot 範例（{currentSkill.examples.length} 個）
                    </div>
                    {currentSkill.examples.map((ex, i) => (
                      <div key={i} className="pg-example">
                        <div className="pg-example-role">User</div>
                        <div className="pg-example-content">{ex.user_input.slice(0, 80)}{ex.user_input.length > 80 ? '…' : ''}</div>
                        <div className="pg-example-role pg-example-role--assistant">Assistant</div>
                        <div className="pg-example-content">{ex.expected_output.slice(0, 80)}{ex.expected_output.length > 80 ? '…' : ''}</div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* ── 測試輸入：參數表單 or 普通 textarea ── */}
        <div className="pg-section-title" style={{ marginTop: 16 }}>
          {hasParams ? '填寫參數' : '測試輸入'}
        </div>

        {hasParams ? (
          /* 參數表單 */
          <div className="pg-param-form">
            {currentSkill!.parameters.map(param => (
              <div key={param.name} className="pg-param-field">
                <label className="pg-param-label">
                  {param.label}
                  {param.required && <span className="pg-param-required">*</span>}
                </label>
                {param.type === 'textarea' ? (
                  <textarea
                    className="pg-param-textarea"
                    value={paramValues[param.name] ?? ''}
                    onChange={e => setParamValues(prev => ({ ...prev, [param.name]: e.target.value }))}
                    placeholder={`輸入${param.label}…`}
                    rows={3}
                  />
                ) : (
                  <input
                    type="text"
                    className="pg-param-input"
                    value={paramValues[param.name] ?? ''}
                    onChange={e => setParamValues(prev => ({ ...prev, [param.name]: e.target.value }))}
                    placeholder={`輸入${param.label}…`}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          /* 普通 textarea */
          <textarea
            className="pg-input"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="輸入測試文字…"
            rows={5}
          />
        )}

        <div className="pg-actions">
          {isLoading ? (
            <button className="pg-stop-btn" onClick={handleStop}>停止</button>
          ) : (
            <button className="pg-run-btn" onClick={handleRun} disabled={isRunDisabled}>
              執行
            </button>
          )}
        </div>
      </div>

      {/* ── 右側輸出區 ── */}
      <div className="pg-output-area">
        {!output && !isLoading && (
          <div className="pg-empty">
            <div className="pg-empty-icon">🧪</div>
            <div className="pg-empty-text">
              {hasParams
                ? '填寫左側參數後點擊執行'
                : '選擇技能，輸入測試文字後點擊執行'}
            </div>
          </div>
        )}

        {(output || isLoading) && (
          <div className="pg-result">
            <div className="pg-result-header">
              <span className="pg-result-skill">
                {currentSkill?.icon} {currentSkill?.display_name}
              </span>
              {isLoading && <span className="pg-result-spinner" />}
              {isDone && <span className="pg-result-done">✓ 完成</span>}
            </div>
            <div className="pg-result-body">
              {output ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
              ) : (
                <span className="pg-typing">▋</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
