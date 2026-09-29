"""Offline Grok protocol checks: fake WebSockets, no environment or API calls."""

import asyncio
import base64
import json
import unittest
from unittest.mock import patch

from app.core.live_voice import grok_provider as grok


class Stream:
    def __init__(self, items=(), hook=None):
        self.items, self.sent, self.hook = list(items), [], hook

    async def recv(self):
        if not self.items:
            raise ValueError("end of fixture")
        return json.dumps(self.items.pop(0))

    def __aiter__(self):
        async def messages():
            while self.items:
                yield json.dumps(self.items.pop(0))
        return messages()

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if self.hook:
            await self.hook(event)


def sent(ws, kind):
    return [event for event in ws.sent if event["type"] == kind]


def created(response_id, epoch=None):
    response = {"id": response_id}
    if epoch is not None:
        response["metadata"] = {"amadeus_epoch": str(epoch)}
    return {"type": "response.created", "response": response}


def done(response_id, status="completed", output=()):
    return {"type": "response.done", "response": {"id": response_id, "status": status, "output": list(output)}}


def audio(response_id, value, legacy=False):
    return {"type": "response.audio.delta" if legacy else "response.output_audio.delta",
            "response_id": response_id, "delta": value}


def call(call_id, name="list_capabilities"):
    return {"type": "function_call", "call_id": call_id, "name": name, "arguments": "{}"}


class Connection:
    def __init__(self, stream):
        self.stream = stream

    async def __aenter__(self):
        return self.stream

    async def __aexit__(self, *_):
        return False


class GrokProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_official_setup_format_reasoning_tools_and_no_forced_greeting(self):
        config = grok.setup_message("eve")["session"]
        self.assertEqual(config["reasoning"], {"effort": "high"})
        self.assertEqual(config["turn_detection"]["type"], "server_vad")
        self.assertEqual(config["turn_detection"]["threshold"], .85)
        self.assertEqual(config["audio"]["input"]["format"]["rate"], 16000)
        self.assertEqual(config["audio"]["output"]["format"]["rate"], 24000)
        self.assertEqual(config["audio"]["input"]["transcription"]["model"], "grok-transcribe")
        self.assertNotIn("turn_detection", config["audio"]["input"])
        self.assertEqual(config["voice"], "eve")
        self.assertNotIn("model", config)
        self.assertEqual({tool["name"] for tool in config["tools"]}, {"get_local_time", "list_capabilities"})
        self.assertEqual(len(grok.VOICES), 28)

    async def test_missing_key_and_invalid_start_do_not_open_network(self):
        with patch.object(grok.websockets, "connect") as connect:
            browser = Stream()
            await grok.handle_grok(browser, {}, {"voice": "eve"})
            self.assertIn("XAI_API_KEY", sent(browser, "error")[0]["message"])
            for start in ({"voice": []}, {"voice": "unknown"}, {"reasoning": "max"}, {"brain": "qwen"}):
                browser = Stream()
                await grok.handle_grok(browser, {"XAI_API_KEY": "not-a-real-key"}, start)
                self.assertEqual(len(sent(browser, "error")), 1)
            connect.assert_not_called()

    async def test_created_is_not_configuration_ack(self):
        browser, upstream = Stream(), Stream([{"type": "session.created"}, {"type": "conversation.created"},
            {"type": "error", "error": {"code": "invalid_voice", "message": "SECRET"}}])
        with patch.object(grok.websockets, "connect", return_value=Connection(upstream)):
            await grok.handle_grok(browser, {"XAI_API_KEY": "SECRET", "GROK_EVAL_ENABLED": "1"}, {"voice": "eve"})
        self.assertEqual(sent(browser, "ready"), [])
        self.assertEqual(len(sent(browser, "error")), 1)
        self.assertNotIn("SECRET", json.dumps(browser.sent))

    async def test_updated_ack_ready_fixed_endpoint_and_server_only_key(self):
        browser, upstream = Stream(), Stream([{"type": "session.created"}, {"type": "session.updated"}])
        with patch.object(grok.websockets, "connect", return_value=Connection(upstream)) as connect:
            await grok.handle_grok(browser, {"XAI_API_KEY": "SECRET", "XAI_URL": "https://invalid", "GROK_EVAL_ENABLED": "1"},
                                   {"voice": "ara", "brain": "off", "reasoning": "none"})
        self.assertEqual(connect.call_args.args[0], grok.UPSTREAM)
        self.assertEqual(connect.call_args.kwargs["additional_headers"], {"Authorization": "Bearer SECRET"})
        self.assertEqual(sent(browser, "ready")[0]["model"], grok.MODEL)
        self.assertEqual(sent(browser, "ready")[0]["reasoning"], "none")
        self.assertNotIn("SECRET", json.dumps(browser.sent))

    async def test_key_without_explicit_billing_gate_never_connects(self):
        browser = Stream()
        with patch.object(grok.websockets, "connect") as connect:
            await grok.handle_grok(browser, {"XAI_API_KEY": "SECRET"}, {"voice": "eve"})
            connect.assert_not_called()
        self.assertEqual(sent(browser, "ready"), [])
        self.assertIn("预算", sent(browser, "error")[0]["message"])

    async def test_mismatched_ack_cannot_report_ready(self):
        for mismatch in ({"model": "grok-different"}, {"voice": "ara"},
                         {"reasoning": {"effort": "none"}}, {"audio": {"output": {"format": {"rate": 48000}}}}):
            browser, upstream = Stream(), Stream([{"type": "session.updated", "session": mismatch}])
            with patch.object(grok.websockets, "connect", return_value=Connection(upstream)):
                await grok.handle_grok(browser, {"XAI_API_KEY": "SECRET", "GROK_EVAL_ENABLED": "1"}, {"voice": "eve"})
            self.assertEqual(sent(browser, "ready"), [])
            self.assertIn("不一致", sent(browser, "error")[0]["message"])

    async def test_native_interruption_discards_old_output_allows_next_turn(self):
        browser, state = Stream(), grok.TurnState()
        upstream = Stream([created("old"), audio("old", "before"),
            {"type": "input_audio_buffer.speech_started", "item_id": "u1", "audio_start_ms": 1500},
            audio("old", "stale"), done("old", "cancelled"),
            {"type": "input_audio_buffer.speech_stopped", "item_id": "u1", "audio_end_ms": 2600},
            created("new"), audio("old", "later"), audio("new", "after"), done("new")])
        await grok.from_grok(browser, upstream, state)
        self.assertEqual([event["data"] for event in sent(browser, "audio")], ["before", "after"])
        self.assertEqual(sent(upstream, "response.cancel"), [])
        self.assertEqual(sent(browser, "speech_started")[0]["audio_start_ms"], 1500)
        self.assertTrue(sent(browser, "interrupted")[-1]["provider_cancelled"])
        self.assertEqual(sent(browser, "turn_complete")[0]["response_id"], "new")

    async def test_manual_cancel_is_single_and_late_created_is_suppressed(self):
        browser, state, upstream = Stream(), grok.TurnState(), Stream([created("old")])
        await grok.from_grok(browser, upstream, state)
        await grok.from_browser(Stream([{"type": "interrupt"}, {"type": "interrupt"}]), upstream, state)
        self.assertEqual(sent(upstream, "response.cancel"), [{"type": "response.cancel", "response_id": "old"}])
        upstream.items = [audio("old", "stale"), done("old", "cancelled"), created("late"), audio("late", "bad")]
        await grok.from_grok(browser, upstream, state)
        self.assertEqual(sent(browser, "audio"), [])
        self.assertEqual(sent(browser, "response_suppressed")[0]["response_id"], "late")

    async def test_stale_explicit_epoch_does_not_reenter_new_turn(self):
        state, browser, upstream = grok.TurnState(), Stream(), Stream()
        await grok.from_browser(Stream([{"type": "text", "text": "问题一"}, {"type": "text", "text": "改为问题二"}]), upstream, state)
        upstream.items = [created("stale", 1), audio("stale", "bad"), done("stale"),
                          created("fresh", 2), audio("fresh", "good"), done("fresh")]
        await grok.from_grok(browser, upstream, state)
        self.assertEqual([event["data"] for event in sent(browser, "audio")], ["good"])
        self.assertEqual(len(sent(upstream, "conversation.item.create")), 2)

    async def test_late_response_while_user_speaks_cannot_play(self):
        browser, upstream = Stream(), Stream([{"type": "input_audio_buffer.speech_started"},
            created("old"), audio("old", "bad"), done("old", "cancelled"),
            {"type": "input_audio_buffer.speech_stopped"}, created("new"), audio("new", "good")])
        await grok.from_grok(browser, upstream, grok.TurnState())
        self.assertEqual([event["data"] for event in sent(browser, "audio")], ["good"])

    async def test_cumulative_input_transcription_not_concatenated(self):
        browser, upstream = Stream(), Stream([
            {"type": "conversation.item.input_audio_transcription.updated", "item_id": "u1", "transcript": "我在北"},
            {"type": "conversation.item.input_audio_transcription.updated", "item_id": "u1", "transcript": "我在北京"},
            {"type": "conversation.item.input_audio_transcription.completed", "item_id": "u1", "transcript": "我在背景里"}])
        await grok.from_grok(browser, upstream, grok.TurnState())
        updates = sent(browser, "input_transcript")
        self.assertEqual([event["text"] for event in updates], ["我在北", "我在北京", "我在背景里"])
        self.assertEqual([event["final"] for event in updates], [False, False, True])
        self.assertEqual({event["item_id"] for event in updates}, {"u1"})

    async def test_audio_validation_ack_and_legacy_event_alias(self):
        valid = base64.b64encode(b"\0" * 32000).decode()
        browser = Stream([{"type": "audio", "data": valid}, {"type": "audio", "data": valid, "padding": True},
                          {"type": "audio", "data": "!bad!"}, {"type": "audio", "data": "AA=="}, []])
        upstream, state = Stream(), grok.TurnState()
        await grok.from_browser(browser, upstream, state)
        self.assertEqual(len(sent(upstream, "input_audio_buffer.append")), 2)
        self.assertEqual(sent(browser, "capture_ack"), [{"type": "capture_ack", "seconds": 1.0}])
        upstream.items = [created("a"), audio("a", "legacy", True)]
        await grok.from_grok(browser, upstream, state)
        self.assertEqual(sent(browser, "audio")[0]["data"], "legacy")

    async def test_parallel_function_events_batch_once_and_deduplicate_done(self):
        clock, capabilities = call("clock", "get_local_time"), call("caps")
        browser, state = Stream(), grok.TurnState()
        upstream = Stream([created("tools"),
            {**clock, "type": "response.function_call_arguments.done", "response_id": "tools"},
            {**capabilities, "type": "response.function_call_arguments.done", "response_id": "tools"},
            done("tools", output=[clock, capabilities]), done("tools", output=[clock, capabilities])])
        await grok.from_grok(browser, upstream, state)
        await asyncio.gather(*state.tool_tasks)
        self.assertEqual(len(sent(upstream, "conversation.item.create")), 2)
        self.assertEqual(len(sent(upstream, "response.create")), 1)
        self.assertEqual(len(sent(browser, "tool")), 2)
        self.assertEqual(sent(browser, "turn_complete"), [])
        result = json.loads(sent(upstream, "conversation.item.create")[1]["item"]["output"])
        self.assertEqual(result["native_reasoning"], "high")

    async def test_cancelled_tool_response_never_executes(self):
        browser, state = Stream(), grok.TurnState()
        upstream = Stream([created("old"), {"type": "input_audio_buffer.speech_started"},
                           done("old", output=[call("unsafe-stale")])])
        await grok.from_grok(browser, upstream, state)
        self.assertFalse(state.tool_tasks)
        self.assertEqual(sent(browser, "tool"), [])

    async def test_interrupt_during_tool_send_cancels_continuation(self):
        started = asyncio.Event()
        async def hold(event):
            if event["type"] == "conversation.item.create":
                started.set()
                await asyncio.Event().wait()
        browser, upstream, state = Stream(), Stream(hook=hold), grok.TurnState()
        task = asyncio.create_task(grok.run_tools(browser, upstream, state, [call("one")], 0))
        state.tool_tasks.add(task)
        await asyncio.wait_for(started.wait(), 1)
        await grok.suppress_turn(upstream, state, manual=True)
        self.assertTrue(task.cancelled())
        self.assertEqual(sent(upstream, "response.create"), [])

    async def test_completed_output_cannot_reappear_after_turn_done(self):
        browser, upstream = Stream(), Stream([created("one"), audio("one", "first"), done("one"),
            audio("one", "late"), created("one"), audio("one", "duplicate")])
        await grok.from_grok(browser, upstream, grok.TurnState())
        self.assertEqual([event["data"] for event in sent(browser, "audio")], ["first"])
        self.assertEqual(len(sent(browser, "turn_complete")), 1)

    async def test_provider_error_never_echoes_request_or_key(self):
        browser, upstream = Stream(), Stream([{"type": "error", "error": {
            "type": "insufficient_quota", "code": "secret-test", "message": "secret-test"}}])
        await grok.from_grok(browser, upstream, grok.TurnState())
        self.assertIn("额度", sent(browser, "error")[0]["message"])
        self.assertNotIn("secret-test", json.dumps(browser.sent))


if __name__ == "__main__":
    unittest.main()
