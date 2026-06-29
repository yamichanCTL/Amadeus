#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/frontend/desktop"

npx vitest run \
  src/services/recordingService.consecutive.e2e.test.ts \
  electron/latest-task-queue.test.ts \
  --reporter=verbose
