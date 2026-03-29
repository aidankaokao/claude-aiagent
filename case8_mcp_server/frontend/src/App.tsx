/**
 * App.tsx — Case 8 頂層元件
 *
 * 版面配置（左→右）：
 *   Sidebar（Chat 內建）+ Chat 主區（flex: 1）+ KnowledgeBase（固定 280px）
 *
 * 互動邏輯：
 * - KnowledgeBase 的「在對話中搜尋」按鈕 → onSearch callback → 設定 chatInput state
 * - Chat 的 externalInput prop 偵測到非空字串 → 填入輸入框 → 呼叫 onExternalInputConsumed 清空
 */

import { useState } from 'react'
import Chat from './Chat'
import KnowledgeBase from './KnowledgeBase'
import './App.css'

export default function App() {
  // 從 KnowledgeBase 傳入 Chat 的外部輸入字串
  const [chatInput, setChatInput] = useState('')

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Chat 元件（含左側 Sidebar） */}
      <Chat
        externalInput={chatInput}
        onExternalInputConsumed={() => setChatInput('')}
      />
      {/* 右側知識庫面板 */}
      <KnowledgeBase onSearch={setChatInput} />
    </div>
  )
}
