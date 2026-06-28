#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/frontend/desktop"

npx vitest run \
  src/pages/VoiceChanger.e2e.test.tsx \
  src/services/recordingService.input.e2e.test.ts \
  --reporter=verbose
