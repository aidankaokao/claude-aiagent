/**
 * ProductSelector.tsx — 商品選擇元件
 *
 * 當 parse_order_node 無法精確比對商品時，在聊天流中插入此卡片。
 * 使用者從每個未解析品項的候選清單中點選對應商品，
 * 確認後 Agent 恢復執行（若金額超過門檻，接著觸發 ApprovalQueue）。
 */

import { useState } from 'react'
import './ProductSelector.css'

export interface Candidate {
  id: string
  name: string
  category: string
  price: number
}

export interface UnresolvedItem {
  user_query: string
  quantity: number
  candidates: Candidate[]
}

export interface SelectionData {
  thread_id: string
  unresolved_items: UnresolvedItem[]
}

export interface ResolvedItem {
  product_id: string
  name: string
  quantity: number
  unit_price: number
}

interface Props {
  data: SelectionData
  status: 'pending' | 'processing' | 'resolved'
  onSelect: (resolvedItems: ResolvedItem[]) => void
}

export default function ProductSelector({ data, status, onSelect }: Props) {
  // selections[itemIdx] = { candidate, quantity }
  const [selections, setSelections] = useState<
    Record<number, { candidate: Candidate; quantity: number }>
  >({})

  const handlePick = (itemIdx: number, candidate: Candidate) => {
    setSelections(prev => ({
      ...prev,
      [itemIdx]: {
        candidate,
        quantity: prev[itemIdx]?.quantity ?? data.unresolved_items[itemIdx].quantity,
      },
    }))
  }

  const handleQtyChange = (itemIdx: number, qty: number) => {
    if (qty < 1) return
    setSelections(prev => ({
      ...prev,
      [itemIdx]: { ...prev[itemIdx], quantity: qty },
    }))
  }

  const allSelected = data.unresolved_items.every((_, i) => selections[i]?.candidate)

  const handleConfirm = () => {
    const resolved: ResolvedItem[] = data.unresolved_items.map((_, i) => ({
      product_id: selections[i].candidate.id,
      name: selections[i].candidate.name,
      quantity: selections[i].quantity,
      unit_price: selections[i].candidate.price,
    }))
    onSelect(resolved)
  }

  const isPending = status === 'pending'
  const isProcessing = status === 'processing'

  return (
    <div className={`ps-root ps-root--${status}`}>
      {/* 標題列 */}
      <div className="ps-header">
        <div className="ps-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span className="ps-title">請協助確認商品</span>
        </div>
        <div className="ps-header-right">
          {isPending && (
            <span className="ps-badge ps-badge--pending">
              <span className="ps-dot ps-dot--pulse" />
              等待選擇
            </span>
          )}
          {isProcessing && (
            <span className="ps-badge ps-badge--processing">
              <span className="ps-spinner-sm" />
              處理中
            </span>
          )}
          {status === 'resolved' && (
            <span className="ps-badge ps-badge--resolved">✓ 已確認</span>
          )}
        </div>
      </div>

      {/* 說明文字 */}
      <div className="ps-desc">
        以下商品無法精確比對，請從候選清單中選擇您想訂購的商品：
      </div>

      {/* 逐一顯示未解析品項 */}
      {data.unresolved_items.map((item, itemIdx) => (
        <div key={itemIdx} className="ps-item">
          <div className="ps-item-query">
            您輸入：<strong>「{item.user_query}」</strong>
            {isPending ? (
              <span className="ps-qty-inline">
                數量：
                <input
                  type="number"
                  min={1}
                  value={selections[itemIdx]?.quantity ?? item.quantity}
                  onChange={e => handleQtyChange(itemIdx, parseInt(e.target.value) || 1)}
                  className="ps-qty-input"
                />
              </span>
            ) : (
              selections[itemIdx] && (
                <span className="ps-qty-inline">
                  × {selections[itemIdx].quantity}
                </span>
              )
            )}
          </div>

          <div className="ps-candidates">
            {item.candidates.map(c => {
              const isSelected = selections[itemIdx]?.candidate.id === c.id
              return (
                <button
                  key={c.id}
                  className={`ps-candidate${isSelected ? ' ps-candidate--selected' : ''}`}
                  onClick={() => isPending && handlePick(itemIdx, c)}
                  disabled={!isPending}
                >
                  <div className="ps-candidate-name">{c.name}</div>
                  <div className="ps-candidate-meta">
                    <span className="ps-candidate-category">{c.category}</span>
                    <span className="ps-candidate-price">NT${c.price.toLocaleString()}</span>
                  </div>
                  {isSelected && (
                    <svg className="ps-check" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {/* 確認按鈕（僅 pending 狀態顯示） */}
      {isPending && (
        <div className="ps-actions">
          <button
            className="ps-btn ps-btn--confirm"
            onClick={handleConfirm}
            disabled={!allSelected}
          >
            確認選擇
          </button>
        </div>
      )}
    </div>
  )
}
