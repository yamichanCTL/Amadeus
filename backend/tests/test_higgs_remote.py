import json
import urllib.request

from app.api.v1.tts_api import (
    HiggsTTSRequest,
    _build_higgs_payload,
    _higgs_audio_request,
    _higgs_auth_headers,
    _higgs_speech_url,
)


def test_boson_payload_matches_public_api_shape() -> None:
    request = HiggsTTSRequest(
        text="你好",
        provider="boson",
        api_token="secret-token",
        higgs_base_url="https://api.boson.ai/v1",
        model="higgs-audio-v3-tts",
        voice="default",
        response_format="pcm",
        stream=True,
        reference_url="https://example.test/reference.wav",
        reference_text="参考文本",
    )
    payload = _build_higgs_payload(request)
    assert payload == {
        "model": "higgs-audio-v3-tts",
        "input": "你好",
        "voice": "default",
        "response_format": "pcm",
        "stream": True,
        "ref_audio": "https://example.test/reference.wav",
        "ref_text": "参考文本",
    }
    assert "secret-token" not in str(payload)


def test_boson_url_and_authorization_header() -> None:
    assert _higgs_speech_url("https://api.boson.ai/v1") == "https://api.boson.ai/v1/audio/speech"
    assert _higgs_speech_url("http://localhost:8002") == "http://localhost:8002/v1/audio/speech"
    headers = _higgs_auth_headers("secret-token")
    assert headers["Authorization"] == "Bearer secret-token"


def test_local_payload_keeps_local_reference_shape() -> None:
    payload = _build_higgs_payload(HiggsTTSRequest(
        text="本地合成",
        provider="local",
        reference_url="file:///tmp/ref.wav",
        reference_text="参考",
    ))
    assert payload["input"] == "本地合成"
    assert payload["references"] == [{"audio_path": "file:///tmp/ref.wav", "text": "参考"}]
    assert "model" not in payload


def test_audio_proxy_forwards_boson_auth_without_putting_token_in_body(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        headers = {"Content-Type": "audio/pcm", "X-Sample-Rate": "24000"}
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return b"\x01\x00\x02\x00"

    class FakeOpener:
        def open(self, request: urllib.request.Request, timeout: float):
            captured.update(
                path=request.full_url,
                authorization=request.get_header("Authorization"),
                body=json.loads(request.data or b"{}"),
            )
            return FakeResponse()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: FakeOpener())
    request = HiggsTTSRequest(text="远程代理", provider="boson", api_token="secret-token", stream=True)
    audio, media_type, headers = _higgs_audio_request(
        _build_higgs_payload(request),
        "https://api.boson.ai/v1",
        api_token=request.api_token,
    )
    assert audio == b"\x01\x00\x02\x00"
    assert media_type == "audio/pcm"
    assert headers["x-sample-rate"] == "24000"
    assert captured["path"] == "https://api.boson.ai/v1/audio/speech"
    assert captured["authorization"] == "Bearer secret-token"
    assert "secret-token" not in json.dumps(captured["body"], ensure_ascii=False)
