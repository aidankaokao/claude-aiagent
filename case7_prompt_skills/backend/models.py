from pydantic import BaseModel, Field
from typing import Optional


class LlmConfig(BaseModel):
    api_key: str
    base_url: str = ""
    model: str = "gpt-4o-mini"
    temperature: float = 0.7


class ChatRequest(BaseModel):
    message: str
    thread_id: str
    skill_override: str = ""     # "" = 自動偵測；或填入技能名稱強制使用
    llm_config: LlmConfig


class PlaygroundRequest(BaseModel):
    """Prompt Playground 測試請求"""
    input_text: str
    skill_name: str
    llm_config: LlmConfig


class RatingRequest(BaseModel):
    """使用者評分請求"""
    message_id: int
    conversation_id: str
    skill_name: str
    rating: int = Field(ge=1, le=5)
    feedback: str = ""


# ── API 回應 Schema ──

class FewShotExampleInfo(BaseModel):
    user_input: str
    expected_output: str


class SkillParameterInfo(BaseModel):
    """技能的輸入參數定義（來自 SKILL.md ## Parameters 區段）"""
    name: str        # 欄位鍵名（用於組合 input_text）
    label: str       # 顯示標籤（前端表單用）
    type: str        # "text" | "textarea"
    required: bool


class SkillInfo(BaseModel):
    name: str
    display_name: str
    description: str
    icon: str
    system_prompt: str
    examples: list[FewShotExampleInfo] = []
    parameters: list[SkillParameterInfo] = []   # 空列表 = 無參數表單


class MessageResponse(BaseModel):
    id: int
    role: str
    content: str
    skill_name: Optional[str] = None
    created_at: str


class ConversationResponse(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class ConversationDetailResponse(BaseModel):
    id: str
    title: str
    messages: list[MessageResponse]
