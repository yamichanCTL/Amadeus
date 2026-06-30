"""
app/core/llm.py
───────────────
OpenAI-compatible text post-processing client.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator

import httpx

from app.core.archive import build_summary_transcript
from app.schemas.llm import (
    ArchiveSummaryRequest,
    ArchiveSummaryResult,
    LLMChatMessage,
    LLMChatRequest,
    LLMChatResult,
    LLMModelsRequest,
    LLMModelsResult,
    LLMOperation,
    LLMProcessRequest,
    LLMTextResult,
    LLMSpeechRequest,
)


def _chat_completions_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/chat/completions"):
        return root
    return f"{root}/chat/completions"


def _models_url(base_url: str, provider: str | None = None) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/chat/completions"):
        root = root.removesuffix("/chat/completions")
    if provider == "deepseek" and root.endswith("/v1"):
        root = root.removesuffix("/v1")
    if root.endswith("/models"):
        return root
    return f"{root}/models"


def _audio_speech_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/audio/speech"):
        return root
    if root.endswith("/chat/completions"):
        root = root.removesuffix("/chat/completions")
    return f"{root}/audio/speech"


def _prompt_for(request: LLMProcessRequest) -> tuple[str, str]:
    if request.operation == "polish":
        custom_prompt = (request.prompt or "").strip()
        if custom_prompt:
            return (
                "You are a professional transcript editor. Return only the revised text.",
                f"{custom_prompt}\n\n原始离线语音识别结果：\n{request.text}",
            )
        style = request.style or "clean, natural, and faithful to the original meaning"
        return (
            "You are a professional transcript editor. Return only the revised text.",
            (
                "Polish the following speech transcript. Fix punctuation, wording, "
                f"and readability in a {style} style. Do not add new facts.\n\n"
                f"{request.text}"
            ),
        )

    target = request.target_language or "English"
    return (
        "You are a professional translator. Return only the translated text.",
        (
            f"Translate the following speech transcript into {target}. Preserve names, "
            "numbers, and formatting where possible. Do not add commentary.\n\n"
            f"{request.text}"
        ),
    )


async def process_text(request: LLMProcessRequest) -> LLMTextResult:
    started = time.perf_counter()
    system_prompt, user_prompt = _prompt_for(request)
    text = await _chat_completion(
        model=request.model,
        base_url=request.base_url,
        api_token=request.api_token,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        temperature=0.2,
        timeout=60.0,
    )
    return LLMTextResult(
        operation=request.operation,
        text=text,
        model=request.model,
        elapsed_sec=time.perf_counter() - started,
    )


async def chat(request: LLMChatRequest) -> LLMChatResult:
    started = time.perf_counter()
    text = await _chat_completion_messages(
        model=request.model,
        base_url=request.base_url,
        api_token=request.api_token,
        messages=[message.model_dump() for message in request.messages],
        temperature=request.temperature,
        timeout=90.0,
    )
    return LLMChatResult(
        message=LLMChatMessage(role="assistant", content=text),
        model=request.model,
        provider=request.provider,
        elapsed_sec=time.perf_counter() - started,
    )


async def chat_stream(request: LLMChatRequest) -> AsyncIterator[dict]:
    started = time.perf_counter()
    parts: list[str] = []
    async for delta in _chat_completion_messages_stream(
        model=request.model,
        base_url=request.base_url,
        api_token=request.api_token,
        messages=[message.model_dump() for message in request.messages],
        temperature=request.temperature,
        timeout=90.0,
    ):
        parts.append(delta)
        yield {"type": "delta", "text": delta}

    result = LLMChatResult(
        message=LLMChatMessage(role="assistant", content="".join(parts).strip()),
        model=request.model,
        provider=request.provider,
        elapsed_sec=time.perf_counter() - started,
    )
    yield {"type": "done", "result": result.model_dump(mode="json")}


async def run_auto_processing(
    *,
    text: str,
    model: str | None,
    base_url: str | None,
    api_token: str | None,
    target_language: str,
    style: str | None,
    enable_polish: bool,
    enable_translate: bool,
    prompt: str | None = None,
) -> tuple[dict[LLMOperation, LLMTextResult], str | None]:
    if not text.strip() or not model or not base_url or not api_token:
        return {}, None

    outputs: dict[LLMOperation, LLMTextResult] = {}
    errors: list[str] = []
    for operation, enabled in (("polish", enable_polish), ("translate", enable_translate)):
        if not enabled:
            continue
        try:
            outputs[operation] = await process_text(
                LLMProcessRequest(
                    text=text,
                    operation=operation,
                    model=model,
                    base_url=base_url,
                    api_token=api_token,
                    target_language=target_language,
                    style=style,
                    prompt=prompt if operation == "polish" else None,
                )
            )
        except Exception as exc:
            errors.append(f"{operation}: {exc}")
    return outputs, "; ".join(errors) if errors else None


async def list_provider_models(request: LLMModelsRequest) -> LLMModelsResult:
    started = time.perf_counter()
    headers = {
        "Authorization": f"Bearer {request.api_token}",
        "Content-Type": "application/json",
    }
    url = _models_url(request.base_url, request.provider)
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(url, headers=headers)
        data = response.json() if response.content else {}
        if response.status_code >= 400:
            return LLMModelsResult(
                connected=False,
                models=[],
                provider=request.provider,
                base_url=request.base_url,
                status_code=response.status_code,
                message=_provider_error_message(data) or response.reason_phrase,
                elapsed_sec=time.perf_counter() - started,
            )
        models = _extract_model_ids(data)
        return LLMModelsResult(
            connected=True,
            models=models,
            provider=request.provider,
            base_url=request.base_url,
            status_code=response.status_code,
            message=f"连接成功，发现 {len(models)} 个模型",
            elapsed_sec=time.perf_counter() - started,
        )
    except httpx.HTTPError as exc:
        return LLMModelsResult(
            connected=False,
            models=[],
            provider=request.provider,
            base_url=request.base_url,
            message=str(exc),
            elapsed_sec=time.perf_counter() - started,
        )
    except ValueError as exc:
        return LLMModelsResult(
            connected=False,
            models=[],
            provider=request.provider,
            base_url=request.base_url,
            message=f"模型列表响应不是有效 JSON: {exc}",
            elapsed_sec=time.perf_counter() - started,
        )


async def synthesize_speech(request: LLMSpeechRequest) -> tuple[bytes, str]:
    payload = {
        "model": request.model,
        "input": request.text,
        "voice": request.voice,
        "response_format": request.response_format,
        "speed": request.speed,
    }
    headers = {
        "Authorization": f"Bearer {request.api_token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            _audio_speech_url(request.base_url),
            json=payload,
            headers=headers,
        )
        response.raise_for_status()
    content_type = response.headers.get("content-type") or _speech_media_type(request.response_format)
    return response.content, content_type


def _speech_media_type(response_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "wav": "audio/wav",
        "pcm": "application/octet-stream",
    }.get(response_format, "application/octet-stream")


async def summarize_archive(request: ArchiveSummaryRequest) -> ArchiveSummaryResult:
    started = time.perf_counter()
    transcript, source_count, input_chars, truncated = _summary_transcript(request)
    if not transcript.strip():
        return ArchiveSummaryResult(
            summary="未找到可总结的 ASR 文本。",
            model=request.model,
            provider=request.provider,
            elapsed_sec=time.perf_counter() - started,
            source_count=0,
            input_chars=0,
            estimated_input_tokens=0,
            chunk_count=0,
            truncated=False,
            date=request.date,
            time_range=_time_range_label(request.start_time, request.end_time),
        )

    chunks = _split_text(transcript, max_chars=min(request.max_input_chars, 18000))
    chunk_summaries: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        if len(chunks) == 1:
            chunk_summaries.append(chunk)
            continue
        chunk_summaries.append(
            await _chat_completion(
                model=request.model,
                base_url=request.base_url,
                api_token=request.api_token,
                system_prompt=(
                    "你是严谨的 ASR 记录压缩助手。只依据输入内容提炼事实，"
                    "不要补充未出现的信息。"
                ),
                user_prompt=(
                    f"下面是第 {index}/{len(chunks)} 段按时间排序的 ASR 文本。"
                    "请压缩为不超过 900 字的中文要点，保留人物、事项、决定、待办和关键时间。\n\n"
                    f"{chunk}"
                ),
                temperature=0.1,
                timeout=90.0,
            )
        )

    final_input = "\n\n".join(chunk_summaries)
    summary = await _chat_completion(
        model=request.model,
        base_url=request.base_url,
        api_token=request.api_token,
        system_prompt=(
            "你是专业的中文语音记录总结助手。只根据 ASR 文本总结，"
            "文本可能有识别错误，要谨慎表达不确定内容。"
        ),
        user_prompt=_summary_user_prompt(request, final_input),
        temperature=0.2,
        timeout=120.0,
    )
    return ArchiveSummaryResult(
        summary=summary,
        model=request.model,
        provider=request.provider,
        elapsed_sec=time.perf_counter() - started,
        source_count=source_count,
        input_chars=input_chars,
        estimated_input_tokens=_estimate_tokens(transcript),
        chunk_count=len(chunks),
        truncated=truncated,
        date=request.date,
        time_range=_time_range_label(request.start_time, request.end_time),
    )


async def summarize_archive_stream(request: ArchiveSummaryRequest) -> AsyncIterator[dict]:
    started = time.perf_counter()
    transcript, source_count, input_chars, truncated = _summary_transcript(request)
    meta = {
        "source_count": source_count,
        "input_chars": input_chars,
        "estimated_input_tokens": _estimate_tokens(transcript) if transcript.strip() else 0,
        "date": request.date,
        "time_range": _time_range_label(request.start_time, request.end_time),
    }
    yield {"type": "meta", **meta}

    if not transcript.strip():
        result = ArchiveSummaryResult(
            summary="未找到可总结的 ASR 文本。",
            model=request.model,
            provider=request.provider,
            elapsed_sec=time.perf_counter() - started,
            source_count=0,
            input_chars=0,
            estimated_input_tokens=0,
            chunk_count=0,
            truncated=False,
            date=request.date,
            time_range=_time_range_label(request.start_time, request.end_time),
        )
        yield {"type": "delta", "text": result.summary}
        yield {"type": "done", "result": result.model_dump(mode="json")}
        return

    chunks = _split_text(transcript, max_chars=min(request.max_input_chars, 18000))
    chunk_summaries: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        if len(chunks) == 1:
            chunk_summaries.append(chunk)
            continue
        yield {"type": "status", "message": f"压缩第 {index}/{len(chunks)} 段记录"}
        chunk_summaries.append(
            await _chat_completion(
                model=request.model,
                base_url=request.base_url,
                api_token=request.api_token,
                system_prompt=(
                    "你是严谨的 ASR 记录压缩助手。只依据输入内容提炼事实，"
                    "不要补充未出现的信息。"
                ),
                user_prompt=(
                    f"第 {index}/{len(chunks)} 段 ASR 文本已只保留时间戳和文本。"
                    "压缩为不超过 900 字中文要点，保留事项、决定、待办和关键时间。\n\n"
                    f"{chunk}"
                ),
                temperature=0.1,
                timeout=90.0,
            )
        )

    final_input = "\n\n".join(chunk_summaries)
    summary_parts: list[str] = []
    yield {"type": "status", "message": "大模型生成总结中"}
    async for delta in _chat_completion_stream(
        model=request.model,
        base_url=request.base_url,
        api_token=request.api_token,
        system_prompt=(
            "你是专业的中文语音记录总结助手。只根据输入的时间戳和 ASR 文本总结，"
            "谨慎处理识别错误。"
        ),
        user_prompt=_summary_user_prompt(request, final_input),
        temperature=0.2,
        timeout=120.0,
    ):
        summary_parts.append(delta)
        yield {"type": "delta", "text": delta}

    result = ArchiveSummaryResult(
        summary="".join(summary_parts).strip(),
        model=request.model,
        provider=request.provider,
        elapsed_sec=time.perf_counter() - started,
        source_count=source_count,
        input_chars=input_chars,
        estimated_input_tokens=_estimate_tokens(transcript),
        chunk_count=len(chunks),
        truncated=truncated,
        date=request.date,
        time_range=_time_range_label(request.start_time, request.end_time),
    )
    yield {"type": "done", "result": result.model_dump(mode="json")}


def _summary_transcript(request: ArchiveSummaryRequest) -> tuple[str, int, int, bool]:
    return build_summary_transcript(
        user_id=request.user_id,
        date=request.date,
        category=request.category,
        start_time=request.start_time,
        end_time=request.end_time,
        max_chars=request.max_input_chars,
    )


def _summary_user_prompt(request: ArchiveSummaryRequest, final_input: str) -> str:
    prompt = (request.prompt or request.style or "").strip() or "请总结下面时间段内我说过的内容。"
    return (
        f"Prompt：{prompt}\n\n"
        f"时间范围：{request.date} {_time_range_label(request.start_time, request.end_time) or '全天'}。\n"
        "下面只包含时间戳和 ASR 文本。请严格围绕 Prompt 回答，输出 Markdown：\n"
        "## 总览\n## 关键要点\n## 决定与待办\n## 时间线\n"
        "如果没有决定或待办，写“无”。\n\nASR：\n"
        f"{final_input}"
    )


def _extract_text(data: object) -> str:
    if not isinstance(data, dict):
        raise ValueError("LLM response is not a JSON object")
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("LLM response missing choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise ValueError("LLM response choice is invalid")
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"].strip()
    if isinstance(first.get("text"), str):
        return first["text"].strip()
    raise ValueError("LLM response missing text content")


def _extract_model_ids(data: object) -> list[str]:
    if not isinstance(data, dict):
        return []
    raw_models = data.get("data")
    if not isinstance(raw_models, list):
        raw_models = data.get("models")
    if not isinstance(raw_models, list):
        return []
    model_ids: list[str] = []
    for item in raw_models:
        if isinstance(item, str):
            model_ids.append(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str):
            model_ids.append(item["id"])
        elif isinstance(item, dict) and isinstance(item.get("name"), str):
            model_ids.append(item["name"])
    return sorted(dict.fromkeys(model_ids))


def _provider_error_message(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("msg")
        return str(message) if message else None
    if isinstance(error, str):
        return error
    message = data.get("message") or data.get("msg")
    return str(message) if message else None


async def _chat_completion(
    *,
    model: str,
    base_url: str,
    api_token: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    timeout: float,
) -> str:
    return await _chat_completion_messages(
        model=model,
        base_url=base_url,
        api_token=api_token,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
        timeout=timeout,
    )


async def _chat_completion_messages(
    *,
    model: str,
    base_url: str,
    api_token: str,
    messages: list[dict[str, str]],
    temperature: float,
    timeout: float,
) -> str:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            _chat_completions_url(base_url),
            json=payload,
            headers=headers,
        )
        response.raise_for_status()
        data = response.json()

    return _extract_text(data)


async def _chat_completion_stream(
    *,
    model: str,
    base_url: str,
    api_token: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    timeout: float,
) -> AsyncIterator[str]:
    async for delta in _chat_completion_messages_stream(
        model=model,
        base_url=base_url,
        api_token=api_token,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
        timeout=timeout,
    ):
        yield delta


async def _chat_completion_messages_stream(
    *,
    model: str,
    base_url: str,
    api_token: str,
    messages: list[dict[str, str]],
    temperature: float,
    timeout: float,
) -> AsyncIterator[str]:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            _chat_completions_url(base_url),
            json=payload,
            headers=headers,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                delta = _extract_stream_delta(line)
                if delta is None:
                    continue
                if delta == "":
                    break
                yield delta


def _extract_stream_delta(line: str) -> str | None:
    raw = line.strip()
    if not raw:
        return None
    if raw.startswith("data:"):
        raw = raw[5:].strip()
    if raw == "[DONE]":
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    first = choices[0]
    delta = first.get("delta")
    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
        return delta["content"]
    if isinstance(first.get("text"), str):
        return first["text"]
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    return None


def _split_text(text: str, *, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    current: list[str] = []
    current_size = 0
    for line in text.splitlines():
        line_size = len(line) + 1
        if current and current_size + line_size > max_chars:
            chunks.append("\n".join(current))
            current = []
            current_size = 0
        current.append(line)
        current_size += line_size
    if current:
        chunks.append("\n".join(current))
    return chunks


def _estimate_tokens(text: str) -> int:
    # Rough mixed Chinese/English estimate for display and safeguards only.
    return max(1, int(len(text) / 1.8))


def _time_range_label(start_time: str | None, end_time: str | None) -> str | None:
    if start_time and end_time:
        return f"{start_time}-{end_time}"
    if start_time:
        return f"{start_time} 之后"
    if end_time:
        return f"{end_time} 之前"
    return None
