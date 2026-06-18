"""
Routes for delegating tasks to local coding-agent CLIs.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.core.agent import delegate_to_agent
from app.schemas.agent import AgentDelegateRequest, AgentDelegateResult

router = APIRouter(prefix="/agents", tags=["agents"])


@router.post("/delegate", response_model=AgentDelegateResult, summary="Delegate a task to a local coding agent")
async def delegate_agent_task(request: AgentDelegateRequest) -> AgentDelegateResult:
    try:
        return await delegate_to_agent(request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Agent delegation failed: {exc}",
        ) from exc
