from __future__ import annotations

import json

import httpx
import pytest

from app.core import llm
from app.schemas.llm import (
    ArchiveSummaryRequest,
    LLMChatRequest,
    LLMModelsRequest,
    LLMProcessRequest,
    LLMSpeechRequest,
)


@pytest.mark.parametrize("path", [
    "/anthropic", "/anthropic/", "/anthropic/v1/messages",
    "/anthropic/v1/messages/", "/v1/messages", "/v1/messages/",
])
def test_official_deepseek_anthropic_urls_use_openai_routes(path):
    base = f"https://api.deepseek.com{path}"
    assert llm._chat_completions_url(base, "deepseek") == "https://api.deepseek.com/chat/completions"
    assert llm._models_url(base, "deepseek") == "https://api.deepseek.com/models"


@pytest.mark.parametrize("provider,base", [
    ("deepseek", "https://gateway.test/anthropic"),
    ("deepseek", "https://api.deepseek.com.gateway.test/anthropic"),
    ("deepseek", "https://api.deepseek.com/custom/anthropic"),
    ("deepseek", "https://api.deepseek.com/anthropic/unknown"),
    ("deepseek", "https://api.deepseek.com/anthropic?project=abc"),
    ("deepseek", "https://api.deepseek.com/anthropic#fragment"),
    ("deepseek", "https://api.deepseek.com:8443/anthropic"),
    ("deepseek", "http://api.deepseek.com/anthropic"),
    ("deepseek", "https://username@api.deepseek.com/anthropic"),
    ("custom", "https://api.deepseek.com/anthropic"),
    ("openai", "https://api.deepseek.com/anthropic"),
    (None, "https://api.deepseek.com/anthropic"),
])
def test_unrelated_providers_hosts_and_unknown_paths_are_not_rewritten(provider, base):
    assert llm._openai_base_url(base, provider) == base
    assert llm._chat_completions_url(base, provider) == base.rstrip("/") + "/chat/completions"


def test_model_list_preserves_third_party_v1_root_and_existing_openai_routes():
    assert llm._models_url("https://gateway.test/v1", "deepseek") == "https://gateway.test/v1/models"
    assert llm._models_url("https://api.deepseek.com/custom/v1", "deepseek") == (
        "https://api.deepseek.com/custom/v1/models"
    )
    assert llm._models_url("https://api.deepseek.com/v1", "deepseek") == "https://api.deepseek.com/models"
    assert llm._models_url("https://api.deepseek.com/v1", "custom") == "https://api.deepseek.com/v1/models"
    assert llm._chat_completions_url("https://api.deepseek.com/v1", "deepseek") == (
        "https://api.deepseek.com/v1/chat/completions"
    )
    assert llm._chat_completions_url("https://gateway.test/v1/chat/completions", "custom") == (
        "https://gateway.test/v1/chat/completions"
    )


@pytest.fixture
def provider_transport(monkeypatch):
    calls: list[httpx.Request] = []

    def handle(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": "fixture-model"}]})
        body = json.loads(request.content)
        if request.url.path.endswith("/audio/speech"):
            return httpx.Response(200, content=b"fixture-audio", headers={"content-type": "audio/mpeg"})
        if body.get("stream"):
            return httpx.Response(200, text=(
                'data: {"choices":[{"delta":{"content":"fixture response"}}]}\n\n'
                'data: [DONE]\n\n'
            ), headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "fixture response"}}]})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs))
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", [
    "models", "process", "chat", "chat_stream", "summary", "summary_stream", "auto", "speech",
])
async def test_every_openai_transport_uses_adapted_url_without_changing_credentials_or_model(
    operation, provider_transport,
):
    config = {
        "provider": "deepseek", "base_url": "https://api.deepseek.com/anthropic/",
        "api_token": "fixture-token", "model": "fixture-model",
    }
    expected_path = "/chat/completions"
    if operation == "models":
        expected_path = "/models"
        result = await llm.list_provider_models(LLMModelsRequest(**{k: v for k, v in config.items() if k != "model"}))
        assert result.connected is True
        assert result.models == ["fixture-model"]
        assert result.base_url == config["base_url"]
    elif operation == "process":
        result = await llm.process_text(LLMProcessRequest(text="测试", operation="polish", **config))
        assert result.text == "fixture response"
    elif operation in {"chat", "chat_stream"}:
        request = LLMChatRequest(messages=[{"role": "user", "content": "测试"}], **config)
        if operation == "chat":
            result = await llm.chat(request)
            assert result.message.content == "fixture response"
        else:
            events = [event async for event in llm.chat_stream(request)]
            assert events[-1]["result"]["message"]["content"] == "fixture response"
    elif operation in {"summary", "summary_stream"}:
        request = ArchiveSummaryRequest(date="2026-10-06", records=[{
            "text": "测试记录", "started_at": "2026-10-06T09:10:00+08:00",
            "ended_at": "2026-10-06T09:11:00+08:00",
        }], **config)
        if operation == "summary":
            result = await llm.summarize_archive(request)
            assert result.summary == "fixture response"
        else:
            events = [event async for event in llm.summarize_archive_stream(request)]
            assert events[-1]["result"]["summary"] == "fixture response"
    elif operation == "auto":
        outputs, error = await llm.run_auto_processing(
            text="测试", target_language="English", style=None,
            enable_polish=True, enable_translate=True, **config,
        )
        assert error is None
        assert set(outputs) == {"polish", "translate"}
    else:
        expected_path = "/audio/speech"
        content, media_type = await llm.synthesize_speech(LLMSpeechRequest(text="测试", **config))
        assert (content, media_type) == (b"fixture-audio", "audio/mpeg")

    assert provider_transport
    for request in provider_transport:
        assert str(request.url) == "https://api.deepseek.com" + expected_path
        assert request.headers["authorization"] == "Bearer fixture-token"
        assert request.headers["content-type"] == "application/json"
        if request.method == "POST":
            assert json.loads(request.content)["model"] == "fixture-model"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base", [
    ("custom", "https://api.deepseek.com/anthropic"),
    ("deepseek", "https://gateway.test/anthropic"),
    ("openai", "https://openai.test/v1"),
])
async def test_actual_request_keeps_other_provider_and_gateway_roots(provider, base, provider_transport):
    await llm.chat(LLMChatRequest(
        messages=[{"role": "user", "content": "测试"}], model="unchanged-model",
        api_token="unchanged-token", provider=provider, base_url=base,
    ))
    request = provider_transport[0]
    assert str(request.url) == base + "/chat/completions"
    assert request.headers["authorization"] == "Bearer unchanged-token"
    assert json.loads(request.content)["model"] == "unchanged-model"


@pytest.mark.asyncio
async def test_asr_automatic_polish_forwards_deepseek_provider(async_client, provider_transport):
    from backend.tests.conftest import make_wav_bytes

    response = await async_client.post(
        "/v1/transcribe", files={"file": ("test.wav", make_wav_bytes(1.0), "audio/wav")},
        data={"options": json.dumps({
            "engine": "mock", "enable_punctuation": False, "llm": {
                "enable_polish": True, "provider": "deepseek", "model": "fixture-model",
                "base_url": "https://api.deepseek.com/anthropic", "api_token": "fixture-token",
            },
        })},
    )
    assert response.status_code == 200, response.text
    assert response.json()["llm_outputs"]["polish"]["text"] == "fixture response"
    assert str(provider_transport[0].url) == "https://api.deepseek.com/chat/completions"
