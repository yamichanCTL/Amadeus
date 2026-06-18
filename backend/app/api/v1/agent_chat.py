"""
Agent-centric chat API — uses AgentCore as the central brain.

POST /v1/agent/chat         — one-shot agent turn
POST /v1/agent/chat/stream  — streaming agent turn with directives
GET  /v1/agent/context       — get current agent context
POST /v1/agent/reset         — reset agent session
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.agent_core import AgentCore, get_agent, reset_agent

router = APIRouter(prefix="/agent", tags=["agent"])


class AgentChatRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    session_id: str = "default"
    persona: str | None = None
    memory: str | None = None
    llm_base_url: str = "https://api.deepseek.com"
    llm_api_token: str = ""
    llm_model: str = "deepseek-chat"
    llm_provider: str = "deepseek"
    use_skills: bool = True
    use_emotions: bool = True
    use_context: bool = True
    # Runtime context from frontend
    context: dict[str, str] | None = None


class AgentChatResponse(BaseModel):
    text: str
    emotion: str = "neutral"
    action: str = "idle"
    tool_calls: list[dict[str, Any]] = []
    tool_results: list[str] = []
    error: str | None = None
    elapsed_sec: float = 0.0
    session_id: str = "default"


@router.post("/chat", response_model=AgentChatResponse, summary="One-shot agent turn")
async def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
    agent = get_agent(
        session_id=request.session_id,
        persona=request.persona or "",
        memory=request.memory or "",
        llm_config={
            "base_url": request.llm_base_url,
            "api_token": request.llm_api_token,
            "model": request.llm_model,
            "provider": request.llm_provider,
        },
        use_skills=request.use_skills,
        use_emotions=request.use_emotions,
        use_context=request.use_context,
    )
    # Sync config on each request (in case LLM settings changed)
    agent.llm_config = {
        "base_url": request.llm_base_url,
        "api_token": request.llm_api_token,
        "model": request.llm_model,
        "provider": request.llm_provider,
    }
    if request.persona:
        agent.persona = request.persona
    if request.memory is not None:
        agent.memory = request.memory

    if request.context:
        agent.update_context(**request.context)

    turn = await agent.run_turn(request.text)

    return AgentChatResponse(
        text=turn.assistant_text,
        emotion=turn.state.emotion,
        action=turn.state.action,
        tool_calls=[{"name": t.name, "args": t.args} for t in turn.tool_calls],
        tool_results=turn.tool_results,
        error=turn.error,
        elapsed_sec=turn.elapsed_sec,
        session_id=request.session_id,
    )


@router.post("/chat/stream", summary="Streaming agent turn with directives and tool execution")
async def agent_chat_stream(request: AgentChatRequest) -> StreamingResponse:
    async def event_stream():
        agent = get_agent(
            session_id=request.session_id,
            persona=request.persona or "",
            memory=request.memory or "",
            llm_config={
                "base_url": request.llm_base_url,
                "api_token": request.llm_api_token,
                "model": request.llm_model,
                "provider": request.llm_provider,
            },
            use_skills=request.use_skills,
            use_emotions=request.use_emotions,
            use_context=request.use_context,
        )
        agent.llm_config = {
            "base_url": request.llm_base_url,
            "api_token": request.llm_api_token,
            "model": request.llm_model,
            "provider": request.llm_provider,
        }
        if request.persona:
            agent.persona = request.persona
        if request.memory is not None:
            agent.memory = request.memory
        if request.context:
            agent.update_context(**request.context)

        try:
            async for event in agent.stream_turn(request.text):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/context", summary="Get current agent session context")
async def get_agent_context(session_id: str = "default"):
    agent = get_agent(session_id=session_id)
    return {
        "session_id": session_id,
        "turn_count": agent.turn_count,
        "message_count": len(agent.messages),
        "task_count": len(agent.tasks),
        "open_tasks": [{"id": t.id, "text": t.text} for t in agent.tasks if t.status == "open"],
        "memory": agent.memory[:500],
        "emotion": agent.state.emotion,
        "action": agent.state.action,
    }


@router.post("/reset", summary="Reset agent session")
async def reset_agent_session(session_id: str = "default"):
    reset_agent(session_id)
    return {"ok": True, "session_id": session_id}
