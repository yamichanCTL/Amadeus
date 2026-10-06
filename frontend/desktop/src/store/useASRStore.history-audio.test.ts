import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore, type HistoryItem } from './useASRStore'

const record: HistoryItem = { id: 'audio', task_id: 'audio', status: 'success', full_text: '测试音频', segments: [], language: 'zh', engine_used: 'formalasr', confidence: null,
  duration_sec: 1, elapsed_sec: 1, filename: 'audio.wav', created_at: '2026-10-06T00:00:00+08:00', audio_url: 'blob:old-renderer-audio', archived_audio: 'F:/AmadeusData/archive/audio.wav' }

beforeEach(() => { localStorage.clear(); useASRStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), history: [] }) })

describe('archived history audio after restart', () => {
  it('persists the archive path but never a transient blob URL, retaining immediate playback in memory', () => {
    useASRStore.getState().addHistory(record)
    const saved = JSON.parse(localStorage.getItem('asr-desktop-store')!)
    expect(saved.state.history[0].audio_url).toBeUndefined()
    expect(saved.state.history[0].archived_audio).toBe(record.archived_audio)
    expect(useASRStore.getState().history[0].audio_url).toBe(record.audio_url)
  })

  it('migrates legacy stored blob URLs to archive playback without changing the archived file', async () => {
    localStorage.setItem('asr-desktop-store', JSON.stringify({ version: 46, state: { settings: DEFAULT_SETTINGS, history: [record] } }))
    await useASRStore.persist.rehydrate()
    expect(useASRStore.getState().history[0].audio_url).toBeUndefined()
    expect(useASRStore.getState().history[0].archived_audio).toBe(record.archived_audio)
  })
})
