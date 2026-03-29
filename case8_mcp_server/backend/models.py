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
    api_key: str                                    # OpenAI API Key（或相容 API 的 Key）
    model: str = "gpt-4o-mini"                     # 模型名稱
    base_url: str = "https://api.openai.com/v1"    # API 端點（可替換為本地模型）
    temperature: float = 0.7                        # 生成溫度（0=確定性，2=高隨機性）


class ChatRequest(BaseModel):
    """POST /api/chat 的請求格式"""
    message: str                                    # 使用者輸入的訊息
    thread_id: Optional[str] = None                # 對話 ID（若為 None，後端會自動建立新對話）
    llm_config: LlmConfig                          # LLM 設定（含 API Key）


class ArticleResponse(BaseModel):
    """知識庫文章的回應格式（供 /api/articles 側邊欄端點使用）"""
    id: int
    title: str
    content: str                                   # 由後端截斷至 200 字
    tags: str
    created_at: str


class MessageResponse(BaseModel):
    """單則訊息的回應格式"""
    id: int
    conversation_id: str
    role: str                                       # "user" 或 "assistant"
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
