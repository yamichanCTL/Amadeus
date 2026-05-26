import type { Segment, TranscribeResponse } from './api'

function pad(value: number, size = 2) {
  return String(Math.floor(value)).padStart(size, '0')
}

export function formatTimestamp(seconds: number, separator = ',') {
  const safe = Math.max(0, seconds || 0)
  const hours = safe / 3600
  const minutes = (safe % 3600) / 60
  const secs = safe % 60
  const millis = Math.round((secs - Math.floor(secs)) * 1000)
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`
}

export function segmentsToSrt(segments: Segment[]) {
  return segments
    .map((segment, index) => {
      const text = segment.speaker ? `[${segment.speaker}] ${segment.text}` : segment.text
      return `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${text.trim()}`
    })
    .join('\n\n')
}

export function resultToTxt(result: TranscribeResponse) {
  return result.full_text || result.segments.map((segment) => segment.text).join('\n')
}

export function resultToJson(result: TranscribeResponse) {
  return JSON.stringify(result, null, 2)
}

export async function saveResult(result: TranscribeResponse, filename: string, type: 'txt' | 'srt' | 'json') {
  const api = window.electronAPI
  const content = type === 'txt' ? resultToTxt(result) : type === 'srt' ? segmentsToSrt(result.segments) : resultToJson(result)
  const target = await api?.saveFileDialog(filename)
  if (!target) return false
  return api?.writeFile(target, content)
}

export async function saveText(content: string, filename: string) {
  const api = window.electronAPI
  const target = await api?.saveFileDialog(filename)
  if (!target) return false
  return api?.writeFile(target, content)
}

export async function copyText(text: string) {
  if (window.electronAPI) return window.electronAPI.textToClipboard(text)
  await navigator.clipboard.writeText(text)
  return true
}
