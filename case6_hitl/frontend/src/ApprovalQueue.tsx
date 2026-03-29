/**
 * ApprovalQueue.tsx — 訂單審批元件
 *
 * 當 Agent 遇到超過門檻的訂單時，在聊天訊息流中插入此審批卡片。
 * 使用者可直接在對話中核准、拒絕或修改訂單，
 * 決定後 Agent 恢復執行並串流最終回覆。
 */

import { useState } from 'react'
import './ApprovalQueue.css'

export interface OrderItem {
  product_id: string
  name: string
  quantity: number
  unit_price: number
  subtotal?: number
}

export interface PriceDetails {
  items: OrderItem[]
  subtotal: number
  discount_rate: number
  discount: number
  total: number
}

export interface ApprovalData {
  thread_id: string
  parsed_items: OrderItem[]
  price_details: PriceDetails
  threshold: number
}

interface Props {
  data: ApprovalData
  status: 'pending' | 'approved' | 'rejected' | 'processing'
  onDecide: (action: 'approved' | 'rejected', items?: OrderItem[]) => void
}

export default function ApprovalQueue({ data, status, onDecide }: Props) {
  const [editing, setEditing] = useState(false)
  const [editItems, setEditItems] = useState<OrderItem[]>(
    data.price_details.items.map(i => ({ ...i }))
  )

  // 計算修改後的小計
  const editedSubtotal = editItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0)
  const editedDiscountRate = editedSubtotal >= 5000 ? 0.90 : editedSubtotal >= 1000 ? 0.95 : 1.0
  const editedDiscount = editedSubtotal * (1 - editedDiscountRate)
  const editedTotal = editedSubtotal - editedDiscount

  const handleQtyChange = (idx: number, qty: number) => {
    if (qty < 1) return
    setEditItems(prev => prev.map((item, i) => i === idx ? { ...item, quantity: qty } : item))
  }

  const handleApprove = () => {
    if (editing) {
      // 送出修改後的品項
      onDecide('approved', editItems.map(i => ({ ...i, subtotal: i.unit_price * i.quantity })))
    } else {
      onDecide('approved')
    }
  }

  const isPending = status === 'pending'
  const isProcessing = status === 'processing'

  return (
    <div className={`aq-root aq-root--${status}`}>
      {/* 標題列 */}
      <div className="aq-header">
        <div className="aq-header-left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          <span className="aq-title">訂單審批請求</span>
        </div>
        <div className="aq-header-right">
          {isPending && (
            <span className="aq-badge aq-badge--pending">
              <span className="aq-dot aq-dot--pulse" />
              等待審核
            </span>
          )}
          {isProcessing && (
            <span className="aq-badge aq-badge--processing">
              <span className="aq-spinner-sm" />
              處理中
            </span>
          )}
          {status === 'approved' && (
            <span className="aq-badge aq-badge--approved">✓ 已核准</span>
          )}
          {status === 'rejected' && (
            <span className="aq-badge aq-badge--rejected">✕ 已拒絕</span>
          )}
        </div>
      </div>

      {/* 門檻提示 */}
      <div className="aq-threshold-note">
        訂單金額 <strong>NT${data.price_details.total.toLocaleString()}</strong> 超過審批門檻
        NT${data.threshold.toLocaleString()}，需人工確認後才能建立。
      </div>

      {/* 品項表格 */}
      <div className="aq-table-wrap">
        <table className="aq-table">
          <thead>
            <tr>
              <th>商品</th>
              <th className="aq-th-right">單價</th>
              <th className="aq-th-center">數量</th>
              <th className="aq-th-right">小計</th>
            </tr>
          </thead>
          <tbody>
            {(editing ? editItems : data.price_details.items).map((item, idx) => (
              <tr key={item.product_id}>
                <td>{item.name}</td>
                <td className="aq-td-right aq-mono">NT${item.unit_price.toLocaleString()}</td>
                <td className="aq-td-center">
                  {editing ? (
                    <input
                      type="number"
                      min={1}
                      value={editItems[idx].quantity}
                      onChange={e => handleQtyChange(idx, parseInt(e.target.value) || 1)}
                      className="aq-qty-input"
                    />
                  ) : (
                    <span className="aq-mono">{item.quantity}</span>
                  )}
                </td>
                <td className="aq-td-right aq-mono">
                  NT${(editing
                    ? editItems[idx].unit_price * editItems[idx].quantity
                    : (item.subtotal ?? item.unit_price * item.quantity)
                  ).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 金額摘要 */}
      <div className="aq-price-summary">
        {editing ? (
          <>
            <div className="aq-price-row">
              <span>小計</span>
              <span className="aq-mono">NT${editedSubtotal.toFixed(0)}</span>
            </div>
            {editedDiscount > 0 && (
              <div className="aq-price-row aq-price-row--discount">
                <span>折扣（{Math.round((1 - editedDiscountRate) * 100)}%）</span>
                <span className="aq-mono">- NT${editedDiscount.toFixed(0)}</span>
              </div>
            )}
            <div className="aq-price-row aq-price-row--total">
              <span>應付總額</span>
              <span className="aq-mono">NT${editedTotal.toFixed(0)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="aq-price-row">
              <span>小計</span>
              <span className="aq-mono">NT${data.price_details.subtotal.toFixed(0)}</span>
            </div>
            {data.price_details.discount > 0 && (
              <div className="aq-price-row aq-price-row--discount">
                <span>折扣（{Math.round((1 - data.price_details.discount_rate) * 100)}%）</span>
                <span className="aq-mono">- NT${data.price_details.discount.toFixed(0)}</span>
              </div>
            )}
            <div className="aq-price-row aq-price-row--total">
              <span>應付總額</span>
              <span className="aq-mono">NT${data.price_details.total.toFixed(0)}</span>
            </div>
          </>
        )}
      </div>

      {/* 操作按鈕（僅 pending 狀態顯示） */}
      {isPending && (
        <div className="aq-actions">
          <button
            className="aq-btn aq-btn--edit"
            onClick={() => setEditing(e => !e)}
          >
            {editing ? '取消修改' : '修改數量'}
          </button>
          <button
            className="aq-btn aq-btn--reject"
            onClick={() => onDecide('rejected')}
          >
            拒絕
          </button>
          <button
            className="aq-btn aq-btn--approve"
            onClick={handleApprove}
          >
            {editing ? '修改並核准' : '核准'}
          </button>
        </div>
      )}
    </div>
  )
}
