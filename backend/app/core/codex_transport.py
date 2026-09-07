"""Versioned Codex app-server JSONL transport, using no shell or Node sidecar."""

from __future__ import annotations

import asyncio
import json
import os
import queue
import signal
import subprocess
import threading
from contextlib import suppress
from typing import Any

from app.core.codex_connection import CodexConnection, CodexError, public_error


class CodexTransport:
    def __init__(self, binary: str, connection: CodexConnection):
        self.binary = binary
        self.connection = connection
        self.process: subprocess.Popen | None = None
        self.events: asyncio.Queue = asyncio.Queue(maxsize=2048)
        self._incoming: queue.Queue = queue.Queue(maxsize=2048)
        self._pending: dict[int, asyncio.Future] = {}
        self._counter = 0
        self._closed = threading.Event()
        self._pump_task: asyncio.Task | None = None

    async def start(self) -> None:
        try:
            self.process = subprocess.Popen(
                [self.binary, "app-server", "--listen", "stdio://"],
                cwd=self.connection.workspace,
                env=self.connection.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=os.name == "posix",
            )
        except OSError:
            raise CodexError(
                "codex_unavailable", "无法启动 Codex，请安装 CLI 并检查 CODEX_BINARY。"
            ) from None
        threading.Thread(target=self._reader, daemon=True, name="codex-jsonl").start()
        self._pump_task = asyncio.create_task(self._pump())
        try:
            await self.request(
                "initialize",
                {
                    "clientInfo": {"name": "amadeus_asr", "version": "0.1.0"},
                },
            )
            self._send({"method": "initialized", "params": {}})
        except BaseException:
            await self.close()
            raise

    def _reader(self) -> None:
        assert self.process and self.process.stdout
        try:
            while not self._closed.is_set():
                line = self.process.stdout.readline(2 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 2 * 1024 * 1024:
                    break
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                while not self._closed.is_set():
                    try:
                        self._incoming.put(value, timeout=0.1)
                        break
                    except queue.Full:
                        continue
        finally:
            if not self._closed.is_set():
                with suppress(queue.Full):
                    self._incoming.put_nowait(None)

    def _send(self, message: dict) -> None:
        if not self.process or self.process.poll() is not None or self._closed.is_set():
            raise CodexError("codex_disconnected", "Codex 连接已关闭，请重新开始会话。")
        try:
            assert self.process.stdin
            self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode())
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise CodexError("codex_disconnected", "Codex 连接已关闭，请重新开始会话。") from None

    async def request(self, method: str, params: dict, timeout: float = 20) -> dict:
        self._counter += 1
        identifier = self._counter
        future = asyncio.get_running_loop().create_future()
        self._pending[identifier] = future
        try:
            self._send({"id": identifier, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(identifier, None)

    async def _pump(self) -> None:
        try:
            while not self._closed.is_set():
                try:
                    message = self._incoming.get_nowait()
                except queue.Empty:
                    if self.process and self.process.poll() is not None:
                        raise CodexError("codex_disconnected", "Codex 进程意外退出。") from None
                    await asyncio.sleep(0.01)
                    continue
                if message is None:
                    raise CodexError("codex_disconnected", "Codex 输出连接已关闭。")
                if not isinstance(message, dict):
                    continue
                identifier = message.get("id")
                if identifier is not None and "method" in message:
                    # No interactive approvals are granted by the voice bridge.
                    self._send(
                        {
                            "id": identifier,
                            "error": {
                                "code": -32601,
                                "message": "Interactive tools are unavailable in this client",
                            },
                        }
                    )
                elif identifier in self._pending:
                    future = self._pending[identifier]
                    if not future.done():
                        if "error" in message:
                            future.set_exception(public_error(message["error"]))
                        else:
                            future.set_result(message.get("result", {}))
                elif message.get("method") in {
                    "turn/started",
                    "turn/completed",
                    "item/agentMessage/delta",
                    "item/completed",
                    "thread/tokenUsage/updated",
                    "error",
                }:
                    self.events.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            failure = error if isinstance(error, CodexError) else public_error(error)
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(failure)
            # Drop a queued notification only if necessary to signal fatal overflow.
            if self.events.full():
                self.events.get_nowait()
            self.events.put_nowait({"method": "transport/error", "error": failure})

    async def close(self) -> None:
        self._closed.set()
        if self.process:
            # Kill the group even if its leader exited, so orphaned helpers cannot survive.
            if os.name == "posix":
                with suppress(ProcessLookupError):
                    os.killpg(self.process.pid, signal.SIGKILL)
            elif self.process.poll() is None:
                subprocess.run(
                    ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            deadline = asyncio.get_running_loop().time() + 5
            while self.process.poll() is None and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.02)
            if self.process.stdin:
                self.process.stdin.close()
            if self.process.stdout and self.process.poll() is not None:
                self.process.stdout.close()
        if self._pump_task:
            self._pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._pump_task
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexError("codex_disconnected", "Codex 连接已关闭。"))

    async def __aenter__(self) -> CodexTransport:
        await self.start()
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.close()
