#!/bin/bash
# ASRAPP System Startup Script
# Starts backend + frontend dev server + health checks

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend/desktop"
BACKEND_PORT=8000
FRONTEND_PORT=5174

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[ASRAPP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

cleanup() {
    log "Shutting down..."
    [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    exit 0
}
trap cleanup INT TERM

# ── Backend ──────────────────────────────────────────────────────────────
log "Starting backend on port $BACKEND_PORT..."
cd "$BACKEND_DIR"
uv run uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT --reload &
BACKEND_PID=$!

# Wait for backend health
log "Waiting for backend..."
for i in $(seq 1 30); do
    if curl -s "http://localhost:$BACKEND_PORT/v1/health" > /dev/null 2>&1; then
        log "Backend is ready (PID: $BACKEND_PID)"
        break
    fi
    if [ $i -eq 30 ]; then
        err "Backend failed to start"
        exit 1
    fi
    sleep 1
done

# Show backend info
BACKEND_INFO=$(curl -s "http://localhost:$BACKEND_PORT/v1/health")
log "Backend status: $BACKEND_INFO"

SKILLS_COUNT=$(curl -s "http://localhost:$BACKEND_PORT/v1/skills" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "?")
log "Registered skills: $SKILLS_COUNT"

ENGINES_COUNT=$(curl -s "http://localhost:$BACKEND_PORT/v1/models" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['engines'] if isinstance(d,dict) else d))" 2>/dev/null || echo "?")
log "ASR engines: $ENGINES_COUNT"

# ── Frontend ─────────────────────────────────────────────────────────────
log "Starting frontend dev server on port $FRONTEND_PORT..."
cd "$FRONTEND_DIR"
node node_modules/vite/bin/vite.js --port $FRONTEND_PORT --host 0.0.0.0 &
FRONTEND_PID=$!

log "Frontend starting (PID: $FRONTEND_PID)..."

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         ASRAPP System is Running             ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  Backend:  http://localhost:$BACKEND_PORT              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Frontend: http://localhost:$FRONTONT_PORT             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  API Docs: http://localhost:$BACKEND_PORT/docs          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Skills:   $SKILLS_COUNT registered                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Engines:  $ENGINES_COUNT available                     ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
log "Press Ctrl+C to stop all services"

# Keep running
wait
