// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASRApi, type ArchiveSummaryRequest } from './api'

const request: ArchiveSummaryRequest = {
  date: '2026-07-04', model: 'demo', base_url: 'https://llm.test', api_token: 'token',
}

describe('archive summary stream', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('delivers NDJSON deltas before the done result', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"meta","source_count":1,"input_chars":4,"estimated_input_tokens":2,"date":"2026-07-04","time_range":"00:00-12:00"}\n'))
        controller.enqueue(encoder.encode('{"type":"delta","text":"逐"}\n{"type":"delta","text":"字"}\n'))
        controller.enqueue(encoder.encode('{"type":"done","result":{"summary":"逐字","model":"demo","source_count":1,"input_chars":4,"estimated_input_tokens":2,"chunk_count":1,"truncated":false,"date":"2026-07-04","time_range":"00:00-12:00"}}\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    const seen: string[] = []

    const result = await new ASRApi('http://backend.test').streamArchiveSummary(request, (event) => {
      if (event.type === 'delta') seen.push(event.text)
    })

    expect(seen).toEqual(['逐', '字'])
    expect(result.summary).toBe('逐字')
  })
})
