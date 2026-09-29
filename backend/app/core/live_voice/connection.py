"""Provider connection helpers. Credentials never leave the backend."""
import re


def endpoint(provider: str, values: dict[str, str]) -> tuple[str, dict[str, str]]:
    if provider != "qwen_audio":
        raise ValueError("Unsupported provider")
    workspace = values["DASHSCOPE_WORKSPACE_ID"]
    region = values.get("DASHSCOPE_REGION", "cn-beijing")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", workspace) or region not in {"cn-beijing", "ap-southeast-1"}:
        raise ValueError("Invalid workspace or region")
    return (f"wss://{workspace}.{region}.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.1-realtime-plus",
            {"Authorization": f"Bearer {values['DASHSCOPE_API_KEY']}"})


def setup_event(provider: str) -> dict:
    if provider != "qwen_audio":
        raise ValueError("Unsupported provider")
    return {"type": "session.update", "session": {
        "modalities": ["text", "audio"], "voice": "longanqian_v3.1",
        "instructions": "你是艾米斯。请用简短自然的中文回答。",
        "turn_detection": {"type": "smart_turn"},
    }}
