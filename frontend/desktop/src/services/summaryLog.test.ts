// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { saveSummaryToLocalLog, summaryLogFilename } from './summaryLog'

const result = {
  summary: '# 总结', model: 'demo', source_count: 1, input_chars: 2,
  estimated_input_tokens: 1, chunk_count: 1, truncated: false,
  date: '2026-07-04', time_range: '00:00-12:00',
}

describe('summary log auto-save', () => {
  it('uses a generation timestamp so every summary has its own Markdown log', () => {
    expect(summaryLogFilename(result, new Date('2026-07-04T01:02:03.456Z')))
      .toBe('summary_2026-07-04_00-00-12-00_2026-07-04T01-02-03-456.md')
  })

  it('writes under the configured local archive root', async () => {
    const saveSummaryLog = vi.fn(async () => ({ saved: true, path: 'D:/logs/summary.md' }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { saveSummaryLog } })

    await saveSummaryToLocalLog(result, 'D:/Amadeus')

    expect(saveSummaryLog).toHaveBeenCalledWith(expect.objectContaining({ archiveRoot: 'D:/Amadeus', content: '# 总结' }))
  })
})
