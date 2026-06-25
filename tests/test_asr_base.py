"""
Tests for ASRResult dataclass and ASRProvider abstract base.
"""

import pytest

from runner.asr.base import ASRProvider, ASRResult


class TestASRResult:
    """ASRResult dataclass tests."""

    def test_minimal_result(self) -> None:
        r = ASRResult(text="你好")
        assert r.text == "你好"
        assert r.language is None
        assert r.confidence is None
        assert r.engine == "unknown"
        assert r.duration_seconds == 0.0
        assert r.segments == []

    def test_full_result(self) -> None:
        segments = [
            {"start": 0.0, "end": 1.5, "text": "你好"},
            {"start": 1.5, "end": 3.0, "text": "世界"},
        ]
        r = ASRResult(
            text="你好世界",
            language="zh",
            confidence=0.95,
            engine="whisper",
            duration_seconds=3.0,
            segments=segments,
        )
        assert r.text == "你好世界"
        assert r.language == "zh"
        assert r.confidence == 0.95
        assert r.engine == "whisper"
        assert r.duration_seconds == 3.0
        assert len(r.segments) == 2
        assert r.segments[0]["text"] == "你好"

    def test_confidence_boundaries(self) -> None:
        """Confidence accepts any float (validation is caller's responsibility)."""
        r1 = ASRResult(text="x", confidence=0.0)
        r2 = ASRResult(text="x", confidence=1.0)
        r3 = ASRResult(text="x", confidence=1.5)  # no clamp at dataclass level
        assert r1.confidence == 0.0
        assert r2.confidence == 1.0
        assert r3.confidence == 1.5

    def test_empty_segments_default(self) -> None:
        r = ASRResult(text="test")
        assert r.segments == []

    def test_different_engines(self) -> None:
        for engine in ["whisper", "sensevoice", "fireredasr2", "mock"]:
            r = ASRResult(text="x", engine=engine)
            assert r.engine == engine

    def test_language_is_optional(self) -> None:
        r = ASRResult(text="test", language=None)
        assert r.language is None


class TestASRProviderAbstract:
    """Verify ASRProvider is properly abstract."""

    def test_cannot_instantiate_abstract(self) -> None:
        with pytest.raises(TypeError):
            ASRProvider()  # type: ignore[abstract]

    def test_subclass_must_implement_name_and_transcribe(self) -> None:
        with pytest.raises(TypeError):

            class Incomplete(ASRProvider):
                pass

            Incomplete()  # type: ignore[abstract]
