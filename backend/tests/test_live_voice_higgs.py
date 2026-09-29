"""Offline protocol regression tests. No environment/key loading or API calls."""

import asyncio
import base64
import json
import unittest
from unittest.mock import patch

from app.core.live_voice import higgs_provider as higgs


class Stream:
    def __init__(self, events=(), send_hook=None):
        self.events, self.sent, self.send_hook = list(events), [], send_hook

    async def recv(self):
        return json.dumps(self.events.pop(0))

    def __aiter__(self):
        async def items():
            for event in self.events:
                yield json.dumps(event)
        return items()

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if self.send_hook:
            await self.send_hook(event)


def events(stream, kind):
    return [event for event in stream.sent if event["type"] == kind]


def created(response_id, epoch=None):
    metadata = None if epoch is None else {"amadeus_epoch": str(epoch)}
    return {"type": "response.created", "response": {"id": response_id, "metadata": metadata}}


def done(response_id, output=(), status="completed"):
    return {"type": "response.done", "response": {"id": response_id, "status": status, "output": list(output)}}


def audio(response_id, data):
    return {"type": "response.output_audio.delta", "response_id": response_id, "delta": data}


class HiggsProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_reused_response_id_gets_fresh_playback_identity(self):
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([created("reused"), audio("reused", "before"),
            {"type": "input_audio_buffer.speech_started"},
            done("reused", status="cancelled"), audio("reused", "late-old"),
            {"type": "input_audio_buffer.speech_stopped"},
            created("reused"), audio("reused", "fresh"), done("reused")])
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual([e["data"] for e in events(browser, "audio")], ["before", "fresh"])
        starts = events(browser, "response_started")
        self.assertNotEqual(starts[0]["response_id"], starts[1]["response_id"])
        self.assertEqual(events(browser, "turn_complete")[0]["response_id"], starts[1]["response_id"])
        await higgs.from_browser(Stream([{"type": "text", "text": "下一题"}]), upstream, state)
        upstream.events = [created("reused")]
        await higgs.from_higgs(browser, upstream, state)
        await higgs.from_browser(Stream([{"type": "interrupt", "response_id": state.active_response}]), upstream, state)
        self.assertEqual(events(upstream, "response.cancel")[-1]["response_id"], "reused")

    def test_config_formats_transcription_native_turn_and_tools(self):
        session = higgs.setup_message("nora")["session"]
        self.assertEqual(session["model"], "higgs-realtime")
        self.assertEqual(session["output_modalities"], ["audio"])
        self.assertEqual(session["audio"]["input"]["format"]["rate"], 16000)
        self.assertEqual(session["audio"]["output"]["format"]["rate"], 24000)
        self.assertEqual(session["audio"]["input"]["transcription"]["model"], "higgs-stt-3.1")
        self.assertEqual(session["audio"]["input"]["turn_detection"], {"type": "semantic_vad"})
        self.assertEqual({tool["name"] for tool in session["tools"]}, {"get_local_time", "list_capabilities"})
        self.assertTrue(higgs.valid_voice("voice_authorized-clone"))
        self.assertFalse(higgs.valid_voice("https://untrusted.example/voice"))

    async def test_audio_validation_and_ack_counts_only_captured_pcm(self):
        good = base64.b64encode(b"\0" * 32000).decode()
        browser = Stream([{"type": "audio", "data": good}, {"type": "audio", "data": good, "padding": True},
                          {"type": "audio", "data": "invalid"}, {"type": "audio", "data": "AA=="},
                          {"type": "audio", "data": 17}, []])
        upstream = Stream()
        await higgs.from_browser(browser, upstream, higgs.TurnState())
        self.assertEqual(len(events(upstream, "input_audio_buffer.append")), 2)
        self.assertEqual(events(browser, "capture_ack"), [{"type": "capture_ack", "seconds": 1.0}])
        self.assertEqual(events(upstream, "response.cancel"), [])

    async def test_native_interruption_drops_stale_and_allows_new(self):
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([created("old"), audio("old", "before"),
            {"type": "input_audio_buffer.speech_started", "item_id": "user-1", "audio_start_ms": 1200},
            audio("old", "stale"),
            {"type": "response.output_audio_transcript.delta", "response_id": "old", "delta": "stale"},
            done("old", status="cancelled"),
            {"type": "input_audio_buffer.speech_stopped", "item_id": "user-1", "audio_end_ms": 2200},
            {"type": "conversation.item.input_audio_transcription.completed", "item_id": "user-1", "transcript": "停一下"},
            created("new"), audio("new", "fresh"), done("new")])
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual([e["data"] for e in events(browser, "audio")], ["before", "fresh"])
        self.assertEqual(events(browser, "output_transcript"), [])
        self.assertEqual(events(upstream, "response.cancel"), [])
        self.assertEqual(events(browser, "input_transcript")[0]["text"], "停一下")
        self.assertEqual(events(browser, "interrupted")[0]["response_id"], "old")
        self.assertEqual(events(browser, "turn_complete")[0]["response_id"], "new")

    async def test_manual_interrupt_cancels_once_and_suppresses_late_audio(self):
        state, browser, upstream = higgs.TurnState(), Stream(), Stream([created("old")])
        await higgs.from_higgs(browser, upstream, state)
        await higgs.from_browser(Stream([{"type": "interrupt"}, {"type": "interrupt"}]), upstream, state)
        upstream.events = [audio("old", "stale"), done("old"), audio("old", "later")]
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual(events(upstream, "response.cancel"), [{"type": "response.cancel", "response_id": "old"}])
        self.assertEqual(events(browser, "audio"), [])

    async def test_late_explicit_response_metadata_rejected_after_interruption(self):
        state, browser, upstream = higgs.TurnState(), Stream(), Stream()
        await higgs.request_response(upstream, state, 0)
        await higgs.from_browser(Stream([{"type": "interrupt"}]), upstream, state)
        await higgs.from_browser(Stream([{"type": "text", "text": "新问题"}]), upstream, state)
        upstream.events = [created("late", 0), audio("late", "stale"), done("late"),
                           created("fresh", state.epoch), audio("fresh", "good"), done("fresh")]
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual([e["data"] for e in events(browser, "audio")], ["good"])
        self.assertEqual(events(browser, "response_suppressed")[0]["response_id"], "late")

    async def test_late_automatic_response_while_speaking_is_rejected(self):
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([{"type": "input_audio_buffer.speech_started"}, created("late"), audio("late", "bad"),
            done("late", status="cancelled"), {"type": "input_audio_buffer.speech_stopped"},
            created("new"), audio("new", "good")])
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual([e["data"] for e in events(browser, "audio")], ["good"])

    async def test_tools_execute_on_completed_response_only(self):
        calls = [{"type": "function_call", "name": "get_local_time", "call_id": "clock", "arguments": "{}"},
                 {"type": "function_call", "name": "list_capabilities", "call_id": "caps", "arguments": "{}"}]
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([created("tools"), {**calls[0], "type": "response.function_call_arguments.done"}, done("tools", calls)])
        await higgs.from_higgs(browser, upstream, state)
        await state.tool_task
        self.assertEqual(len(events(browser, "tool")), 2)
        outputs = [e["item"] for e in events(upstream, "conversation.item.create")]
        self.assertEqual([o["call_id"] for o in outputs], ["clock", "caps"])
        self.assertIn("beijing_time", json.loads(outputs[0]["output"]))
        self.assertFalse(json.loads(outputs[1]["output"])["external_brain"])
        self.assertEqual(len(events(upstream, "response.create")), 1)
        self.assertEqual(events(browser, "turn_complete"), [])

    async def test_stale_tool_response_cannot_execute(self):
        call = {"type": "function_call", "name": "get_local_time", "call_id": "late", "arguments": "{}"}
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([created("tools"), {"type": "input_audio_buffer.speech_started"}, done("tools", [call])])
        await higgs.from_higgs(browser, upstream, state)
        self.assertIsNone(state.tool_task)
        self.assertEqual(events(browser, "tool"), [])

    async def test_interrupt_during_tool_output_does_not_start_old_response(self):
        waiting = asyncio.Event()
        async def block_output(event):
            if event["type"] == "conversation.item.create":
                waiting.set()
                await asyncio.Event().wait()
        state, upstream, browser = higgs.TurnState(), Stream(send_hook=block_output), Stream()
        state.tool_task = asyncio.create_task(higgs.run_tools(browser, upstream, state,
            [{"name": "list_capabilities", "call_id": "caps", "arguments": "{}"}], 0))
        await asyncio.wait_for(waiting.wait(), 1)
        await higgs.suppress_turn(upstream, state, manual=True)
        self.assertTrue(state.tool_task.cancelled())
        self.assertEqual(len(events(upstream, "conversation.item.create")), 1)
        self.assertEqual(events(upstream, "response.create"), [])

    async def test_audio_end_uses_silence_not_manual_commit(self):
        browser, upstream = Stream([{"type": "audio_end"}]), Stream()
        with patch.object(higgs.asyncio, "sleep", return_value=None):
            await higgs.from_browser(browser, upstream, higgs.TurnState())
        self.assertEqual(len(events(upstream, "input_audio_buffer.append")), 10)
        self.assertEqual(events(upstream, "input_audio_buffer.commit"), [])

    async def test_missing_key_fails_without_network(self):
        browser = Stream()
        with patch.object(higgs.websockets, "connect") as connect:
            await higgs.handle_higgs(browser, {}, {"voice": "default"})
            connect.assert_not_called()
        self.assertIn("BOSON_API_KEY", events(browser, "error")[0]["message"])

    async def test_upstream_error_does_not_echo_credentials(self):
        secret = "bai-never-echo-me"
        event = {"type": "error", "error": {"type": "insufficient_quota", "message": secret, "code": secret}}
        browser, upstream = Stream(), Stream([event])
        await higgs.from_higgs(browser, upstream, higgs.TurnState())
        self.assertNotIn(secret, json.dumps(browser.sent))

    async def test_handshake_ready_and_server_only_fixed_endpoint(self):
        upstream = Stream([{"type": "session.created", "session": {"model": higgs.MODEL}}])
        class Connection:
            async def __aenter__(self):
                return upstream
            async def __aexit__(self, *_):
                return False
        browser = Stream()
        with patch.object(higgs.websockets, "connect", return_value=Connection()) as connect:
            await higgs.handle_higgs(browser, {"BOSON_API_KEY": "bai-test-secret", "BOSON_URL": "https://bad.example"},
                                     {"voice": "chloe", "brain": "off"})
            self.assertEqual(connect.call_args.args[0], "wss://api.boson.ai/v1/realtime")
            self.assertEqual(connect.call_args.kwargs["additional_headers"]["Authorization"], "Bearer bai-test-secret")
        self.assertEqual(upstream.sent[0]["type"], "session.update")
        ready = events(browser, "ready")[0]
        self.assertEqual(ready["input_transcription_model"], "higgs-stt-3.1")
        self.assertTrue(ready["separate_input_transcription"])
        self.assertNotIn("bai-test-secret", json.dumps(browser.sent))

    async def test_setup_error_before_ack_never_emits_ready(self):
        upstream = Stream([{"type": "error", "error": {"type": "invalid_voice", "message": "secret"}}])
        class Connection:
            async def __aenter__(self):
                return upstream
            async def __aexit__(self, *_):
                return False
        browser = Stream()
        with patch.object(higgs.websockets, "connect", return_value=Connection()):
            await higgs.handle_higgs(browser, {"BOSON_API_KEY": "secret"}, {"voice": "nora"})
        self.assertEqual(events(browser, "ready"), [])
        self.assertEqual(len(events(browser, "error")), 1)
        self.assertNotIn("secret", json.dumps(browser.sent))

    async def test_failed_response_reports_safely_and_finishes_ui_turn(self):
        browser, state = Stream(), higgs.TurnState()
        upstream = Stream([created("bad"), done("bad", status="failed")])
        await higgs.from_higgs(browser, upstream, state)
        self.assertEqual(len(events(browser, "error")), 1)
        self.assertEqual(events(browser, "turn_complete")[0]["status"], "failed")
        self.assertIsNone(state.active_response)


if __name__ == "__main__":
    unittest.main()
