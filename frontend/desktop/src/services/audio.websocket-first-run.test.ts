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
})
