"""
Demo: Text → Agent → TTS minimum closed-loop.

Usage:
    python -m runner.demo.text_to_agent_to_tts_demo "分析项目结构"

This demo verifies the complete phase 1 pipeline:
    1. Text input
    2. Orchestrator
    3. AgentRouter → CLI Agent (or MockAgent fallback)
    4. Context Compression
    5. Temporary Memory (JSONL)
    6. Mock TTS feedback
    7. Structured logging
"""

from __future__ import annotations

import sys
from argparse import ArgumentParser, RawDescriptionHelpFormatter

from runner import __version__
from runner.agents.router import AgentRouter, detect_agent_from_text
from runner.core.orchestrator import Orchestrator
from runner.skills.executor import FunctionExecutor
from runner.skills.base import SkillCall


def build_parser() -> ArgumentParser:
    """Build the CLI argument parser."""
    parser = ArgumentParser(
        prog="python -m runner.demo.text_to_agent_to_tts_demo",
        description="Run the runner text→agent→TTS minimum closed-loop demo.",
        formatter_class=RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m runner.demo.text_to_agent_to_tts_demo "分析项目结构"
  python -m runner.demo.text_to_agent_to_tts_demo --dry-run "列出所有 Python 文件"
  python -m runner.demo.text_to_agent_to_tts_demo --agent codex "帮我重构这段代码"
  python -m runner.demo.text_to_agent_to_tts_demo --list-agents
        """,
    )
    parser.add_argument(
        "task",
        nargs="?",
        help="The task description for the agent to execute.",
    )
    parser.add_argument(
        "--agent",
        "-a",
        default=None,
        help="Preferred agent: codex, claude_code, opencode, mock",
    )
    parser.add_argument(
        "--list-agents",
        action="store_true",
        help="List available agents and exit.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check availability and show what would run, without executing.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Agent timeout in seconds (default: 300).",
    )
    parser.add_argument(
        "--audio",
        default=None,
        help="Audio file path for voice input (WAV, M4A, MP3). Enables ASR → Agent → TTS pipeline.",
    )
    parser.add_argument(
        "--real-tts",
        action="store_true",
        help="Use GPT-SoVITS for real audio output (not just mock text).",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"runner {__version__}",
    )
    return parser


def list_agents(router: AgentRouter) -> None:
    """Print available agents."""
    available = router.available_agents()
    all_agents = router.all_agents()

    print("=" * 60)
    print("  ASRAPP Agent Status")
    print("=" * 60)
    for name in all_agents:
        status = "✓ AVAILABLE" if name in available or name == "mock" else "✗ not found"
        marker = " (always)" if name == "mock" else ""
        print(f"  {name:<20} {status}{marker}")
    print("=" * 60)
    if not available:
        print("  No real CLI agents found. System will use MockAgent fallback.")
        print("  Install one of: codex, claude (Claude Code), or opencode.")
    print()


def run_demo(
    task: str,
    agent_name: str | None = None,
    dry_run: bool = False,
    timeout: int = 300,
    audio_path: str | None = None,
    real_tts: bool = False,
) -> None:
    """Run the full text→agent→TTS demo pipeline."""
    print("=" * 60)
    print("  ASRAPP Phase 1 Demo: Text → Agent → TTS")
    print("=" * 60)

    # Detect agent from text first
    detected = detect_agent_from_text(task)
    effective_agent = agent_name or detected or "auto (priority: Claude Code → Codex → OpenCode)"

    print(f"  Task:       {task}")
    print(f"  Agent:      {effective_agent}")
    if detected and not agent_name:
        print(f"              (detected '{detected}' from task text)")
    print(f"  Dry run:    {dry_run}")
    print(f"  Timeout:    {timeout}s")
    print("=" * 60)
    print()

    # Initialize
    router = AgentRouter()
    orch = Orchestrator(router=router)

    # Show agent availability
    available = router.available_agents()
    print("--- Agent Availability ---")
    for name in router.all_agents():
        if name == "mock":
            print(f"  {name:<15} ✓ always available (fallback)")
        elif name in available:
            print(f"  {name:<15} ✓ available")
        else:
            print(f"  {name:<15} ✗ not found on PATH")
    print()

    if not available:
        print("[!] No real CLI agents found. Will fall back to MockAgent.")
        print()

    # ── Audio mode ──────────────────────────────────────────────────────────────
    if audio_path:
        print(f"--- Audio Mode: {audio_path} ---")
        print()
        result = orch.run_audio(
            audio_path=audio_path,
            agent_name=agent_name,
            use_real_tts=real_tts,
        )
        # Show ASR result
        print("--- ASR Transcription ---")
        # Text is in result.input_text (set by run_audio)
        asr_text = result.input_text
        print(f"  Text:   \"{asr_text[:200]}\"")
        print()

        # Show agent result
        print("--- Agent Result ---")
        ar = result.agent_result
        print(f"  Agent:  {ar.agent_name}")
        print(f"  Success: {ar.success}")
        print(f"  Output:  {ar.summary[:200]}")
        print()

        # Show TTS result
        print("--- TTS Output ---")
        print(f"  Provider:    {result.tts_result.provider}")
        print(f"  Audio path:  {result.tts_result.audio_path or '(null)'}")
        print(f"  Text:        {result.tts_result.text[:200]}")
        print()

        print("--- Trace ---")
        for i, step in enumerate(result.trace, 1):
            print(f"  {i}. {step}")
        print()

        print(f"Total duration: {result.total_duration_seconds}s")
        return

    if dry_run:
        print("--- Dry Run ---")
        from runner.core.task import AgentRunRequest
        import asyncio

        req = AgentRunRequest(
            task=task,
            agent_name=agent_name or detected,
            timeout_seconds=timeout,
            dry_run=True,
        )
        result = asyncio.run(router.route_async(req))
        print(f"  Would use:   {result.agent_name}")
        print(f"  Available:   {result.available}")
        print(f"  Command:     {' '.join(str(c) for c in result.command)}")
        print()
        return

    # Run the pipeline
    print("--- Running Pipeline ---")
    result = orch.run(task, agent_name=agent_name)

    # Print results
    print()
    print("=" * 60)
    print("  Pipeline Results")
    print("=" * 60)

    ar = result.agent_result
    print(f"  Detected:    {result.detected_agent or 'none (auto-routed)'}")
    print(f"  Agent used:  {ar.agent_name}")
    print(f"  Available:   {ar.available}")
    print(f"  Success:     {ar.success}")
    print(f"  Exit code:   {ar.exit_code}")
    print(f"  Duration:    {ar.duration_seconds}s")
    print(f"  Summary:     {ar.summary}")
    print()

    print("--- Compressed Summary ---")
    print(result.compressed_summary[:500])
    print()

    print("--- TTS Output ---")
    print(f"  Provider:    {result.tts_result.provider}")
    if result.voice_selection:
        print(f"  Style:       {result.voice_selection.style.value} ({result.voice_selection.display_name})")
        print(f"  Voice:       {result.voice_selection.voice}")
        print(f"  Speed:       {result.voice_selection.speed}x")
    print(f"  Duration:    {result.tts_result.duration_seconds}s (est.)")
    print(f"  Audio path:  {result.tts_result.audio_path or '(null — mock mode)'}")
    print(f"  Text:        {result.tts_result.text[:400]}")
    print()

    print("--- Execution Trace ---")
    for i, step in enumerate(result.trace, 1):
        print(f"  {i}. {step}")
    print()

    print("--- Memory (recent 3) ---")
    recent = orch.memory.recall(limit=3)
    if recent:
        for mem in recent:
            ts = mem.get("timestamp", "?")[:19]
            conf = mem.get("confidence", "?")
            ttl = mem.get("ttl", "-")
            print(f"  [{ts}] conf={conf} ttl={ttl}")
            print(f"  → {mem.get('summary', '')[:200]}")
    else:
        print("  (no memories recorded yet)")
    print()

    print("=" * 60)
    print(f"  Total pipeline duration: {result.total_duration_seconds}s")
    print("=" * 60)


def main(argv: list[str] | None = None) -> int:
    """Entry point for the demo CLI."""
    parser = build_parser()
    args = parser.parse_args(argv)

    router = AgentRouter()

    # --list-agents
    if args.list_agents:
        list_agents(router)
        # Also show available skills
        print("--- Available Skills ---")
        executor = FunctionExecutor()
        for s in executor.list_skills():
            print(f"  {s['name']:<25} {s['description'][:60]}")
        print()
        return 0

    # task is required unless --list-agents or --audio
    if not args.task and not args.audio:
        parser.error("the following arguments are required: task")

    run_demo(
        task=args.task or "语音输入任务",
        agent_name=args.agent,
        dry_run=args.dry_run,
        timeout=args.timeout,
        audio_path=args.audio,
        real_tts=args.real_tts,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
