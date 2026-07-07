import type { ArchiveSummaryRecord } from './api'
import type { HistoryItem } from '@/store/useASRStore'

function localDateValue(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

function normalizeDateRange(date: string, endDate?: string) {
  const start = date
  const end = endDate || date
  return end < start ? { start: end, end: start } : { start, end }
}

function isWithinDateRange(date: Date, startDate: string, endDate: string) {
  const current = localDateValue(date)
  return current >= startDate && current <= endDate
}

function clockMinutes(value: string | undefined) {
  if (!value) return null
  const [hour, minute] = value.split(':').map(Number)
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
}

function isWithinRange(date: Date, startTime?: string, endTime?: string) {
  const current = date.getHours() * 60 + date.getMinutes()
  const start = clockMinutes(startTime)
  const end = clockMinutes(endTime)
  if (start === null && end === null) return true
  if (start !== null && end === null) return current >= start
  if (start === null && end !== null) return current <= end
  if (start === null || end === null) return true
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

export function historyCategory(item: HistoryItem) {
  return item.task_id.startsWith('live_') || item.filename === 'live_caption.pcm'
    ? '实时转录'
    : '一段语音转写'
}

function historyDateRange(item: HistoryItem) {
  const createdAt = new Date(item.created_at)
  const absoluteSegments = item.segments.filter((segment) => segment.start > 1_000_000_000)
  if (!absoluteSegments.length) return { start: createdAt, end: createdAt }
  return {
    start: new Date(Math.min(...absoluteSegments.map((segment) => segment.start)) * 1000),
    end: new Date(Math.max(...absoluteSegments.map((segment) => segment.end)) * 1000),
  }
}

export function buildLocalSummaryRecords(
  history: HistoryItem[],
  options: { date: string; endDate?: string; category?: string; startTime?: string; endTime?: string },
): ArchiveSummaryRecord[] {
  const dateRange = normalizeDateRange(options.date, options.endDate)
  return history.flatMap((item) => {
    const itemCategory = historyCategory(item)
    if (options.category && itemCategory !== options.category) return []
    const { start, end } = historyDateRange(item)
    if (!Number.isFinite(start.getTime())) return []
    if (!isWithinDateRange(start, dateRange.start, dateRange.end) && !isWithinDateRange(end, dateRange.start, dateRange.end)) return []
    if (!isWithinRange(start, options.startTime, options.endTime) && !isWithinRange(end, options.startTime, options.endTime)) return []
    const text = item.llm_outputs?.polish?.text?.trim()
      || item.llm_outputs?.translate?.text?.trim()
      || item.full_text.trim()
    if (!text) return []
    return [{
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      category: itemCategory,
      text,
    }]
  })
}
