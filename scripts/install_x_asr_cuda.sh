#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHEEL="/tmp/sherpa_onnx-1.13.2+cuda12.cudnn9-cp313-cp313-linux_x86_64.whl"
URL="https://hf-mirror.com/csukuangfj2/sherpa-onnx-wheels/resolve/main/cuda/1.13.2/sherpa_onnx-1.13.2%2Bcuda12.cudnn9-cp313-cp313-linux_x86_64.whl"

if [[ "$("$ROOT/.venv/bin/python" -c 'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}")')" != "cp313" ]]; then
  echo "当前脚本对应 Python 3.13；请从官方 CUDA wheel 索引选择匹配 ABI。" >&2
  exit 2
fi

if [[ ! -s "$WHEEL" ]]; then
  curl -L --fail --retry 3 -o "$WHEEL" "$URL"
fi

UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}" uv pip install \
  --python "$ROOT/.venv/bin/python" --reinstall "$WHEEL"

"$ROOT/.venv/bin/python" -c 'import sherpa_onnx; print("installed", sherpa_onnx.__version__)'
echo "启动后端请使用 uv run --no-sync，避免通用 CPU lockfile 覆盖本机 CUDA wheel。"
