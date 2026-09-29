"""Offline regression tests; never load keys or connect to a provider."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from app.core.live_voice import qwen_provider as server


class Stream:
    def __init__(self, events=(), send_hook=None):
        self.events, self.sent, self.send_hook = events, [], send_hook

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


def events_of(stream, kind):
    return [event for event in stream.sent if event['type'] == kind]


def outputs(stream):
    return [event['item'] for event in events_of(stream, 'conversation.item.create')
            if event['item']['type'] == 'function_call_output']


def brain_call(call_id='brain-1'):
    return {'name': 'ask_brain', 'call_id': call_id,
            'arguments': json.dumps({'question': 'A slow reasoning question'})}


class QwenInterruptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_speech_cancels_active_and_next_response_allowed(self):
        state, local = server.QwenTurnState(), Stream()
        upstream = Stream([
            {'type': 'response.created', 'response': {'id': 'old'}},
            {'type': 'response.audio.delta', 'delta': 'first'},
            {'type': 'input_audio_buffer.speech_started', 'audio_start_ms': 1200, 'item_id': 'spoken'},
            {'type': 'response.audio.delta', 'delta': 'stale'},
            {'type': 'response.audio_transcript.delta', 'delta': 'old text'},
            {'type': 'input_audio_buffer.speech_stopped', 'audio_end_ms': 2700, 'item_id': 'spoken'},
            {'type': 'conversation.item.ambient_audio_transcription.completed', 'item_id': 'filler', 'transcript': '嗯'},
            {'type': 'response.done', 'response': {'id': 'old', 'status': 'cancelled'}},
            {'type': 'response.created', 'response': {'id': 'new'}},
            {'type': 'response.audio.delta', 'delta': 'new audio'},
            {'type': 'response.done', 'response': {'id': 'new', 'status': 'completed'}},
        ])
        await server.from_qwen(local, upstream, state, True, {})
        self.assertEqual(events_of(upstream, 'response.cancel'), [{'type': 'response.cancel'}])
        self.assertEqual([(e['response_id'], e['data']) for e in events_of(local, 'audio')],
                         [('old', 'first'), ('new', 'new audio')])
        self.assertEqual(events_of(local, 'output_transcript'), [])
        self.assertEqual(len(events_of(local, 'interrupted')), 1)
        self.assertEqual(events_of(local, 'turn_complete')[0]['response_id'], 'new')
        self.assertEqual(events_of(local, 'speech_started')[0]['audio_start_ms'], 1200)
        self.assertEqual(events_of(local, 'speech_stopped')[0]['audio_end_ms'], 2700)
        self.assertEqual(events_of(local, 'ambient_audio')[0]['text'], '嗯')

    async def test_manual_interrupt_cancels_thinking_even_if_brain_returns_late(self):
        state, local, upstream = server.QwenTurnState(), Stream(), Stream()
        state.last_response_id = 'tool-request'
        started = asyncio.Event()

        async def late_brain(*_):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # A response can resolve while HTTP cancellation propagates.
                return {'answer': 'stale reasoning answer'}

        with patch.object(server, 'ask_brain', AsyncMock(side_effect=late_brain)):
            state.tool_task = asyncio.create_task(server.run_tools(
                local, upstream, [brain_call()], state, True, {}, state.speech_epoch))
            await asyncio.wait_for(started.wait(), 1)
            await server.from_browser(Stream([{'type': 'interrupt'}]), upstream, state)
            with self.assertRaises(asyncio.CancelledError):
                await state.tool_task
        self.assertEqual(state.speech_epoch, 1)
        self.assertIn('tool-request', state.suppressed_response_ids)
        self.assertEqual(events_of(local, 'tool'), [])
        self.assertEqual(events_of(upstream, 'response.create'), [])
        output, = outputs(upstream)
        self.assertIn('error', json.loads(output['output']))
        self.assertNotIn('stale reasoning answer', json.dumps(upstream.sent))
        self.assertEqual(events_of(local, 'thinking_status')[-1]['status'], 'IDLE')

    async def test_speech_before_response_created_suppresses_old_and_allows_next(self):
        state, local, upstream = server.QwenTurnState(), Stream(), Stream()
        await server.request_response(upstream, state, state.speech_epoch)
        upstream.events = [{'type': 'input_audio_buffer.speech_started', 'item_id': 'new-input'}]
        await server.from_qwen(local, upstream, state, True, {})
        await server.request_response(upstream, state, state.speech_epoch)
        upstream.events = [
            {'type': 'response.created', 'response': {'id': 'late-old'}},
            {'type': 'response.audio.delta', 'delta': 'stale'},
            {'type': 'response.function_call_arguments.done', **brain_call('stale-call')},
            {'type': 'response.done', 'response': {'id': 'late-old', 'status': 'completed'}},
            {'type': 'response.audio.delta', 'delta': 'stale-after-done'},
            {'type': 'response.created', 'response': {'id': 'fresh'}},
            {'type': 'response.audio.delta', 'delta': 'fresh audio'},
        ]
        with patch.object(server, 'ask_brain', AsyncMock()) as brain:
            await server.from_qwen(local, upstream, state, True, {})
            brain.assert_not_called()
        self.assertEqual(len(events_of(upstream, 'response.cancel')), 1)
        self.assertEqual(events_of(local, 'response_suppressed')[0]['response_id'], 'late-old')
        self.assertEqual([e['response_id'] for e in events_of(local, 'response_started')], ['fresh'])
        self.assertEqual([e['data'] for e in events_of(local, 'audio')], ['fresh audio'])
        self.assertEqual(len(state.pending_responses), 0)
        self.assertIsNone(state.tool_task)

    async def test_cancel_during_response_create_send_keeps_epoch_for_late_created(self):
        state, local, sent = server.QwenTurnState(), Stream(), asyncio.Event()

        async def pause_after_request(event):
            if event['type'] == 'response.create':
                # The provider has received the command, but send has not resumed.
                sent.set()
                await asyncio.Event().wait()

        upstream = Stream(send_hook=pause_after_request)
        calls = [{'name': 'list_capabilities', 'call_id': 'capabilities-1'}]
        state.tool_task = asyncio.create_task(server.run_tools(local, upstream, calls, state, True, {}, 0))
        await asyncio.wait_for(sent.wait(), 1)
        await server.interrupt_turn(upstream, state)
        with self.assertRaises(asyncio.CancelledError):
            await state.tool_task
        request, = events_of(upstream, 'response.create')
        self.assertEqual(list(state.pending_responses), [{'epoch': 0, 'event_id': request['event_id']}])
        self.assertEqual(len(outputs(upstream)), 1)
        upstream.events = [
            {'type': 'response.created', 'response': {'id': 'late-old'}},
            {'type': 'response.audio.delta', 'delta': 'stale'},
            {'type': 'response.done', 'response': {'id': 'late-old', 'status': 'cancelled'}},
        ]
        await server.from_qwen(local, upstream, state, True, {})
        self.assertEqual(events_of(local, 'response_suppressed')[0]['response_id'], 'late-old')
        self.assertEqual(events_of(local, 'response_started'), [])
        self.assertEqual(events_of(local, 'audio'), [])
        self.assertEqual(len(events_of(upstream, 'response.cancel')), 1)
        self.assertEqual(len(state.pending_responses), 0)

    async def test_cancel_during_tool_output_send_does_not_duplicate_output(self):
        state, local, sent = server.QwenTurnState(), Stream(), asyncio.Event()

        async def pause_after_output(event):
            if event.get('item', {}).get('type') == 'function_call_output':
                sent.set()
                await asyncio.Event().wait()

        upstream = Stream(send_hook=pause_after_output)
        calls = [{'name': 'list_capabilities', 'call_id': 'capabilities-1'}]
        state.tool_task = asyncio.create_task(server.run_tools(local, upstream, calls, state, True, {}, 0))
        await asyncio.wait_for(sent.wait(), 1)
        await server.interrupt_turn(upstream, state)
        with self.assertRaises(asyncio.CancelledError):
            await state.tool_task
        self.assertEqual([item['call_id'] for item in outputs(upstream)], ['capabilities-1'])
        self.assertEqual(events_of(upstream, 'response.create'), [])

    async def test_multi_tool_cancel_outputs_each_call_once(self):
        state, local, upstream, started = server.QwenTurnState(), Stream(), Stream(), asyncio.Event()

        async def pending_brain(*_):
            started.set()
            await asyncio.Event().wait()

        calls = [{'name': 'list_capabilities', 'call_id': 'capabilities-1'}, brain_call()]
        with patch.object(server, 'ask_brain', AsyncMock(side_effect=pending_brain)):
            state.tool_task = asyncio.create_task(server.run_tools(local, upstream, calls, state, True, {}, 0))
            await asyncio.wait_for(started.wait(), 1)
            await server.interrupt_turn(upstream, state)
            with self.assertRaises(asyncio.CancelledError):
                await state.tool_task
        found = outputs(upstream)
        self.assertEqual([item['call_id'] for item in found], ['capabilities-1', 'brain-1'])
        self.assertIn('tools', json.loads(found[0]['output']))
        self.assertIn('error', json.loads(found[1]['output']))
        self.assertEqual(events_of(upstream, 'response.create'), [])

    async def test_anonymous_audio_after_done_stays_suppressed(self):
        state, local = server.QwenTurnState(), Stream()
        upstream = Stream([
            {'type': 'response.created', 'response': {'id': 'old'}},
            {'type': 'response.done', 'response': {'id': 'old', 'status': 'completed'}},
        ])
        await server.from_qwen(local, upstream, state, True, {})
        self.assertIsNone(state.active_response_id)
        await server.from_browser(Stream([{'type': 'interrupt'}]), upstream, state)
        upstream.events = [
            {'type': 'response.audio.delta', 'delta': 'still-buffered'},
            {'type': 'response.audio_transcript.delta', 'delta': 'old text'},
        ]
        await server.from_qwen(local, upstream, state, True, {})
        self.assertEqual(events_of(local, 'audio'), [])
        self.assertEqual(events_of(local, 'output_transcript'), [])
        self.assertIn('old', state.suppressed_response_ids)
        self.assertEqual(events_of(upstream, 'response.cancel'), [])

    async def test_text_input_supersedes_brain_and_requests_only_new_turn(self):
        state, local, upstream, started = server.QwenTurnState(), Stream(), Stream(), asyncio.Event()

        async def pending_brain(*_):
            started.set()
            await asyncio.Event().wait()

        with patch.object(server, 'ask_brain', AsyncMock(side_effect=pending_brain)):
            state.tool_task = asyncio.create_task(server.run_tools(local, upstream, [brain_call()], state, True, {}, 0))
            await asyncio.wait_for(started.wait(), 1)
            await server.from_browser(Stream([{'type': 'text', 'text': '  stop and answer this  '}]), upstream, state)
            with self.assertRaises(asyncio.CancelledError):
                await state.tool_task
        requests = events_of(upstream, 'response.create')
        self.assertEqual(len(requests), 1)
        self.assertEqual(list(state.pending_responses), [{'epoch': 1, 'event_id': requests[0]['event_id']}])
        messages = [e['item'] for e in events_of(upstream, 'conversation.item.create') if e['item']['type'] == 'message']
        self.assertEqual(messages[0]['content'][0]['text'], 'stop and answer this')
        self.assertEqual(len(outputs(upstream)), 1)
        self.assertEqual(events_of(local, 'tool'), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
