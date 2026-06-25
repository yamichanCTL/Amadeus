"""
app/api/v1/skills.py
────────────────────
API routes for the agent skill registry.

GET  /v1/skills           — list all registered skills
POST /v1/skills/execute    — execute a skill by name
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.core.skill_registry import get_skill_registry
from app.schemas.skill import SkillExecuteRequest, SkillExecuteResult, SkillListResponse

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("", response_model=SkillListResponse, summary="List all registered agent skills")
async def list_skills(category: str | None = Query(None, description="Filter by category")):
    registry = get_skill_registry()
    skills = registry.list_skills(category=category)
    return SkillListResponse(skills=skills, total=len(skills))


@router.post("/execute", response_model=SkillExecuteResult, summary="Execute an agent skill")
async def execute_skill(request: SkillExecuteRequest) -> SkillExecuteResult:
    registry = get_skill_registry()
    result = await registry.execute(request.skill, request.parameters)
    # Return 200 with success=false for unknown skills (instead of 404)
    # so clients can distinguish "endpoint not found" from "skill not registered"
    return result
