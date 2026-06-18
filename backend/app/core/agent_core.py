"""
AgentCore — the central brain of ASRAPP.

Orchestrates the complete agent loop:
  User Input → System Prompt → LLM (stream) → Parse Directives → Execute Skills → Respond

This is the "agent-centric" architecture core. Everything else (skills, TTS, ASR, delegation)
plugs into this engine.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.core.skill_registry import SkillRegistry, get_skill_registry

logger = logging.getLogger(__name__)

# ── Data types ───────────────────────────────────────────────────────────────


@dataclass
class AgentMessage:
    role: str  # system, user, assistant, tool
    content: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class AgentTask:
    id: str
    text: str
    status: str = "open"  # open, done


@dataclass
class AgentState:
    emotion: str = "neutral"  # neutral, happy, curious, focused, surprised, concerned
    action: str = "idle"  # idle, listening, thinking, speaking, observing


@dataclass
class AgentToolCall:
    name: str
    args: dict[str, str]


@dataclass
class AgentTurn:
    """Result of a single agent turn."""
    user_text: str
    assistant_text: str = ""
    state: AgentState = field(default_factory=AgentState)
    tool_calls: list[AgentToolCall] = field(default_factory=list)
    tool_results: list[str] = field(default_factory=list)
    error: str | None = None
    elapsed_sec: float = 0.0


# ── AgentCore ────────────────────────────────────────────────────────────────


class AgentCore:
    """
    Central agent engine. One instance per conversation session.

    Usage::

        agent = AgentCore(
            persona="You are a helpful desktop assistant...",
            llm_config={"base_url": "...", "api_token": "...", "model": "deepseek-chat"},
        )
        turn = await agent.run_turn("帮我查一下今天天气")
        # turn.assistant_text contains the response
        # turn.tool_results contains any skill execution results
    """

    # Regex patterns for inline directives
    STATE_RE = re.compile(r"\[\[agent_state\s+([^\]]+)\]\]", re.IGNORECASE)
    TOOL_RE = re.compile(r"\[\[agent_tool\s+([^\]]+)\]\]", re.IGNORECASE)
    VALID_EMOTIONS = {"neutral", "happy", "curious", "focused", "surprised", "concerned"}
    VALID_ACTIONS = {"idle", "listening", "thinking", "speaking", "observing"}

    def __init__(
        self,
        persona: str = "",
        memory: str = "",
        llm_config: dict[str, str] | None = None,
        use_skills: bool = True,
        use_emotions: bool = True,
        use_context: bool = True,
    ):
        self.persona = persona
        self.memory = memory
        self.llm_config = llm_config or {}
        self.use_skills = use_skills
        self.use_emotions = use_emotions
        self.use_context = use_context

        # Conversation history
        self.messages: list[AgentMessage] = []
        # Task queue
        self.tasks: list[AgentTask] = []
        # Skill registry
        self.skills: SkillRegistry = get_skill_registry()
        # Agent state
        self.state = AgentState()
        # Context (updated externally)
        self.runtime_context: dict[str, str] = {}
        # Turn counter
        self.turn_count = 0
        # Executed tools (dedup)
        self._executed_tools: set[str] = set()

    # ── Public API ─────────────────────────────────────────────────────────

    def update_context(self, **kwargs: str) -> None:
        """Update runtime context fields (e.g., from frontend)."""
        self.runtime_context.update(kwargs)

    def add_task(self, text: str) -> AgentTask:
        task = AgentTask(
            id=f"task_{int(time.time()*1000)}_{len(self.tasks)}",
            text=text.strip()[:240],
        )
        self.tasks.append(task)
        return task

    def complete_task(self, task_id: str) -> AgentTask | None:
        for t in self.tasks:
            if t.id == task_id or task_id in t.text:
                t.status = "done"
                return t
        return None

    def add_memory(self, text: str) -> None:
        text = text.strip()[:240]
        if text and text not in self.memory:
            self.memory = (self.memory + "\n- " + text).strip()[-4000:]

    async def run_turn(self, user_text: str) -> AgentTurn:
        """
        Execute a complete agent turn:
        1. Build system prompt
        2. Call LLM (streaming)
        3. Parse directives
        4. Execute skills
        5. Feed tool results back to LLM if needed
        """
        started = time.perf_counter()
        self.turn_count += 1

        turn = AgentTurn(user_text=user_text)

        # 1. Build message list
        system_prompt = self._build_system_prompt()
        dialogue = [{"role": "system", "content": system_prompt}]
        for msg in self.messages[-20:]:
            role = "user" if msg.role == "tool" else msg.role
            content = f"[工具结果] {msg.content}" if msg.role == "tool" else msg.content
            dialogue.append({"role": role, "content": content})
        dialogue.append({"role": "user", "content": user_text})

        # Store user message
        self.messages.append(AgentMessage(role="user", content=user_text))

        # 2. Call LLM
        try:
            raw_response = await self._call_llm(dialogue)
        except Exception as e:
            turn.error = str(e)
            turn.elapsed_sec = time.perf_counter() - started
            return turn

        # 3. Parse directives
        clean_text, state, tools = self._parse_response(raw_response)
        turn.state = state
        turn.tool_calls = tools
        turn.assistant_text = clean_text

        # Store assistant message
        self.messages.append(AgentMessage(role="assistant", content=clean_text))

        # 4. Execute skills
        for tool in tools:
            if tool.name in self._executed_tools:
                continue
            self._executed_tools.add(tool.name + tool.args.get("text", "")[:20])
            result = await self._execute_tool(tool)
            if result:
                turn.tool_results.append(result)
                self.messages.append(AgentMessage(role="tool", content=result))

        # 5. If tools were executed and there's meaningful work, optionally continue
        # (For now, tool results are reported in the next turn's context)

        turn.elapsed_sec = time.perf_counter() - started
        return turn

    async def stream_turn(self, user_text: str) -> AsyncIterator[dict]:
        """
        Streaming version of run_turn. Yields events:
        {"type": "delta", "text": "..."}  — partial response text
        {"type": "state", "emotion": "...", "action": "..."}  — agent state change
        {"type": "tool", "name": "...", "result": "..."}  — skill execution result
        {"type": "done", "turn": AgentTurn}  — complete turn
        """
        started = time.perf_counter()
        self.turn_count += 1

        system_prompt = self._build_system_prompt()
        dialogue = [{"role": "system", "content": system_prompt}]
        for msg in self.messages[-20:]:
            role = "user" if msg.role == "tool" else msg.role
            content = f"[工具结果] {msg.content}" if msg.role == "tool" else msg.content
            dialogue.append({"role": role, "content": content})
        dialogue.append({"role": "user", "content": user_text})

        self.messages.append(AgentMessage(role="user", content=user_text))

        turn = AgentTurn(user_text=user_text)
        raw_text = ""

        try:
            async for delta in self._call_llm_stream(dialogue):
                raw_text += delta
                # Emit partial text (after stripping directives)
                clean = self._strip_directives(raw_text)
                yield {"type": "delta", "text": delta}

                # Check for state changes mid-stream
                state = self._parse_state(raw_text)
                if state and (state.emotion != turn.state.emotion or state.action != turn.state.action):
                    turn.state = state
                    yield {"type": "state", "emotion": state.emotion, "action": state.action}

        except Exception as e:
            turn.error = str(e)
            yield {"type": "error", "message": str(e)}
            turn.elapsed_sec = time.perf_counter() - started
            yield {
                "type": "done",
                "turn": {
                    "user_text": turn.user_text,
                    "assistant_text": turn.assistant_text,
                    "state": {"emotion": turn.state.emotion, "action": turn.state.action},
                    "tool_calls": [],
                    "tool_results": [],
                    "error": turn.error,
                    "elapsed_sec": turn.elapsed_sec,
                },
            }
            return

        # Parse final response
        clean_text, state, tools = self._parse_response(raw_text)
        turn.state = state or turn.state
        turn.tool_calls = tools
        turn.assistant_text = clean_text
        self.messages.append(AgentMessage(role="assistant", content=clean_text))

        # Execute skills
        for tool in tools:
            if tool.name in self._executed_tools:
                continue
            self._executed_tools.add(tool.name + tool.args.get("text", "")[:20])
            result = await self._execute_tool(tool)
            if result:
                turn.tool_results.append(result)
                self.messages.append(AgentMessage(role="tool", content=result))
                yield {"type": "tool", "name": tool.name, "result": result}

        turn.elapsed_sec = time.perf_counter() - started
        yield {
            "type": "done",
            "turn": {
                "user_text": turn.user_text,
                "assistant_text": turn.assistant_text,
                "state": {
                    "emotion": turn.state.emotion,
                    "action": turn.state.action,
                },
                "tool_calls": [{"name": t.name, "args": t.args} for t in turn.tool_calls],
                "tool_results": turn.tool_results,
                "error": turn.error,
                "elapsed_sec": turn.elapsed_sec,
            },
        }

    # ── Internal ───────────────────────────────────────────────────────────

    def _build_system_prompt(self) -> str:
        blocks = [self.persona]

        if self.memory:
            blocks.append(f"【长期记忆】\n{self.memory}")

        if self.use_context and self.runtime_context:
            ctx_lines = "\n".join(f"- {k}: {v}" for k, v in self.runtime_context.items())
            blocks.append(f"【运行上下文】\n{ctx_lines}")

        if self.tasks:
            open_tasks = [t for t in self.tasks if t.status == "open"]
            if open_tasks:
                task_lines = "\n".join(f"- {t.id}: {t.text}" for t in open_tasks[:8])
                blocks.append(f"【待办任务】\n{task_lines}")

        if self.use_emotions:
            blocks.append(
                "【情绪指令】你可以在回复开头输出 [[agent_state emotion=happy action=speaking]]。\n"
                "emotion: neutral/happy/curious/focused/surprised/concerned。\n"
                "action: idle/listening/thinking/speaking/observing。"
            )

        if self.use_skills:
            skill_list = self.skills.list_skills()
            skill_descs = []
            for s in skill_list:
                params = ", ".join(p.name for p in s.parameters)
                skill_descs.append(f"- {s.name}({params}): {s.description[:80]}")
            blocks.append(
                "【可用技能】使用 [[agent_tool name=技能名 参数1=值1]] 调用。\n" +
                "\n".join(skill_descs)
            )

        return "\n\n".join(blocks)

    def _parse_response(self, text: str) -> tuple[str, AgentState, list[AgentToolCall]]:
        """Parse full response: extract state + tools, return clean text."""
        state = self._parse_state(text) or AgentState()
        tools = self._parse_tools(text)
        clean = text
        clean = self.STATE_RE.sub("", clean)
        clean = self.TOOL_RE.sub("", clean)
        clean = clean.strip()
        return clean, state, tools

    def _strip_directives(self, text: str) -> str:
        """Remove directive tags from streaming text for display."""
        text = self.STATE_RE.sub("", text)
        text = self.TOOL_RE.sub("", text)
        return text

    def _parse_state(self, text: str) -> AgentState | None:
        """Extract [[agent_state emotion=X action=Y]] from text."""
        m = self.STATE_RE.search(text)
        if not m:
            return None
        payload = m.group(1)
        args = self._parse_kv(payload)
        emotion = args.get("emotion", "").lower()
        action = args.get("action", "").lower()
        if emotion in self.VALID_EMOTIONS or action in self.VALID_ACTIONS:
            return AgentState(
                emotion=emotion if emotion in self.VALID_EMOTIONS else "neutral",
                action=action if action in self.VALID_ACTIONS else "idle",
            )
        return None

    def _parse_tools(self, text: str) -> list[AgentToolCall]:
        """Extract all [[agent_tool name=X args...]] from text."""
        tools = []
        skill_names = {s.name for s in self.skills.list_skills()}
        # Add local tools
        skill_names.update({"open_page", "remember", "add_task", "complete_task", "speak"})

        for m in self.TOOL_RE.finditer(text):
            payload = m.group(1)
            args = self._parse_kv(payload)
            name = args.pop("name", "").lower()
            if name in skill_names:
                tools.append(AgentToolCall(name=name, args=args))
        return tools

    async def _execute_tool(self, tool: AgentToolCall) -> str | None:
        """Execute a tool call, routing to skill registry or local handler."""
        # Local tools
        if tool.name == "remember":
            text = tool.args.get("text", "")
            if text and not re.search(r"(api[_ -]?key|token|secret|password|sk-[a-z0-9]{8,})", text, re.I):
                self.add_memory(text)
                return f"记忆已保存: {text[:80]}"
            return "记忆保存被拒绝（疑似敏感信息）"

        if tool.name == "add_task":
            text = tool.args.get("text", "")
            if text:
                task = self.add_task(text)
                return f"任务已添加: {task.text} ({task.id})"
            return None

        if tool.name == "complete_task":
            query = tool.args.get("id") or tool.args.get("text", "")
            task = self.complete_task(query)
            return f"任务已完成: {task.text}" if task else "未找到匹配任务"

        if tool.name == "speak":
            text = tool.args.get("text", "")
            return f"SPEAK:{text}" if text else None  # Frontend handles TTS

        if tool.name == "open_page":
            page = tool.args.get("page", "")
            return f"OPEN_PAGE:{page}" if page else None  # Frontend handles navigation

        # Backend skills
        result = await self.skills.execute(tool.name, tool.args)
        if result.success:
            return result.output[:1200]
        else:
            return f"技能 {tool.name} 失败: {result.error}"

    @staticmethod
    def _parse_kv(payload: str) -> dict[str, str]:
        """Parse key=value pairs from a tag payload string."""
        values: dict[str, str] = {}
        for m in re.finditer(r'([a-zA-Z_]+)=("[^"]*"|\'[^\']*\'|[^\s]+)', payload):
            key = m.group(1)
            val = m.group(2).strip("\"'")
            values[key] = val
        return values

    async def _call_llm(self, messages: list[dict]) -> str:
        """Non-streaming LLM call."""
        from app.core.llm import chat
        from app.schemas.llm import LLMChatRequest, LLMChatMessage

        req = LLMChatRequest(
            messages=[LLMChatMessage(role=m["role"], content=m["content"]) for m in messages],
            model=self.llm_config.get("model", "deepseek-chat"),
            base_url=self.llm_config.get("base_url", "https://api.deepseek.com"),
            api_token=self.llm_config.get("api_token", ""),
            provider=self.llm_config.get("provider", "deepseek"),
            temperature=0.72,
        )
        result = await chat(req)
        return str(result.message.content) if result.message.content else ""

    async def _call_llm_stream(self, messages: list[dict]) -> AsyncIterator[str]:
        """Streaming LLM call, yields text deltas."""
        from app.core.llm import chat_stream
        from app.schemas.llm import LLMChatRequest, LLMChatMessage

        req = LLMChatRequest(
            messages=[LLMChatMessage(role=m["role"], content=m["content"]) for m in messages],
            model=self.llm_config.get("model", "deepseek-chat"),
            base_url=self.llm_config.get("base_url", "https://api.deepseek.com"),
            api_token=self.llm_config.get("api_token", ""),
            provider=self.llm_config.get("provider", "deepseek"),
            temperature=0.72,
        )
        async for event in chat_stream(req):
            if event["type"] == "delta":
                yield event["text"]
            elif event["type"] == "error":
                raise Exception(event.get("message", "LLM error"))

    def reset(self) -> None:
        """Reset conversation state."""
        self.messages.clear()
        self.tasks.clear()
        self._executed_tools.clear()
        self.turn_count = 0
        self.state = AgentState()


# ── Singleton session manager ────────────────────────────────────────────────

_sessions: dict[str, AgentCore] = {}


def get_agent(session_id: str = "default", **config: Any) -> AgentCore:
    """Get or create an AgentCore session."""
    if session_id not in _sessions:
        _sessions[session_id] = AgentCore(**config)
    return _sessions[session_id]


def reset_agent(session_id: str = "default") -> None:
    """Reset an agent session."""
    if session_id in _sessions:
        _sessions[session_id].reset()


def list_sessions() -> list[str]:
    return list(_sessions.keys())
