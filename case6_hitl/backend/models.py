"""
Pydantic 模型 — Case 6: Human-in-the-Loop
"""

from typing import Literal
from pydantic import BaseModel, Field


class LlmConfig(BaseModel):
    api_key: str
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    temperature: float = 0.3


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None
    llm_config: LlmConfig


class OrderItemInput(BaseModel):
    """前端送出修改訂單時使用"""
    product_id: str
    name: str
    quantity: int = Field(ge=1)
    unit_price: float


class DecisionRequest(BaseModel):
    """審批決定請求"""
    action: Literal["approved", "rejected"]
    items: list[OrderItemInput] | None = None   # 若 action=approved 且有修改，帶入修改後的品項
    llm_config: LlmConfig


class SelectionRequest(BaseModel):
    """商品選擇請求：使用者從候選清單中選定商品後送出"""
    resolved_items: list[OrderItemInput]
    llm_config: LlmConfig


class QuantityResolvedItem(BaseModel):
    """數量確認的單一品項"""
    product_name: str
    quantity: int = Field(ge=1)


class QuantityRequest(BaseModel):
    """數量確認請求：使用者填入未指定數量的商品數量後送出"""
    quantities: list[QuantityResolvedItem]
    llm_config: LlmConfig


# ── Structured Output 模型（LLM with_structured_output 使用）────────────────

class ParsedOrderItem(BaseModel):
    product_name: str = Field(description="商品名稱：若能清楚對應目錄商品則填入目錄名稱，否則填入使用者原始描述")
    quantity: int = Field(default=1, description="訂購數量（若使用者未指定則預設 1，並將 quantity_unknown 設為 true）", ge=1)
    quantity_unknown: bool = Field(default=False, description="True 表示使用者未明確說明數量，quantity 為預設值，需向使用者確認")
    candidate_ids: list[str] = Field(
        default=[],
        description="當 product_name 模糊、無法唯一對應目錄時，從目錄中列出最可能符合的商品ID（如 ['P007','P008']），最多 5 個"
    )


class ParsedOrder(BaseModel):
    items: list[ParsedOrderItem] = Field(description="訂購的商品列表")
    is_valid: bool = Field(description="是否為有效的訂單請求（含具體商品與數量）")
    invalid_reason: str = Field(default="", description="若無效，說明原因")


# ── Response 模型 ─────────────────────────────────────────────────────────────

class ConversationResponse(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class MessageResponse(BaseModel):
    id: int
    conversation_id: str
    role: str
    content: str
    created_at: str


class ConversationDetailResponse(BaseModel):
    id: str
    title: str
    messages: list[MessageResponse]
