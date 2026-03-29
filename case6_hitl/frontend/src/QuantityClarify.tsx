/**
 * QuantityClarify.tsx — 數量確認元件
 *
 * 當 ask_quantity_node 偵測到使用者未指定數量時，在聊天流中插入此卡片。
 * 使用者為每個品項填入數量後確認，Agent 恢復執行。
 */

import { useState } from 'react'
import './QuantityClarify.css'

export interface QuantifyItem {
  product_name: string
}

export interface QuantifyClarifyData {
  thread_id: string
  items: QuantifyItem[]
}

export interface QuantityResolved {
  product_name: string
  quantity: number
}

interface Props {
  data: QuantifyClarifyData
  status: 'pending' | 'processing' | 'resolved'
  onConfirm: (quantities: QuantityResolved[]) => void
}

export default function QuantityClarify({ data, status, onConfirm }: Props) {
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(data.items.map((_, i) => [i, 1]))
  )

  const handleQtyChange = (idx: number, qty: number) => {
    if (qty < 1) return
    setQuantities(prev => ({ ...prev, [idx]: qty }))
  }

  const handleConfirm = () => {
    const resolved: QuantityResolved[] = data.items.map((item, i) => ({
      product_name: item.product_name,
      quantity: quantities[i] ?? 1,
    }))
    onConfirm(resolved)
  }

  const isPending = status === 'pending'
  const isProcessing = status === 'processing'

  return (
    <div className={`qc-root qc-root--${status}`}>
      {/* 標題列 */}
      <div className="qc-header">
        <div className="qc-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
            <line x1="12" y1="12" x2="12" y2="16"/>
            <line x1="10" y1="14" x2="14" y2="14"/>
          </svg>
          <span className="qc-title">請確認訂購數量</span>
        </div>
        <div className="qc-header-right">
          {isPending && (
            <span className="qc-badge qc-badge--pending">
              <span className="qc-dot qc-dot--pulse" />
              等待輸入
            </span>
          )}
          {isProcessing && (
            <span className="qc-badge qc-badge--processing">
              <span className="qc-spinner-sm" />
              處理中
            </span>
          )}
          {status === 'resolved' && (
            <span className="qc-badge qc-badge--resolved">✓ 已確認</span>
          )}
        </div>
      </div>

      {/* 說明文字 */}
      <div className="qc-desc">
        您的訂單中以下商品未指定數量，請填入所需數量：
      </div>

      {/* 品項列表 */}
      {data.items.map((item, idx) => (
        <div key={idx} className="qc-item">
          <div className="qc-item-name">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" width="13" height="13"
              className="qc-item-icon">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            <span>{item.product_name}</span>
          </div>
          <div className="qc-qty-row">
            <span className="qc-qty-label">數量：</span>
            {isPending ? (
              <input
                type="number"
                min={1}
                value={quantities[idx] ?? 1}
                onChange={e => handleQtyChange(idx, parseInt(e.target.value) || 1)}
                className="qc-qty-input"
              />
            ) : (
              <span className="qc-qty-value">{quantities[idx] ?? 1}</span>
            )}
            <span className="qc-qty-unit">件</span>
          </div>
        </div>
      ))}

      {/* 確認按鈕（僅 pending 狀態顯示） */}
      {isPending && (
        <div className="qc-actions">
          <button className="qc-btn qc-btn--confirm" onClick={handleConfirm}>
            確認數量
          </button>
        </div>
      )}
    </div>
  )
}
