"""
models.py — Case 11: Text-to-SQL Agent
"""

from pydantic import BaseModel


class LlmConfig(BaseModel):
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.1   # SQL 生成需要低 temperature


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None
    llm_config: LlmConfig


class ConversationResponse(BaseModel):
    id: str
    title: str | None
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
    title: str | None
    messages: list[MessageResponse]
