"""
Pydantic Schemas — Case 4: Plan-Execute Agent

LlmConfig：前端傳入的 LLM 設定（api_key 不寫入後端儲存）
ChatRequest：聊天 API 的請求 body
TravelPlan：planner_node 的結構化輸出（with_structured_output 使用）
"""

from typing import Optional
from pydantic import BaseModel, Field


class LlmConfig(BaseModel):
    """前端傳入的 LLM 連線設定"""
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.7


class ChatRequest(BaseModel):
    """聊天端點的請求格式"""
    message: str
    conversation_id: Optional[str] = None
    llm_config: LlmConfig


class TravelPlan(BaseModel):
    """
    planner_node 用 with_structured_output 生成的旅行計劃結構。
    LLM 必須嚴格輸出此格式，不允許自由文字。

    Case 4 學習重點：
    with_structured_output(TravelPlan) 讓 LLM 透過 function calling
    輸出符合 Pydantic schema 的 JSON，確保步驟清單格式正確。
    """
    destination: str = Field(description="旅遊目的地（城市名稱）")
    duration_days: int = Field(description="旅遊天數", ge=1, le=14)
    steps: list[str] = Field(
        description=(
            "旅行規劃的執行步驟清單（3-5 個步驟）。"
            "每個步驟描述一個具體的資訊收集或規劃任務，例如：「搜尋東京的熱門景點」。"
            "步驟應按照邏輯順序排列，先收集資訊再整合規劃。"
        )
    )


class ConversationResponse(BaseModel):
    id: str
    title: Optional[str]
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class MessageResponse(BaseModel):
    id: int
    conversation_id: str
    role: str
    content: str
    plan_json: Optional[str] = None
    created_at: str

    class Config:
        from_attributes = True


class ConversationDetailResponse(BaseModel):
    id: str
    title: Optional[str]
    messages: list[MessageResponse]
