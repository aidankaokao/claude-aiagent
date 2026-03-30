"""
FastAPI 應用 — 全端整合 API（Case 10）

架構特點：
- 三模式路由：chat / tools / research
- 統一 SSE 事件設計，前端根據 mode 自適應顯示
- astream_events v2 多類型事件同時處理
- Agent 快取：依 (api_key前8碼, model) 快取已編譯的 Agent 實例

SSE 事件類型：
  event: mode        data: {"mode": "chat"|"tools"|"research", "reason": "..."}
  event: tool_start  data: {"run_id", "tool_name", "tool_input"}
  event: tool_end    data: {"run_id", "tool_name", "tool_output"}
  event: agent_start data: {"agent": "researcher"|"writer"}
  event: agent_end   data: {"agent", "summary", "content"}
  event: token       data: {"content"}   ← chat / react 最終答案 / writer 串流
  event: done        data: {"conversation_id", "content"}
  event: error       data: {"message"}

過濾原則（astream_events v2）：
- on_chat_model_end + node=="router"               → 提取 mode 決策 → mode 事件
- on_chat_model_start + node in RESEARCH_NODES     → agent_start 事件
- on_chat_model_stream + node in STREAM_NODES      → token 事件（過濾空白 / tool call 內容）
- on_chat_model_end + node in RESEARCH_NODES       → agent_end 事件（含 writer 完整內容）
- on_chat_model_end + node=="react" + no tool_calls → agent_end 事件（react 最終答案 fallback）
- on_tool_start                                    → tool_start 事件
- on_tool_end                                      → tool_end 事件
"""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import desc, insert, select, update, delete

from agent import IntegratedAgent
from config import settings
from database import engine, init_db, conversations, messages
from models import (
    ChatRequest,
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

# ============================================================
# Agent 快取
# ============================================================

_agent_cache: dict[str, object] = {}

# Research 模式：追蹤這兩個節點的 agent_start/end 事件
RESEARCH_NODES = {"researcher", "writer"}

# 串流 token 的節點（chat / react 最終回答 / writer）
STREAM_NODES = {"chat", "react", "writer"}


# ============================================================
# FastAPI Lifespan
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Server] 全端整合 API 啟動完成")
    yield


# ============================================================
# FastAPI App
# ============================================================

app = FastAPI(title="Case 10: 全端整合 API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# 輔助函數
# ============================================================

async def get_or_create_agent(llm_config):
    """依 LLM 設定取得或建立 Agent（快取機制）"""
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
    if cache_key not in _agent_cache:
        agent_instance = IntegratedAgent(llm_config)
        _agent_cache[cache_key] = await agent_instance.create_agent()
        print(f"[Agent] 新建 IntegratedAgent（model={llm_config.model}）")
    return _agent_cache[cache_key]


def _extract_mode(event_data: dict) -> tuple[str, str]:
    """
    從 router 節點的 on_chat_model_end 事件提取 mode 和 reason。
    with_structured_output 透過 tool_calls 回傳結構化輸出。
    """
    output = event_data.get("output")
    if not output:
        return "", ""

    # function calling 模式（主流）
    tool_calls = getattr(output, "tool_calls", None)
    if tool_calls:
        tc = tool_calls[0]
        args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
        return args.get("mode", ""), args.get("reason", "")

    # JSON 模式 fallback
    if hasattr(output, "content") and isinstance(output.content, str):
        try:
            obj = json.loads(output.content)
            return obj.get("mode", ""), obj.get("reason", "")
        except Exception:
            pass

    return "", ""


def _extract_summary(node: str, event_data: dict) -> str:
    """從 on_chat_model_end 提取 research 節點的輸出摘要"""
    output = event_data.get("output")
    if not output:
        return ""
    if hasattr(output, "content") and isinstance(output.content, str):
        return output.content[:300]
    return ""


# ============================================================
# GET /api/health
# ============================================================

@app.get("/api/health")
async def health():
    return {"status": "ok", "modes": ["chat", "tools", "research"]}


# ============================================================
# POST /api/chat — SSE 串流端點
# ============================================================

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    全端整合聊天端點，透過 SSE 串流回傳 Agent 執行狀態。

    astream_events v2 事件處理順序：
    1. router 節點的 on_chat_model_end → 提取 mode → 發送 mode 事件
    2. 根據 mode：
       - chat：on_chat_model_stream → token 事件
       - tools：on_tool_start/end → tool 事件；on_chat_model_stream（最終回答）→ token
       - research：on_chat_model_start/end（researcher/writer）→ agent 事件；writer stream → token
    3. 所有路徑完成 → done 事件
    """
    conversation_id = req.thread_id or str(uuid.uuid4())

    if not req.thread_id:
        with engine.connect() as conn:
            conn.execute(insert(conversations).values(
                id=conversation_id,
                title=req.message[:50],
            ))
            conn.commit()

    with engine.connect() as conn:
        conn.execute(insert(messages).values(
            conversation_id=conversation_id,
            role="user",
            content=req.message,
        ))
        conn.commit()

    async def event_generator():
        full_response = ""
        reported_runs: set[str] = set()
        mode_sent = False  # 確保 mode 事件只發一次

        print(f"\n[Chat] ── 開始處理 conversation={conversation_id[:8]} ──")
        print(f"[Chat] message={req.message[:60]!r}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 30,
            }

            async for event in agent.astream_events(
                {
                    "messages": [("user", req.message)],
                    "task": req.message,
                    "mode": "",
                    "mode_reason": "",
                    "research_result": "",
                    "iteration": 0,
                },
                config=config,
                version="v2",
            ):
                etype = event["event"]
                run_id = event.get("run_id", "")
                node = event.get("metadata", {}).get("langgraph_node", "")
                name = event.get("name", "")

                # 非串流事件印出摘要
                if etype != "on_chat_model_stream":
                    run_short = run_id[:8] if run_id else "-"
                    print(f"[Event] {etype:<30} node={node:<14} name={name:<28} run={run_short}")

                # ── 1. Router 完成 → mode 事件 ────────────────────
                if etype == "on_chat_model_end" and node == "router" and not mode_sent:
                    mode, reason = _extract_mode(event["data"])
                    if mode:
                        mode_sent = True
                        print(f"  → SSE mode: {mode}  reason={reason[:50]!r}")
                        yield {
                            "event": "mode",
                            "data": json.dumps({"mode": mode, "reason": reason}, ensure_ascii=False),
                        }

                # ── 2. Research 模式：agent_start ─────────────────
                elif etype == "on_chat_model_start" and node in RESEARCH_NODES:
                    if run_id not in reported_runs:
                        reported_runs.add(run_id)
                        print(f"  → SSE agent_start: {node}")
                        yield {
                            "event": "agent_start",
                            "data": json.dumps({"agent": node}, ensure_ascii=False),
                        }

                # ── 3. Token 串流 ──────────────────────────────────
                elif etype == "on_chat_model_stream" and node in STREAM_NODES:
                    chunk = event["data"]["chunk"].content
                    # 過濾：tool call 生成時 content 為空，只取純文字 token
                    if isinstance(chunk, str) and chunk:
                        full_response += chunk
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk}, ensure_ascii=False),
                        }

                # ── 4. Research 模式：agent_end ───────────────────
                elif etype == "on_chat_model_end" and node in RESEARCH_NODES:
                    if run_id in reported_runs:
                        summary = _extract_summary(node, event["data"])
                        writer_content = ""
                        if node == "writer":
                            output = event["data"].get("output")
                            if hasattr(output, "content") and isinstance(output.content, str):
                                writer_content = output.content
                            if writer_content:
                                full_response = writer_content
                            print(f"  → writer_content={len(writer_content)} 字")
                        print(f"  → SSE agent_end:  {node}  summary={summary[:60]!r}")
                        yield {
                            "event": "agent_end",
                            "data": json.dumps({
                                "agent": node,
                                "summary": summary,
                                "content": writer_content,
                            }, ensure_ascii=False),
                        }

                # ── 5. React 模式：最終答案 fallback ─────────────
                elif etype == "on_chat_model_end" and node == "react":
                    output = event["data"].get("output")
                    if output:
                        # 無 tool_calls → 這是最終回答，content 作為 fallback
                        tool_calls = getattr(output, "tool_calls", None)
                        if not tool_calls:
                            content = getattr(output, "content", "")
                            if content:
                                full_response = content
                            print(f"  → react final answer={len(content)} 字")
                            yield {
                                "event": "agent_end",
                                "data": json.dumps({
                                    "agent": "react",
                                    "summary": "",
                                    "content": content,
                                }, ensure_ascii=False),
                            }

                # ── 6. 工具執行 ────────────────────────────────────
                elif etype == "on_tool_start":
                    tool_name = event.get("name", "")
                    tool_input = event["data"].get("input", {})
                    if not isinstance(tool_input, dict):
                        tool_input = {"input": str(tool_input)}
                    print(f"  → SSE tool_start: {tool_name}  input={str(tool_input)[:60]}")
                    yield {
                        "event": "tool_start",
                        "data": json.dumps({
                            "run_id": run_id,
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                        }, ensure_ascii=False),
                    }

                elif etype == "on_tool_end":
                    tool_output = event["data"].get("output", "")
                    if hasattr(tool_output, "content"):
                        tool_output = tool_output.content
                    tool_output_str = str(tool_output)[:500]
                    print(f"  → SSE tool_end:   {event.get('name','')}  output={tool_output_str[:60]!r}")
                    yield {
                        "event": "tool_end",
                        "data": json.dumps({
                            "run_id": run_id,
                            "tool_name": event.get("name", ""),
                            "tool_output": tool_output_str,
                        }, ensure_ascii=False),
                    }

            # 儲存回應到 DB
            if full_response:
                with engine.connect() as conn:
                    conn.execute(insert(messages).values(
                        conversation_id=conversation_id,
                        role="assistant",
                        content=full_response,
                    ))
                    conn.execute(
                        update(conversations)
                        .where(conversations.c.id == conversation_id)
                        .values()
                    )
                    conn.commit()

            print(f"[Chat] 完成  full_response={len(full_response)} 字")
            yield {
                "event": "done",
                "data": json.dumps({
                    "conversation_id": conversation_id,
                    "content": full_response,
                }, ensure_ascii=False),
            }

        except Exception as e:
            import traceback
            print(f"[Chat] !! 例外發生: {e}")
            print(traceback.format_exc())
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# GET /api/conversations
# ============================================================

@app.get("/api/conversations", response_model=list[ConversationResponse])
async def list_conversations():
    with engine.connect() as conn:
        rows = conn.execute(
            select(conversations).order_by(desc(conversations.c.updated_at))
        ).fetchall()
    return [
        ConversationResponse(
            id=r.id, title=r.title,
            created_at=r.created_at, updated_at=r.updated_at,
        )
        for r in rows
    ]


# ============================================================
# GET /api/conversations/{conversation_id}
# ============================================================

@app.get("/api/conversations/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation(conversation_id: str):
    with engine.connect() as conn:
        conv = conn.execute(
            select(conversations).where(conversations.c.id == conversation_id)
        ).fetchone()
        if not conv:
            raise HTTPException(status_code=404, detail="對話不存在")
        msg_rows = conn.execute(
            select(messages)
            .where(messages.c.conversation_id == conversation_id)
            .order_by(messages.c.created_at)
        ).fetchall()
    return ConversationDetailResponse(
        id=conv.id, title=conv.title,
        messages=[
            MessageResponse(
                id=r.id, conversation_id=r.conversation_id,
                role=r.role, content=r.content, created_at=r.created_at,
            )
            for r in msg_rows
        ],
    )


# ============================================================
# DELETE /api/conversations/{conversation_id}
# ============================================================

@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    with engine.connect() as conn:
        conn.execute(delete(messages).where(messages.c.conversation_id == conversation_id))
        conn.execute(delete(conversations).where(conversations.c.id == conversation_id))
        conn.commit()
    return {"status": "ok"}


# ============================================================
# 入口點
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
