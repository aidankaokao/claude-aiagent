"""
Pydantic 模型 — 定義 API 請求與回應的資料結構

FastAPI 會自動用這些模型驗證輸入、序列化輸出，
並生成 OpenAPI 文件。
"""

from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class LlmConfig(BaseModel):
    """
    LLM 設定，由前端每次請求時一併傳入。
    API Key 不存於後端，僅在記憶體中使用後丟棄。
    """
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.7


class ChatRequest(BaseModel):
    """POST /api/chat 的請求格式"""
    message: str
    conversation_id: Optional[str] = None
    llm_config: LlmConfig


# === 對話相關回應 ===

class MessageResponse(BaseModel):
    """單則訊息的回應格式"""
    id: int
    conversation_id: str
    role: str
    content: str
    created_at: datetime


class ConversationResponse(BaseModel):
    """對話列表中每筆對話的摘要格式（不含訊息內容）"""
    id: str
    title: Optional[str]
    created_at: datetime
    updated_at: datetime


class ConversationDetailResponse(BaseModel):
    """取得單一對話詳情時的完整回應（含所有訊息）"""
    id: str
    title: Optional[str]
    messages: list[MessageResponse]


# === 庫存相關回應（給 InventoryTable 前端元件使用）===

class ProductResponse(BaseModel):
    """單一產品的回應格式"""
    id: int
    name: str
    category: str
    quantity: int
    min_stock: int
    unit_price: float
    # 計算欄位：庫存狀態，由後端計算後回傳給前端
    status: str   # "low"（不足）/ "normal"（正常）/ "high"（充足）
    created_at: datetime
    updated_at: datetime
