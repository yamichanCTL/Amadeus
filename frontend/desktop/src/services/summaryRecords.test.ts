import { describe, expect, it } from 'vitest'
import { buildLocalSummaryRecords } from './summaryRecords'
import type { HistoryItem } from '@/store/useASRStore'

function historyItem(id: string, createdAt: string, text: string): HistoryItem {
  return {
    id,
    task_id: id,
    status: 'success',
    full_text: text,
    segments: [{ start: Date.parse(createdAt) / 1000, end: Date.parse(createdAt) / 1000 + 1, text }],
    language: 'zh',
    engine_used: 'mock',
    confidence: null,
    duration_sec: 1,
    elapsed_sec: null,
    created_at: createdAt,
    filename: `${id}.wav`,
  }
}

describe('summary record range filtering', () => {
  it('keeps local records inside the selected date range', () => {
    const records = buildLocalSummaryRecords([
      historyItem('task_1', '2026-07-01T09:00:00+08:00', '七月一号'),
      historyItem('task_3', '2026-07-03T09:00:00+08:00', '七月三号'),
      historyItem('task_6', '2026-07-06T09:00:00+08:00', '七月六号'),
    ], {
      date: '2026-07-01',
      endDate: '2026-07-05',
      startTime: '00:00',
      endTime: '23:59',
    })

    expect(records.map((record) => record.text)).toEqual(['七月一号', '七月三号'])
  })
})
