// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let streamEvent: ((event: any) => void) | null = null
const startStream = vi.fn(async () => undefined)
const stopStream = vi.fn(() => streamEvent?.({
  type: 'closed',
  intentional: true,
  recording: {
    blob: new Blob(['wav'], { type: 'audio/wav' }),
    sampleRate: 16000,
    samples: 16000,
    durationSec: 1,
  },
}))

vi.mock('./audio', () => ({
  StreamingASRClient: class {
    constructor(_serverUrl: string, callback: (event: any) => void) { streamEvent = callback }
    start = startStream
    stop = stopStream
  },
  speechRecorder: { takePreparedStream: vi.fn(() => undefined) },
  audioRelayMixer: { isActive: vi.fn(() => false), createInputStream: vi.fn() },
  captureSpeakerAudio: vi.fn(),
  blobToBase64: vi.fn(async () => 'd2F2'),
}))

import { LiveCaptionService } from './liveCaption'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

afterEach(() => vi.useRealTimers())

describe('live caption local persistence', () => {
  beforeEach(() => {
    streamEvent = null
    vi.clearAllMocks()
    useASRStore.setState({
      settings: { ...DEFAULT_SETTINGS, serverUrl: 'http://127.0.0.1:8000', backendConfirmed: true, archiveDir: 'D:/Amadeus' },
      currentResult: null,
      history: [],
      liveUtterances: [],
      recordStatus: 'idle',
      transcribeStatus: 'idle',
      liveCaptionStatus: 'idle',
      asrModelLoading: false,
    })
  })

  it('does not start streaming while a model load is still running after navigation', async () => {
    useASRStore.setState({ asrModelLoading: true })
    const service = new LiveCaptionService()
    await service.start()
    expect(startStream).not.toHaveBeenCalled()
    expect(useASRStore.getState().liveCaptionStatus).toBe('idle')
    useASRStore.setState({ asrModelLoading: false })
  })

  it('fills the software result on each final and archives realtime WAV on stop', async () => {
    const archiveTranscription = vi.fn(async () => ({
      audio: 'D:/Amadeus/wav/实时识别/2026-07-04/live.wav',
      json: 'D:/Amadeus/json/实时识别/2026-07-04/live.json',
    }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        showCaptionOverlay: vi.fn(async () => true),
        hideCaptionOverlay: vi.fn(async () => true),
        notifyLiveCaptionState: vi.fn(),
        archiveTranscription,
      },
    })
    const service = new LiveCaptionService()
    await service.start()
    streamEvent?.({ type: 'speech_start' })
    streamEvent?.({ type: 'final', text: '实时结果已回填', language: 'zh' })

    expect(useASRStore.getState().currentResult?.full_text).toContain('实时结果已回填')

    await service.stop()
    await vi.waitFor(() => expect(archiveTranscription).toHaveBeenCalled())
    expect(archiveTranscription).toHaveBeenCalledWith(expect.objectContaining({
      archiveCategory: '实时识别',
      filename: 'live_caption.wav',
      audioBase64: 'd2F2',
      audioExtension: '.wav',
    }))
    expect(useASRStore.getState().history[0]?.archived_audio).toContain('/wav/实时识别/')
  })

  it('releases recognition after a failed start even when no client remains', async () => {
    const hideCaptionOverlay = vi.fn(async () => true)
    const notifyLiveCaptionState = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { showCaptionOverlay: vi.fn(async () => true), hideCaptionOverlay, notifyLiveCaptionState } })
    startStream.mockRejectedValueOnce(new Error('microphone unavailable'))
    const service = new LiveCaptionService()
    await expect(service.start()).rejects.toThrow('microphone unavailable')
    expect(service.isActive).toBe(false)
    expect(useASRStore.getState().liveCaptionStatus).toBe('error')
    await service.stop()
    expect(useASRStore.getState().liveCaptionStatus).toBe('idle')
    expect(useASRStore.getState().settings.liveCaptionEnabled).toBe(false)
    expect(hideCaptionOverlay).toHaveBeenCalled()
    expect(notifyLiveCaptionState).toHaveBeenCalledWith(false)
    await service.start()
    expect(service.isActive).toBe(true)
    await service.stop()
  })

  it('stores subtitle times relative to capture startup while preserving wall-clock text and archive metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-06T00:00:00+08:00'))
    const archiveTranscription = vi.fn(async () => null)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { showCaptionOverlay: vi.fn(async () => true), hideCaptionOverlay: vi.fn(async () => true), notifyLiveCaptionState: vi.fn(), archiveTranscription } })
    const service = new LiveCaptionService()
    await service.start()
    vi.setSystemTime(new Date('2026-10-06T00:00:05+08:00'))
    streamEvent?.({ type: 'configured' })
    vi.setSystemTime(new Date('2026-10-06T00:00:08+08:00'))
    streamEvent?.({ type: 'speech_start' })
    vi.setSystemTime(new Date('2026-10-06T00:00:09+08:00'))
    streamEvent?.({ type: 'final', text: '字幕内容', language: 'zh' })
    expect(useASRStore.getState().currentResult?.segments).toEqual([{ text: '字幕内容', start: 3, end: 4 }])
    expect(useASRStore.getState().currentResult?.full_text).toContain('00:00:08')
    await service.stop()
    await Promise.resolve()
    expect(archiveTranscription).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ spoken_at: { start: '2026-10-05T16:00:08.000Z', end: '2026-10-05T16:00:09.000Z' } }) }))
  })
})
