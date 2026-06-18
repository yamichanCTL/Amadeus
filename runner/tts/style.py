"""
TTS style selection — chooses speech style based on agent execution context.

Determines how the system speaks to the user:
- success_summary: Short, positive summary of what was done
- error_brief: Brief error message, reassuring tone
- need_user_action: Asks user to confirm or take action
- long_result_briefing: Compressed briefing for long results
- fallback_notice: Informs user that fallback mode was used
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class SpeechStyle(str, Enum):
    """The speech style / tone for TTS output."""

    SUCCESS_SUMMARY = "success_summary"
    ERROR_BRIEF = "error_brief"
    NEED_USER_ACTION = "need_user_action"
    LONG_RESULT_BRIEFING = "long_result_briefing"
    FALLBACK_NOTICE = "fallback_notice"


@dataclass
class VoiceSelection:
    """Selected voice parameters for TTS output."""

    style: SpeechStyle
    voice: str = "default"
    speed: float = 1.0
    language: str = "zh"
    voice_description: str = ""

    @property
    def display_name(self) -> str:
        names: dict[SpeechStyle, str] = {
            SpeechStyle.SUCCESS_SUMMARY: "成功汇报",
            SpeechStyle.ERROR_BRIEF: "错误提示",
            SpeechStyle.NEED_USER_ACTION: "需要操作",
            SpeechStyle.LONG_RESULT_BRIEFING: "长结果摘要",
            SpeechStyle.FALLBACK_NOTICE: "降级通知",
        }
        return names.get(self.style, self.style.value)


class VoiceSelector:
    """Selects speech style based on agent run context.

    Selection rules (in priority order):
    1. CLI unavailable / fallback → fallback_notice
    2. Agent failure → error_brief
    3. Output too long → long_result_briefing
    4. Need user confirmation → need_user_action
    5. Agent success → success_summary
    """

    # Characters threshold for "long output"
    LONG_OUTPUT_THRESHOLD: int = 1000

    def select(
        self,
        agent_success: bool,
        agent_available: bool,
        is_fallback: bool,
        output_length: int = 0,
        needs_user_action: bool = False,
    ) -> VoiceSelection:
        """Select the appropriate voice style.

        Args:
            agent_success: Whether the agent completed successfully.
            agent_available: Whether the agent binary was found.
            is_fallback: Whether MockAgent fallback was used.
            output_length: Length of agent output in characters.
            needs_user_action: Whether user confirmation is needed.

        Returns:
            VoiceSelection with style, voice, and speed.
        """
        # Rule 1: CLI unavailable fallback
        if is_fallback or not agent_available:
            return VoiceSelection(
                style=SpeechStyle.FALLBACK_NOTICE,
                voice="calm",
                speed=0.95,
                voice_description="降级模式 — 使用模拟 Agent",
            )

        # Rule 2: Agent failure
        if not agent_success:
            return VoiceSelection(
                style=SpeechStyle.ERROR_BRIEF,
                voice="concerned",
                speed=1.0,
                voice_description="执行失败 — 简短错误提示",
            )

        # Rule 3: Long output
        if output_length > self.LONG_OUTPUT_THRESHOLD:
            return VoiceSelection(
                style=SpeechStyle.LONG_RESULT_BRIEFING,
                voice="neutral",
                speed=1.1,
                voice_description="长结果摘要 — 略快语速",
            )

        # Rule 4: Need user action
        if needs_user_action:
            return VoiceSelection(
                style=SpeechStyle.NEED_USER_ACTION,
                voice="focused",
                speed=0.9,
                voice_description="需要用户操作或确认",
            )

        # Rule 5: Default success
        return VoiceSelection(
            style=SpeechStyle.SUCCESS_SUMMARY,
            voice="happy",
            speed=1.0,
            voice_description="成功汇报",
        )
