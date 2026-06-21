"""Backend package bootstrap.

The project venv currently uses Miniconda's Python executable. Load the newer
system libstdc++ before numpy/onnxruntime so official sherpa CUDA wheels can use
the GLIBCXX ABI they were built against.
"""

from __future__ import annotations

import ctypes
from pathlib import Path

_system_libstdcpp = Path("/usr/lib/x86_64-linux-gnu/libstdc++.so.6")
if _system_libstdcpp.is_file():
    ctypes.CDLL(str(_system_libstdcpp), mode=ctypes.RTLD_GLOBAL)
