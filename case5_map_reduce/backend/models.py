"""
Pydantic 模型 — Case 5: Map-Reduce Agent
"""

from typing import Literal, Optional
from pydantic import BaseModel


class LlmConfig(BaseModel):
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.7


class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    llm_config: LlmConfig


class DocumentAnalysis(BaseModel):
    """analyze_node 使用 with_structured_output 強制 LLM 輸出此格式"""
    doc_id: str
    title: str
    summary: str                                          # 2-3 句摘要
    key_points: list[str]                                 # 3-5 個重點
    sentiment: Literal["positive", "neutral", "negative"] # 整體情感傾向


class DocumentInfo(BaseModel):
    id: str
    title: str
    category: str


class ConversationResponse(BaseModel):
    id: str
    title: Optional[str]
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
    title: Optional[str]
    messages: list[MessageResponse]
