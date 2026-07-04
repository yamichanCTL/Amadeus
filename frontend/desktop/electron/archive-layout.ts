import path from 'node:path'
import fs from 'node:fs/promises'

export function safeArchivePart(value: string, fallback: string, maxLength = 80) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, maxLength)
  return cleaned || fallback
}

export function safeArchiveStem(filename: string) {
  return safeArchivePart(path.parse(filename).name, 'audio')
}

export function localArchiveDay(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildTranscriptionArchivePaths(args: {
  root: string
  category: string
  day: string
  taskId: string
  filename: string
  audioExtension?: string
  hasAudio: boolean
}) {
  const category = safeArchivePart(args.category, '离线语音识别', 48)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : 'unknown-date'
  const stem = `${safeArchivePart(args.taskId, 'task')}_${safeArchiveStem(args.filename)}`
  const recordDir = path.join(args.root, category, day)
  const requestedExtension = String(args.audioExtension || path.extname(args.filename) || '.wav')
  const normalizedExtension = requestedExtension.startsWith('.') ? requestedExtension : `.${requestedExtension}`
  const extension = /^\.[A-Za-z0-9]{1,10}$/.test(normalizedExtension) ? normalizedExtension.toLowerCase() : '.wav'
  return {
    jsonDir: recordDir,
    audioDir: recordDir,
    json: path.join(recordDir, `${stem}.json`),
    audio: args.hasAudio ? path.join(recordDir, `${stem}${extension}`) : undefined,
  }
}

export async function writeTranscriptionArchive(args: {
  root: string
  category: string
  day: string
  taskId: string
  filename: string
  audioBase64?: string
  audioExtension?: string
  metadata: Record<string, unknown>
}) {
  const layout = buildTranscriptionArchivePaths({
    root: args.root,
    category: args.category,
    day: args.day,
    taskId: args.taskId,
    filename: args.filename,
    audioExtension: args.audioExtension,
    hasAudio: Boolean(args.audioBase64),
  })
  await fs.mkdir(layout.jsonDir, { recursive: true })
  if (args.audioBase64 && layout.audio) await fs.writeFile(layout.audio, Buffer.from(args.audioBase64, 'base64'))
  await fs.writeFile(layout.json, JSON.stringify({ archived_at: new Date().toISOString(), ...args.metadata }, null, 2), 'utf8')
  return { audio: layout.audio, json: layout.json }
}
