# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# System deps for audio libs (soundfile / librosa)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libsndfile1-dev libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
# Install base deps + whisper engine by default
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -e ".[whisper]"

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# Runtime system libs only (no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application source
COPY app/ ./app/
COPY .env.example .env

# Create runtime directories
RUN mkdir -p data/uploads data/transcripts models/whisper models/vosk models/sherpa

# Non-root user for security
RUN useradd -m -u 1001 asruser && chown -R asruser:asruser /app
USER asruser

EXPOSE 8000

# Healthcheck — hits the liveness probe every 30 s
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/v1/health')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--log-level", "info"]