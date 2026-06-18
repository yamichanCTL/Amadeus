"""
ASR input layer for runner.

Lightweight adapters — ASR is input, not decision-making.
"""

from runner.asr.base import ASRProvider, ASRResult
from runner.asr.whisper_adapter import WhisperASR

__all__ = ["ASRProvider", "ASRResult", "WhisperASR"]
