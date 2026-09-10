export type MeetingExcerpt = { target: string; preceding: string; recent?: string; focus?: 'recent_window'; truncated?: boolean }

export function selectMeetingExcerpt(text: string, start: number, end: number): MeetingExcerpt {
  return { target: text.slice(start, end).trim().slice(0, 96000), preceding: text.slice(0, start).trim().slice(-8000) }
}

export function latestMeetingExcerpt(text: string): MeetingExcerpt {
  const trimmed = text.trimEnd()
  // A streaming hypothesis may have no punctuation. Show an editable recent
  // excerpt in that case, rather than claiming to know a sentence boundary.
  const beforeEnding = trimmed.replace(/[。！？!?；;.\s]+$/, '')
  const boundary = Math.max(...['。', '！', '？', '!', '?', '；', ';', '\n'].map((mark) => beforeEnding.lastIndexOf(mark)))
  const english = beforeEnding.lastIndexOf('. ')
  const start = Math.max(boundary + 1, english < 0 ? 0 : english + 2, trimmed.length - 600, 0)
  return selectMeetingExcerpt(trimmed, start, trimmed.length)
}

function normalizeCommand(text: string) {
  let value = ''
  const starts: number[] = [], ends: number[] = []
  // Keep original UTF-16 offsets: normalization can remove or expand characters.
  // Include combining marks with their base so composed/decomposed text agrees.
  for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const normalized = match[0].normalize('NFKC').toLowerCase().replace(/[\p{P}\s\p{Cf}]/gu, '')
    value += normalized
    for (let index = 0; index < normalized.length; index++) {
      starts.push(match.index!)
      ends.push(match.index! + match[0].length)
    }
  }
  return { value, starts, ends }
}

export function meetingKeyword(text: string, keyword: string): { count: number; start: number; end: number; excerpt: MeetingExcerpt } | null {
  const command = normalizeCommand(keyword).value
  // Punctuation-only input must never match every position in the transcript.
  if (!/[\p{L}\p{N}]/u.test(command)) return null
  const normalized = normalizeCommand(text)
  const wordChar = /[\p{Script=Latin}\p{N}_]/u
  let count = 0, from = 0, lastStart = 0, lastEnd = 0
  let excerpt: MeetingExcerpt | null = null
  while (from < normalized.value.length) {
    const position = normalized.value.indexOf(command, from)
    if (position < 0) break
    const start = normalized.starts[position]
    const end = normalized.ends[position + command.length - 1]
    from = position + command.length
    // Do not trigger an English command inside a longer word (e.g. "thisway").
    const before = Array.from(text.slice(Math.max(0, start - 2), start).normalize('NFKC')).pop() || ''
    const after = Array.from(text.slice(end, end + 2).normalize('NFKC'))[0] || ''
    if ((wordChar.test(command[0]) && wordChar.test(before)) ||
        (wordChar.test(command[command.length - 1]) && wordChar.test(after))) continue
    excerpt = {
      ...latestMeetingExcerpt(text.slice(0, start)),
      focus: 'recent_window',
    }
    lastStart = start; lastEnd = end
    count++
  }
  return excerpt ? { count, start: lastStart, end: lastEnd, excerpt } : null
}


export type MeetingPreferences = {
  lookbackSeconds: number; recentSeconds: number; recentWeight: number
  presetPrompt: string; focusPoints: string; useContext: boolean
  keywordEnabled: boolean; keyword: string; shortcutEnabled: boolean; shortcut: string
}
export const MEETING_PREFERENCES_KEY = 'amadeus.meeting.preferences.v3'
export const DEFAULT_MEETING_PREFERENCES: MeetingPreferences = {
  lookbackSeconds: 3600, recentSeconds: 60, recentWeight: 3, presetPrompt: '', focusPoints: '',
  useContext: true, keywordEnabled: false, keyword: '解释一下刚才这句话',
  shortcutEnabled: true, shortcut: 'Ctrl+Alt+KeyE',
}
export function readMeetingPreferences(): MeetingPreferences {
  try {
    const current = localStorage.getItem(MEETING_PREFERENCES_KEY)
    const stored = JSON.parse(current || localStorage.getItem('amadeus.meeting.preferences.v2') || '{}')
    if (!current) {
      if (stored.lookbackSeconds === 120) stored.lookbackSeconds = 3600
      if (stored.recentSeconds === 30) stored.recentSeconds = 60
    }
    const result = { ...DEFAULT_MEETING_PREFERENCES }
    for (const key of Object.keys(result) as (keyof MeetingPreferences)[]) {
      if (typeof stored[key] === typeof result[key]) Object.assign(result, { [key]: stored[key] })
    }
    const clamp = (n: number, min: number, max: number, fallback: number) => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
    result.lookbackSeconds = clamp(result.lookbackSeconds, 10, 3600, 3600)
    result.recentSeconds = clamp(result.recentSeconds, 5, result.lookbackSeconds, 60)
    result.recentWeight = clamp(result.recentWeight, 1, 5, 3)
    result.presetPrompt = result.presetPrompt.slice(0, 4000)
    result.focusPoints = result.focusPoints.slice(0, 2000)
    result.keyword = result.keyword.slice(0, 60)
    if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)+(?:Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2])$/.test(result.shortcut)) result.shortcut = DEFAULT_MEETING_PREFERENCES.shortcut
    return result
  } catch { return { ...DEFAULT_MEETING_PREFERENCES } }
}

export function shortcutFromEvent(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'code'>): string | null {
  if (!(event.ctrlKey || event.altKey || event.metaKey) || !/^(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2])$/.test(event.code)) return null
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code].filter(Boolean).join('+')
}
export const shortcutLabel = (shortcut: string) => shortcut.replace(/Key|Digit/g, '').replace(/\+/g, ' + ')

// ASR supplies revisable cumulative text, not word timestamps. Preserve the
// first-seen times of revisions and timestamp new suffixes using a monotonic clock.
export class MeetingTimeline {
  text = ''
  offset = 0
  times: number[] = []
  update(text: string, now: number) {
    const offset = Math.max(0, text.length - 128000)
    if (offset >= this.offset) {
      this.text = this.text.slice(offset - this.offset)
      this.times = this.times.slice(offset - this.offset)
    } else { this.text = ''; this.times = [] }
    this.offset = offset
    text = text.slice(offset)
    let prefix = 0
    while (prefix < this.text.length && prefix < text.length && this.text[prefix] === text[prefix]) prefix++
    let suffix = 0
    while (suffix < this.text.length - prefix && suffix < text.length - prefix && this.text[this.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++
    const oldEnd = this.text.length - suffix, newEnd = text.length - suffix
    const replacement = Array.from({ length: newEnd - prefix }, (_, index) => {
      if (suffix && oldEnd > prefix) return this.times[prefix + Math.min(oldEnd - prefix - 1, Math.floor(index * (oldEnd - prefix) / Math.max(1, newEnd - prefix)))]
      return this.times[prefix + index] ?? now
    })
    this.times = [...this.times.slice(0, prefix), ...replacement, ...(suffix ? this.times.slice(-suffix) : [])]
    this.text = text
  }
  excerpt(now: number, preferences: MeetingPreferences, end = this.text.length, keyword = ''): MeetingExcerpt {
    const cutoff = now - preferences.lookbackSeconds * 1000
    let start = 0
    while (start < end && this.times[start] < cutoff) start++
    const truncated = end - start > 96000 || (this.offset > 0 && this.times[0] >= cutoff)
    start = Math.max(start, end - 96000)
    let recentStart = start
    while (recentStart < end && this.times[recentStart] < now - preferences.recentSeconds * 1000) recentStart++
    const stripCommands = (text: string) => {
      let found = keyword ? meetingKeyword(text, keyword) : null
      while (found) {
        text = text.slice(0, found.start) + text.slice(found.end)
        found = meetingKeyword(text, keyword)
      }
      return text.trim().replace(/^[。！？!?，,；;\s]+|[\s]+$/g, '')
    }
    const target = stripCommands(this.text.slice(start, end))
    let recent = stripCommands(this.text.slice(Math.max(recentStart, end - 8000), end))
    // A time/length boundary may land inside an earlier command. Keep only the
    // suffix that is also present in the cleaned target.
    while (recent && !target.includes(recent)) recent = recent.slice(1)
    return {
      target,
      preceding: stripCommands(this.text.slice(Math.max(0, start - 8000), start)),
      recent,
      focus: 'recent_window',
      truncated,
    }
  }
}
