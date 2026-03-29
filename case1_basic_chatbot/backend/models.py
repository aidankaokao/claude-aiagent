"""
Pydantic 模型 — API 請求/回應資料結構

學習重點：
- LlmConfig 包含前端填入的 LLM 設定（含 API Key）
- ChatRequest 每次都帶上 LlmConfig，後端不儲存 API Key
"""

from pydantic import BaseModel
from typing import Optional
from datetime import datetime


# === LLM 設定（由前端填入，隨請求傳入） ===

class LlmConfig(BaseModel):
    api_key: str                                              # OpenAI API Key
    model: str = "gpt-4o-mini"                               # 模型名稱
    base_url: str = "https://api.openai.com/v1"              # API Base URL
    temperature: float = 0.7                                  # 溫度


# === 請求模型 ===

class ChatRequest(BaseModel):
    message: str                              # 使用者輸入的訊息
    conversation_id: Optional[str] = None     # 對話 ID（None 表示新對話）
    llm_config: LlmConfig                     # LLM 設定（含 API Key）


# === 回應模型 ===

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
