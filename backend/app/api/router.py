"""
app/api/router.py
──────────────────
Aggregates all v1 sub-routers into a single APIRouter that is mounted
on the FastAPI application in main.py.
"""

from fastapi import APIRouter

from app.api.v1 import (
    agent_chat,
    agents,
    auth,
    health,
    hotwords,
    llm,
    models,
    records,
    skills,
    stream,
    tasks,
    transcribe,
    tts_api,
    voice_api,
)

api_router = APIRouter(prefix="/v1")

api_router.include_router(health.router)
api_router.include_router(hotwords.router)
api_router.include_router(auth.router)
api_router.include_router(agents.router)
api_router.include_router(agent_chat.router)
api_router.include_router(skills.router)
api_router.include_router(transcribe.router)
api_router.include_router(llm.router)
api_router.include_router(tasks.router)
api_router.include_router(models.router)
api_router.include_router(stream.router)
api_router.include_router(records.router)
api_router.include_router(tts_api.router)
api_router.include_router(voice_api.router)
