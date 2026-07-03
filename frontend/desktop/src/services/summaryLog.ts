import type { ArchiveSummaryResult } from './api'

export function summaryLogFilename(result: ArchiveSummaryResult, now = new Date()) {
  const range = (result.time_range || 'all-day').replace(/[^0-9A-Za-z\u4e00-\u9fff_-]+/g, '-')
  const generatedAt = now.toISOString().replace(/[:.]/g, '-').replace('Z', '')
  return `summary_${result.date}_${range}_${generatedAt}.md`
}

export async function saveSummaryToLocalLog(result: ArchiveSummaryResult, archiveRoot?: string) {
  const api = window.electronAPI
  if (!api) return null
  return api.saveSummaryLog({
    archiveRoot: archiveRoot || undefined,
    date: result.date,
    filename: summaryLogFilename(result),
    content: result.summary,
  })
}
