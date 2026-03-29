/**
 * InventoryTable.tsx — 即時庫存資料表元件
 *
 * 功能：
 * - 呼叫 GET /api/inventory 取得所有產品庫存
 * - 依庫存狀態顯示顏色標示（低庫存/正常/充足）
 * - 支援關鍵字搜尋與分類篩選（純前端過濾）
 * - 當父元件的 refreshTrigger 改變時自動重新拉取資料
 *   （update_stock 工具執行完成後觸發）
 */

import { useState, useEffect, useCallback } from 'react'
import './InventoryTable.css'

// 後端 GET /api/inventory 回傳的單一產品格式
interface Product {
  id: number
  name: string
  category: string
  quantity: number
  min_stock: number
  unit_price: number
  status: 'low' | 'normal' | 'high'  // 由後端計算
}

interface Props {
  // 父元件（Chat）每次 update_stock 工具完成時遞增此值，觸發重新載入
  refreshTrigger: number
}

const API_BASE = '/api'

// 庫存狀態對應的中文標籤與 CSS class
const STATUS_CONFIG = {
  low:    { label: '庫存不足', cls: 'inv-status--low' },
  normal: { label: '正常',     cls: 'inv-status--normal' },
  high:   { label: '充足',     cls: 'inv-status--high' },
}

// 所有分類選項（與後端 seed_data 一致）
const CATEGORIES = ['全部', '電子產品', '文具', '食品', '服飾', '家居']

export default function InventoryTable({ refreshTrigger }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 前端篩選條件（不發 API，直接在 products 陣列上過濾）
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState('全部')

  // 向後端拉取最新庫存資料
  const fetchInventory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/inventory`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setProducts(await res.json())
    } catch (e) {
      setError('無法載入庫存資料')
    } finally {
      setLoading(false)
    }
  }, [])

  // 初始載入 + 每次 refreshTrigger 變動時重新載入
  useEffect(() => {
    fetchInventory()
  }, [fetchInventory, refreshTrigger])

  // 前端過濾：同時套用關鍵字與分類篩選
  const filtered = products.filter(p => {
    const matchKeyword = keyword === '' || p.name.includes(keyword)
    const matchCategory = category === '全部' || p.category === category
    return matchKeyword && matchCategory
  })

  // 統計低庫存產品數量，顯示在標題旁
  const lowCount = products.filter(p => p.status === 'low').length

  return (
    <div className="inv-panel">
      {/* 標題列：含低庫存警示數量與手動刷新按鈕 */}
      <div className="inv-header">
        <div className="inv-header-left">
          <span className="inv-title">庫存總覽</span>
          {lowCount > 0 && (
            <span className="inv-low-badge">{lowCount} 項不足</span>
          )}
        </div>
        <button className="inv-refresh-btn" onClick={fetchInventory} disabled={loading}>
          {/* 刷新圖示 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
            style={{ animation: loading ? 'inv-spin 1s linear infinite' : 'none' }}>
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>

      {/* 篩選列：關鍵字搜尋 + 分類下拉選單 */}
      <div className="inv-filters">
        <input
          className="inv-search"
          type="text"
          placeholder="搜尋產品名稱..."
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
        />
        <select
          className="inv-select"
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* 庫存資料表 */}
      <div className="inv-table-wrap">
        {error ? (
          <div className="inv-error">{error}</div>
        ) : filtered.length === 0 && !loading ? (
          <div className="inv-empty">查無產品</div>
        ) : (
          <table className="inv-table">
            <thead>
              <tr>
                <th>產品名稱</th>
                <th>分類</th>
                <th>庫存</th>
                <th>安全</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className={p.status === 'low' ? 'inv-row--low' : ''}>
                  <td className="inv-name">{p.name}</td>
                  <td className="inv-category">{p.category}</td>
                  {/* 低庫存時以警示色顯示數量 */}
                  <td className={`inv-qty ${p.status === 'low' ? 'inv-qty--low' : ''}`}>
                    {p.quantity}
                  </td>
                  <td className="inv-min">{p.min_stock}</td>
                  <td>
                    <span className={`inv-status ${STATUS_CONFIG[p.status].cls}`}>
                      {STATUS_CONFIG[p.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部統計列 */}
      <div className="inv-footer">
        共 {filtered.length} / {products.length} 筆
        {category !== '全部' && ` · ${category}`}
      </div>
    </div>
  )
}
