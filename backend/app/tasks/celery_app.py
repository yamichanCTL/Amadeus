"""
app/tasks/celery_app.py
────────────────────────
Celery application factory.

Workers are started separately:
    celery -A app.tasks.celery_app.celery_app worker --loglevel=info

For development without Redis, set CELERY_TASK_ALWAYS_EAGER=true in .env
to run tasks synchronously inside the request process.
"""

from __future__ import annotations

from celery import Celery  # type: ignore[import]
from celery.signals import worker_process_init, worker_process_shutdown  # type: ignore[import]

from app.config import get_settings

settings = get_settings()

# ── Factory ───────────────────────────────────────────────────────────────────

def create_celery_app() -> Celery:
    app = Celery(
        "asr_worker",
        broker=settings.celery_broker_url,
        backend=settings.celery_result_backend,
        include=["app.tasks.asr_task"],
    )

    app.conf.update(
        # Serialisation
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],

        # Timezone
        timezone="UTC",
        enable_utc=True,

        # Task behaviour
        task_acks_late=True,          # re-queue if worker dies mid-task
        task_reject_on_worker_lost=True,
        task_time_limit=settings.celery_task_time_limit,
        task_soft_time_limit=settings.celery_task_time_limit - 60,

        # Result expiry
        result_expires=86_400,        # 24 h

        # Worker concurrency (set to 1 per GPU worker)
        worker_prefetch_multiplier=1,
        worker_max_tasks_per_child=50,  # restart worker after 50 tasks to free RAM

        # Development convenience: run tasks inline if configured.
        task_always_eager=settings.celery_task_always_eager,
    )

    return app


celery_app: Celery = create_celery_app()


# ── Worker lifecycle hooks ────────────────────────────────────────────────────

@worker_process_init.connect
def init_worker(**kwargs: object) -> None:
    """
    Called once per worker process at startup.
    Pre-load the default engine so the first task doesn't pay the cold-start
    penalty.
    """
    import asyncio
    from app.core.model_manager import get_model_manager
    from app.config import get_settings as _gs

    _settings = _gs()
    manager = get_model_manager()

    async def _preload() -> None:
        try:
            await manager.get_engine(_settings.default_engine)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                "Could not pre-load default engine '%s': %s",
                _settings.default_engine, exc,
            )

    asyncio.run(_preload())


@worker_process_shutdown.connect
def shutdown_worker(**kwargs: object) -> None:
    """Unload all engines and release GPU memory on worker exit."""
    import asyncio
    from app.core.model_manager import get_model_manager

    async def _shutdown() -> None:
        await get_model_manager().shutdown()

    asyncio.run(_shutdown())
