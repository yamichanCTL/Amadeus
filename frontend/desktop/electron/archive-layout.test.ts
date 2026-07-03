import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildTranscriptionArchivePaths, localArchiveDay, writeTranscriptionArchive } from './archive-layout'

describe('transcription archive layout', () => {
  it('uses media/category/day directory levels for realtime audio and JSON', () => {
    const result = buildTranscriptionArchivePaths({
      root: path.join('D:', 'Amadeus'),
      category: '实时识别',
      day: '2026-07-02',
      taskId: 'live_123',
      filename: 'live_caption.wav',
      audioExtension: '.wav',
      hasAudio: true,
    })

    expect(result.audio).toBe(path.join('D:', 'Amadeus', 'wav', '实时识别', '2026-07-02', 'live_123_live_caption.wav'))
    expect(result.json).toBe(path.join('D:', 'Amadeus', 'json', '实时识别', '2026-07-02', 'live_123_live_caption.json'))
  })

  it('sanitizes a caller-provided category instead of allowing nested paths', () => {
    const result = buildTranscriptionArchivePaths({
      root: '/archive',
      category: '../离线语音识别',
      day: '2026-07-04',
      taskId: 'task',
      filename: 'recording.webm',
      hasAudio: false,
    })

    expect(result.json).not.toContain('../')
    expect(result.audio).toBeUndefined()
  })

  it('uses the desktop local calendar day and rejects unsafe extensions', () => {
    expect(localArchiveDay(new Date(2026, 6, 4, 0, 5))).toBe('2026-07-04')
    const result = buildTranscriptionArchivePaths({
      root: '/archive', category: '实时识别', day: '2026-07-04', taskId: 'task',
      filename: 'recording.wav', audioExtension: '../../escape', hasAudio: true,
    })
    expect(result.audio).toBe(path.join('/archive', 'wav', '实时识别', '2026-07-04', 'task_recording.wav'))
  })

  it('writes realtime WAV and JSON into their actual deep directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-archive-'))
    try {
      const paths = await writeTranscriptionArchive({
        root, category: '实时识别', day: '2026-07-02', taskId: 'live_456', filename: 'live_caption.wav',
        audioBase64: Buffer.from('RIFF-WAVE').toString('base64'), audioExtension: '.wav', metadata: { full_text: '实时内容' },
      })
      expect(paths.audio).toContain(path.join('wav', '实时识别', '2026-07-02'))
      expect(paths.json).toContain(path.join('json', '实时识别', '2026-07-02'))
      expect(await fs.readFile(paths.audio!, 'utf8')).toBe('RIFF-WAVE')
      expect(JSON.parse(await fs.readFile(paths.json, 'utf8')).full_text).toBe('实时内容')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
