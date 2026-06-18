"""
Orchestrator — the central coordinator for the voice assistant pipeline.

The Orchestrator is NOT an agent. It coordinates:
  1. Receive text input (or audio → ASR → text)
  2. Create task context
  3. Route to CLI agent via AgentRouter
  4. Collect and compress results
  5. Write to temporary memory
  6. Generate TTS feedback (MockTTS or GPT-SoVITS with audio output)
  7. Log the full trace

Supports two modes:
  - Text mode:  text → Agent → TTS text
  - Audio mode: audio → ASR → text → Agent → TTS → audio file
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from runner.agents.router import AgentRouter, detect_agent_from_text
from runner.core.config import ensure_runtime_dirs
from runner.core.task import AgentRunRequest, AgentRunResult, PipelineTiming
from runner.memory.compressor import compress_agent_result
from runner.memory.manager import MemoryManager
from runner.memory.temporary import write_timing
from runner.observability.logger import get_logger, log_orchestrator_run
from runner.asr.base import ASRProvider, ASRResult as ASROutput
from runner.asr.whisper_adapter import WhisperASR
from runner.tts.base import TTSResult
from runner.tts.manager import TTSManager
from runner.tts.style import VoiceSelection


@dataclass
class OrchestratorResult:
    """The complete result of an orchestrator run.

    Attributes:
        input_text: The original user text input.
        agent_result: Structured result from the CLI agent.
        compressed_summary: Context-compressed summary of the agent output.
        tts_result: The TTS feedback that would be spoken.
        voice_selection: The selected speech style/voice.
        total_duration_seconds: Wall-clock time for the entire pipeline.
        trace: Ordered list of step descriptions for observability.
    """

    input_text: str
    agent_result: AgentRunResult
    compressed_summary: str
    tts_result: TTSResult
    voice_selection: VoiceSelection | None = None
    total_duration_seconds: float = 0.0
    trace: list[str] = field(default_factory=list)
    detected_agent: str | None = None
    timing: PipelineTiming = field(default_factory=PipelineTiming)


class Orchestrator:
    """Coordinates the full text → agent → TTS pipeline.

    Usage::

        orch = Orchestrator()
        result = orch.run("分析项目结构")
        print(result.tts_result.text)
    """

    def __init__(
        self,
        router: AgentRouter | None = None,
        memory: MemoryManager | None = None,
        tts_manager: TTSManager | None = None,
    ) -> None:
        self.router = router or AgentRouter()
        self.memory = memory or MemoryManager()
        self.tts_manager = tts_manager or TTSManager()
        self.logger = get_logger()
        ensure_runtime_dirs()

    def run(self, text: str, agent_name: str | None = None) -> OrchestratorResult:
        """Run the full pipeline synchronously."""
        import asyncio

        return asyncio.run(self.run_async(text, agent_name=agent_name))

    async def run_async(self, text: str, agent_name: str | None = None) -> OrchestratorResult:
        """Run the full pipeline asynchronously.

        Args:
            text: The user's natural-language input.
            agent_name: Explicit agent override (takes precedence over text detection).

        Returns:
            OrchestratorResult with agent output, compressed summary, TTS, and voice style.
        """
        started = time.perf_counter()
        trace: list[str] = []
        timing = PipelineTiming(input_text=text)

        # Step 1: Validate input
        text = text.strip()
        if not text:
            raise ValueError("input text must not be blank")
        trace.append(f"Received input: {text[:100]}")

        # Step 1.5: Detect agent from text (only if not explicitly set)
        detected = detect_agent_from_text(text) if not agent_name else None
        effective_agent = agent_name or detected
        if effective_agent:
            trace.append(f"Agent preference: {effective_agent}" +
                         (" (from --agent)" if agent_name else " (detected from text)"))

        # Step 2: Create agent run request
        request = AgentRunRequest(task=text)
        if effective_agent:
            request.agent_name = effective_agent
        trace.append("Created AgentRunRequest")

        # Step 3: Route to agent (timed)
        trace.append("Routing to agent...")
        t_agent = time.perf_counter()
        agent_result = await self.router.route_async(request)
        timing.agent_duration = round(time.perf_counter() - t_agent, 3)
        timing.agent_name = agent_result.agent_name
        trace.append(
            f"Agent {agent_result.agent_name}: "
            f"{'success' if agent_result.success else 'failed'}, "
            f"available={agent_result.available}, "
            f"duration={timing.agent_duration}s"
        )

        # Step 4: Compress context (timed)
        trace.append("Compressing agent output...")
        t_comp = time.perf_counter()
        compressed = compress_agent_result(
            stdout=agent_result.stdout,
            stderr=agent_result.stderr,
            summary=agent_result.summary,
        )
        timing.compress_duration = round(time.perf_counter() - t_comp, 3)
        trace.append(f"Compressed to {len(compressed)} chars ({timing.compress_duration}s)")

        # Step 5: Write to temporary memory (timed)
        trace.append("Writing to temporary memory...")
        t_mem = time.perf_counter()
        is_fallback = agent_result.agent_name == "mock" and not any(
            agent_result.agent_name == a for a in self.router.available_agents()
        )
        self.memory.record_task_result(
            task=text,
            agent_name=agent_result.agent_name,
            success=agent_result.success,
            summary=compressed,
            duration_seconds=agent_result.duration_seconds,
            is_fallback=is_fallback,
            confidence=0.95 if agent_result.success else 0.5,
            ttl="P7D" if agent_result.agent_name == "mock" else None,
            retention="temporary",
        )

        if not agent_result.available and agent_result.agent_name != "mock":
            self.memory.record_agent_fallback(
                requested=request.agent_name or "auto",
                reason="Agent not available, fell back to mock",
            )

        timing.memory_write_duration = round(time.perf_counter() - t_mem, 3)
        trace.append(f"Memory write complete ({timing.memory_write_duration}s)")

        # Step 6: Generate TTS feedback with style selection (timed)
        trace.append("Generating TTS feedback with style selection...")
        t_tts = time.perf_counter()
        tts_text = self._build_tts_text(text, agent_result, compressed)
        tts_output = self.tts_manager.synthesize(
            text=tts_text,
            agent_success=agent_result.success,
            agent_available=agent_result.available,
            is_fallback=is_fallback,
            output_length=len(agent_result.stdout),
            needs_user_action=False,
        )
        tts_result = tts_output["tts_result"]
        voice_selection = tts_output["voice_selection"]
        timing.tts_duration = round(time.perf_counter() - t_tts, 3)
        timing.tts_provider = tts_result.provider
        trace.append(
            f"TTS: style={voice_selection.style.value}, "
            f"voice={voice_selection.voice}, "
            f"duration={timing.tts_duration}s"
        )

        # Step 7: Compute totals and persist
        timing.total_duration = round(time.perf_counter() - started, 3)
        stage_sum = (timing.agent_duration + timing.compress_duration +
                     timing.memory_write_duration + timing.tts_duration)
        timing.overhead_duration = round(max(0, timing.total_duration - stage_sum), 3)
        trace.append(
            f"Pipeline: total={timing.total_duration}s "
            f"agent={timing.agent_duration}s comp={timing.compress_duration}s "
            f"mem={timing.memory_write_duration}s tts={timing.tts_duration}s "
            f"overhead={timing.overhead_duration}s"
        )

        # Persist timing record
        write_timing(timing.to_dict())

        log_orchestrator_run(
            input_text=text,
            agent_name=agent_result.agent_name,
            success=agent_result.success,
            total_duration=timing.total_duration,
            tts_text=tts_result.text,
            voice_style=voice_selection.style.value if voice_selection else "unknown",
            trace=trace,
        )

        return OrchestratorResult(
            input_text=text,
            agent_result=agent_result,
            compressed_summary=compressed,
            tts_result=tts_result,
            voice_selection=voice_selection,
            total_duration_seconds=timing.total_duration,
            trace=trace,
            detected_agent=detected,
            timing=timing,
        )

    # ── Audio pipeline ──────────────────────────────────────────────────────────

    def run_audio(
        self,
        audio_path: str,
        agent_name: str | None = None,
        asr_provider: ASRProvider | None = None,
        use_real_tts: bool = False,
    ) -> OrchestratorResult:
        """Run the full audio → ASR → Agent → TTS pipeline.

        Args:
            audio_path: Path to an audio file (WAV, M4A, MP3, etc.).
            agent_name: Explicit agent override.
            asr_provider: ASR engine to use (defaults to WhisperASR).
            use_real_tts: If True, use GPT-SoVITS for real audio output.

        Returns:
            OrchestratorResult with ASR text, agent output, and TTS audio path.
        """
        import asyncio

        trace: list[str] = []
        started = time.perf_counter()

        # Step 1: ASR — speech to text (timed)
        trace.append(f"Transcribing audio: {audio_path}")
        t_asr = time.perf_counter()
        asr = asr_provider or WhisperASR()
        asr_result = asr.transcribe(audio_path)
        asr_duration = round(time.perf_counter() - t_asr, 3)
        text = asr_result.text.strip()
        trace.append(
            f"ASR ({asr.name}): \"{text[:100]}\" "
            f"(lang={asr_result.language}, conf={asr_result.confidence}, {asr_duration}s)"
        )

        if not text:
            # Empty transcription — still return result with error
            total_duration = round(time.perf_counter() - started, 3)
            trace.append(f"No speech detected in audio ({total_duration}s)")
            return OrchestratorResult(
                input_text="",
                agent_result=AgentRunResult(
                    agent_name="none",
                    success=False,
                    summary="No speech detected in audio",
                    duration_seconds=total_duration,
                ),
                compressed_summary="No speech detected",
                tts_result=TTSResult(text="", provider="mock", success=False, error="No speech"),
                total_duration_seconds=total_duration,
                trace=trace,
            )

        # Step 2-6: Reuse the existing text pipeline
        result = self.run(text, agent_name=agent_name)

        # Prepend ASR steps to trace, keep a reference to the unified trace
        result.trace = trace + result.trace
        result.total_duration_seconds = round(time.perf_counter() - started, 3)

        # Add ASR timing to the result
        result.timing.asr_duration = asr_duration
        result.timing.asr_engine = asr.name

        # If real TTS is requested, generate actual audio (timed)
        if use_real_tts:
            result.trace.append("Generating real TTS audio with GPT-SoVITS...")
            t_tts_real = time.perf_counter()
            try:
                from runner.tts.gpt_sovits import GPTSoVITSTTS
                from runner.tts.base import TTSRequest

                real_tts = GPTSoVITSTTS()
                tts_request = TTSRequest(text=result.tts_result.text[:500])
                real_result = real_tts.synthesize(tts_request)
                tts_real_dur = round(time.perf_counter() - t_tts_real, 3)
                if real_result.success and real_result.audio_path:
                    result.tts_result = real_result
                    result.timing.tts_duration = tts_real_dur
                    result.timing.tts_provider = real_result.provider
                    result.timing.output_audio_path = real_result.audio_path
                    result.trace.append(
                        f"TTS audio: {real_result.audio_path} "
                        f"({real_result.duration_seconds}s est., {tts_real_dur}s synthesis)"
                    )
                else:
                    result.trace.append(f"TTS audio failed: {real_result.error}, using text fallback")
            except Exception as e:
                result.trace.append(f"GPT-SoVITS error: {e}, using text fallback")

        result.timing.total_duration = result.total_duration_seconds
        stage_sum = (result.timing.asr_duration + result.timing.agent_duration +
                     result.timing.tts_duration)
        result.timing.overhead_duration = round(max(0, result.total_duration_seconds - stage_sum), 3)
        # Persist the full audio pipeline timing
        write_timing(result.timing.to_dict())

        return result

    def _build_tts_text(
        self,
        input_text: str,
        agent_result: AgentRunResult,
        compressed: str,
    ) -> str:
        """Build the text that TTS should speak.

        The TTS text varies based on:
        - Whether the agent succeeded
        - Whether a fallback was used
        - The nature of the task
        """
        if not agent_result.available and agent_result.agent_name != "mock":
            return (
                f"所有 CLI Agent 当前不可用，已使用内置模拟 Agent 处理您的请求："
                f"{input_text[:100]}。"
                f"执行结果：{compressed[:200]}"
            )

        if agent_result.success:
            if agent_result.agent_name == "mock":
                return (
                    f"使用模拟模式处理了您的请求：{input_text[:100]}。"
                    f"结果摘要：{compressed[:200]}"
                )
            else:
                return (
                    f"已通过 {agent_result.agent_name} 完成您的请求："
                    f"{input_text[:100]}。{compressed[:200]}"
                )
        else:
            return (
                f"处理您的请求时遇到问题：{input_text[:100]}。"
                f"{agent_result.summary[:200]}"
            )
