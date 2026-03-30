"""
Pydantic 模型 — API 請求與回應的資料結構（Case 10）
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class LlmConfig(BaseModel):
    """LLM 設定，由前端每次請求一併傳入。API Key 不存於後端。"""
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.7


class ChatRequest(BaseModel):
    """POST /api/chat 的請求格式"""
    message: str
    thread_id: Optional[str] = None
    llm_config: LlmConfig


class MessageResponse(BaseModel):
    id: int
    conversation_id: str
    role: str
    content: str
    created_at: datetime


class ConversationResponse(BaseModel):
    id: str
    title: Optional[str]
    created_at: datetime
    updated_at: datetime


class ConversationDetailResponse(BaseModel):
    id: str
    title: Optional[str]
    messages: list[MessageResponse]
