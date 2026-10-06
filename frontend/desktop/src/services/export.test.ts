import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTimestamp, saveResult, segmentsToSrt } from './export'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('subtitle and result export', () => {
  it.each([
    [59.9996, '00:01:00,000'], [3599.9996, '01:00:00,000'], [0.9996, '00:00:01,000'],
    [61.23, '00:01:01,230'], [-1, '00:00:00,000'], [Number.NaN, '00:00:00,000'], [Number.POSITIVE_INFINITY, '00:00:00,000'],
  ])('formats %s seconds as a valid SRT timestamp', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected)
  })

  it('exports valid chronological SRT cues across a minute boundary', () => {
    expect(segmentsToSrt([{ start: 59.9996, end: 61.2, text: ' 测试字幕 ' }])).toBe('1\n00:01:00,000 --> 00:01:01,200\n测试字幕')
  })

  it('downloads complete result exports in the browser preview without an Electron save dialog', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export-fixture')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const result = { task_id: 'test', status: 'success', full_text: '转写文本', segments: [], language: 'zh', engine_used: 'formalasr', confidence: null, duration_sec: 1, elapsed_sec: 1 }
    expect(await saveResult(result, 'test.txt', 'txt')).toBe(true)
    expect(click).toHaveBeenCalledOnce()
    expect(objectUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(revoke).toHaveBeenCalledWith('blob:export-fixture')
  })
})
