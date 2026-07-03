from __future__ import annotations

import json
from dataclasses import dataclass
import pytest

from app.core.json_utils import json_safe
from app.core.asr.base import EngineOptions
from app.core.asr.engines.qwen3asr import Qwen3ASREngine
from app.db.crud import create_transcript
from backend.tests.conftest import make_wav_bytes


class ASRTranscription:
    def __init__(self) -> None:
        self.text = "宝宝，能不能听到我说话呢？"
        self.language = "Chinese"


@dataclass
class NestedResult:
    confidence: float
    provider_result: object


def test_qwen_asr_transcription_object_becomes_json_serializable() -> None:
    payload = {
        "model": "qwen3asr",
        "result": NestedResult(0.98, ASRTranscription()),
    }

    encoded = json.dumps(json_safe(payload), ensure_ascii=False)

    assert "宝宝，能不能听到我说话呢？" in encoded
    assert '"language": "Chinese"' in encoded
    assert '"confidence": 0.98' in encoded


def test_recursive_provider_object_does_not_break_json_encoding() -> None:
    recursive: dict[str, object] = {}
    recursive["self"] = recursive

    assert json.dumps(json_safe(recursive)) == '{"self": "<recursive>"}'


def test_qwen_adapter_never_exposes_provider_object_in_raw_results(tmp_path) -> None:
    class FakeModel:
        def transcribe(self, **_kwargs):
            return ASRTranscription()

    engine = Qwen3ASREngine(model_name="demo", model_dir=str(tmp_path), device="cpu")
    engine._model = FakeModel()

    result = engine._run_inference(make_wav_bytes(0.1), EngineOptions(language="zh"))

    assert result.full_text == "宝宝，能不能听到我说话呢？"
    assert result.raw["result"] == {"text": result.full_text, "language": "Chinese"}
    json.dumps(result.raw, ensure_ascii=False)


@pytest.mark.asyncio
async def test_create_transcript_serializes_third_party_qwen_result() -> None:
    class FakeSession:
        def add(self, _value):
            return None

        async def flush(self):
            return None

        async def refresh(self, _value):
            return None

    transcript = await create_transcript(
        FakeSession(),
        task_id="qwen-task",
        full_text="宝宝，能不能听到我说话呢？",
        raw_results={"result": ASRTranscription()},
    )

    assert json.loads(transcript.raw_results or "{}")["result"]["text"] == "宝宝，能不能听到我说话呢？"
