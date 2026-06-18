"""
Voice conversion — WAV in, WAV out with selectable target voice.

Chain: input WAV → ASR → text → GPT-SoVITS(target voice) → output WAV
"""

from runner.voice.converter import VoiceConverter, VoicePreset, list_voices

__all__ = ["VoiceConverter", "VoicePreset", "list_voices"]
