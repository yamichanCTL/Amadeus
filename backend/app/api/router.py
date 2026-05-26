"""
app/api/router.py
──────────────────
Aggregates all v1 sub-routers into a single APIRouter that is mounted
on the FastAPI application in main.py.
"""

from fastapi import APIRouter

from app.api.v1 import auth, health, models, records, stream, tasks, transcribe

api_router = APIRouter(prefix="/v1")

api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(transcribe.router)
api_router.include_router(tasks.router)
api_router.include_router(models.router)
api_router.include_router(stream.router)
api_router.include_router(records.router)
