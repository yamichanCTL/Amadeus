"""
app/db/models.py
────────────────
SQLAlchemy 2.x declarative ORM models.

Tables
──────
  users       – optional auth; anonymous usage allowed
  asr_tasks   – one row per recognition job (async or sync)
  transcripts – final result linked to a task; may contain multiple segments
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


# ── Base ──────────────────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _new_uuid() -> str:
    return str(uuid.uuid4())


# ── User ──────────────────────────────────────────────────────────────────────

class User(Base):
    """
    Optional user entity.  Anonymous usage is supported: tasks without a
    user_id are public within the session.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(128))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    tasks: Mapped[list["ASRTask"]] = relationship(
        "ASRTask", back_populates="user", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} username={self.username}>"


# ── ASR Task ──────────────────────────────────────────────────────────────────

class TaskStatus:
    PENDING = "pending"
    PROCESSING = "processing"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ASRTask(Base):
    """
    One row per recognition job.

    For synchronous short-audio requests the status moves directly from
    PENDING → PROCESSING → SUCCESS|FAILED within the request cycle.

    For async (Celery) jobs the client polls GET /v1/tasks/{id}.
    """

    __tablename__ = "asr_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)

    # Optional owner
    user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user: Mapped[Optional[User]] = relationship("User", back_populates="tasks")

    # Input metadata
    filename: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    audio_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    duration_sec: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    file_size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mime_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Engine selection (comma-separated for multi-engine runs)
    engines: Mapped[str] = mapped_column(String(128), default="whisper")
    # JSON-serialised engine-specific kwargs, e.g. {"model": "medium", "language": "zh"}
    engine_options: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Pipeline flags snapshot (taken from config at submission time)
    vad_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    punctuation_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    diarize_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # Job lifecycle
    status: Mapped[str] = mapped_column(String(16), default=TaskStatus.PENDING, index=True)
    celery_task_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Result link
    transcript: Mapped[Optional["Transcript"]] = relationship(
        "Transcript", back_populates="task", uselist=False, cascade="all, delete-orphan"
    )

    @property
    def elapsed_sec(self) -> Optional[float]:
        if self.started_at and self.finished_at:
            return (self.finished_at - self.started_at).total_seconds()
        return None

    def __repr__(self) -> str:
        return f"<ASRTask id={self.id} status={self.status} engines={self.engines}>"


# ── Transcript ────────────────────────────────────────────────────────────────

class Transcript(Base):
    """
    Final recognition result.

    `full_text`   – plain concatenated text (no timestamps)
    `segments`    – JSON array of segment objects, e.g.:
                    [{"start": 0.0, "end": 2.4, "text": "你好", "speaker": "SPEAKER_00"}]
    `language`    – detected or requested language code
    `engine_used` – which engine produced this result (or "merged" for multi-engine)
    `confidence`  – average confidence score 0–1 where available
    """

    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("asr_tasks.id", ondelete="CASCADE"), unique=True, index=True
    )
    task: Mapped[ASRTask] = relationship("ASRTask", back_populates="transcript")

    full_text: Mapped[str] = mapped_column(Text, default="")
    segments: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    language: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    engine_used: Mapped[str] = mapped_column(String(64), default="whisper")
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # For multi-engine: store each engine's raw output here as JSON
    raw_results: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    def __repr__(self) -> str:
        preview = (self.full_text or "")[:40]
        return f"<Transcript task_id={self.task_id} text={preview!r}>"