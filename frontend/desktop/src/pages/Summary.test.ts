// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { defaultSummaryTimeRange, localTimeValue, SUMMARY_CATEGORY_OPTIONS } from './Summary'
import { createSummaryWorkspace } from '@/store/useASRStore'

describe('summary defaults', () => {
  it('uses the complete local day by default', () => {
    const now = new Date(2026, 6, 2, 14, 7, 59)
    expect(defaultSummaryTimeRange(now)).toEqual({ startTime: '00:00', endTime: '23:59' })
    expect(createSummaryWorkspace(now)).toMatchObject({ date: '2026-07-02', endDate: '2026-07-02' })
    expect(localTimeValue(now)).toBe('14:07')
  })

  it('offers both, offline, and realtime recognition without free text', () => {
    expect(SUMMARY_CATEGORY_OPTIONS).toEqual([
      { value: '', label: 'Both / 所有类型' },
      { value: '一段语音转写', label: '离线识别' },
      { value: '实时转录', label: '实时识别' },
    ])
  })
})
