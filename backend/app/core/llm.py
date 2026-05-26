"""
app/core/llm.py
───────────────
OpenAI-compatible text post-processing client.
"""

from __future__ import annotations

import time

import httpx

from app.schemas.llm import LLMOperation, LLMProcessRequest, LLMTextResult


def _chat_completions_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/chat/completions"):
        return root
    return f"{root}/chat/completions"


def _prompt_for(request: LLMProcessRequest) -> tuple[str, str]:
    if request.operation == "polish":
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
    payload = {
        "model": request.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {request.api_token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            _chat_completions_url(request.base_url),
            json=payload,
            headers=headers,
        )
        response.raise_for_status()
        data = response.json()

    text = _extract_text(data)
    return LLMTextResult(
        operation=request.operation,
        text=text,
        model=request.model,
        elapsed_sec=time.perf_counter() - started,
    )


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
                )
            )
        except Exception as exc:
            errors.append(f"{operation}: {exc}")
    return outputs, "; ".join(errors) if errors else None


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
