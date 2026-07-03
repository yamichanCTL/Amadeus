import { describe, expect, it } from 'vitest'
import { buildLocalSummaryRecords } from './summaryRecords'
import type { HistoryItem } from '@/store/useASRStore'

const base: HistoryItem = {
  id: 'offline-1',
  task_id: 'offline-1',
  status: 'success',
  full_text: '原始文本',
  segments: [],
  language: 'zh',
  engine_used: 'sensevoice',
  confidence: null,
  duration_sec: 2,
  elapsed_sec: 1,
  created_at: '2026-07-03T02:30:00.000Z',
  filename: 'recording.webm',
  llm_outputs: { polish: { operation: 'polish', text: '本机润色文本', model: 'demo' } },
}

describe('buildLocalSummaryRecords', () => {
  it('sends only compact local text and time fields', () => {
    const records = buildLocalSummaryRecords([base], {
      date: '2026-07-03',
      category: '一段语音转写',
      startTime: '00:00',
      endTime: '23:59',
    })
    expect(records).toEqual([{
      started_at: '2026-07-03T02:30:00.000Z',
      ended_at: '2026-07-03T02:30:00.000Z',
      category: '一段语音转写',
      text: '本机润色文本',
    }])
    expect(JSON.stringify(records)).not.toContain('filename')
    expect(JSON.stringify(records)).not.toContain('task_id')
  })

  it('classifies and filters realtime local history', () => {
    const live = {
      ...base,
      id: 'live_1',
      task_id: 'live_1',
      filename: 'live_caption.pcm',
      full_text: '实时文本',
      llm_outputs: undefined,
      segments: [{ text: '实时文本', start: 1783045800, end: 1783045810 }],
    }
    expect(buildLocalSummaryRecords([live], {
      date: '2026-07-03',
      category: '实时转录',
    })[0]?.category).toBe('实时转录')
    expect(buildLocalSummaryRecords([live], {
      date: '2026-07-03',
      category: '一段语音转写',
    })).toEqual([])
  })
})
