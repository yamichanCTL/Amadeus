import { afterEach, expect, it, vi } from 'vitest'
import { streamCodexExplanation } from './codex'

afterEach(() => vi.unstubAllGlobals())

it('decodes fragmented UTF-8 and CRLF SSE frames without duplicating deltas', async () => {
  const events = ': keepalive\r\n\r\n' + [
    { type: 'agent.delta', text: '中文😀' },
    { type: 'agent.delta', text: '第二段' },
    { type: 'meeting.completed', target: '原话', result: { status: 'completed', text: '中文😀第二段', usage: { total_tokens: 20 } } },
  ].map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join('')
  const bytes = new TextEncoder().encode(events)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() },
  }), { headers: { 'Content-Type': 'text/event-stream' } })))
  const deltas: string[] = []
  const result = await streamCodexExplanation('http://backend.test', { target: '原话' }, new AbortController().signal, text => deltas.push(text))
  expect(deltas).toEqual(['中文😀', '第二段'])
  expect(result.result.text).toBe('中文😀第二段')
  expect(result.result.usage?.total_tokens).toBe(20)
})

it('reports explicit stream errors and HTTP authentication failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"meeting.error","message":"额度不足"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
  await expect(streamCodexExplanation('http://backend.test', {}, new AbortController().signal, () => {})).rejects.toThrow('额度不足')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: { message: '登录失效' } }, { status: 503 })))
  await expect(streamCodexExplanation('http://backend.test', {}, new AbortController().signal, () => {})).rejects.toThrow('登录失效')
})
