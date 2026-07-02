// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamingASRClient } from './audio'

vi.mock('./telemetry', () => ({
  startTelemetryTrace: vi.fn(() => ({ id: 'trace', name: 'ws', category: 'websocket', startedAt: performance.now(), lastAt: performance.now() })),
  recordTelemetry: vi.fn(),
  recordTelemetryStage: vi.fn(),
  finishTelemetryTrace: vi.fn(),
}))

describe('streaming websocket first-run gate', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', vi.fn())
  })

  it('does not create a same-origin websocket when the backend address is empty', async () => {
    const events: unknown[] = []
    const client = new StreamingASRClient('', (event) => events.push(event))

    await client.start({ engine: 'x-asr', language: 'zh' })

    expect(WebSocket).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'error',
      message: '未配置后端地址。请在「设置 → 后端地址」填写并点击「确认」后再开始实时识别。',
    })
  })

  it('sends archive=false when server debug collection is disabled', async () => {
    const sent: string[] = []
    class FakeWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN
      bufferedAmount = 0
      onopen: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        window.setTimeout(() => this.onopen?.(), 0)
      }
      send(payload: string) { sent.push(payload) }
      close() { this.readyState = FakeWebSocket.CLOSED }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new StreamingASRClient('http://127.0.0.1:8000', vi.fn())

    await client.start({ engine: 'x-asr', language: 'zh', archive: false })
    await new Promise((resolve) => window.setTimeout(resolve, 5))

    expect(JSON.parse(sent[0])).toMatchObject({ type: 'config', archive: false })
    client.stop()
  })
})
