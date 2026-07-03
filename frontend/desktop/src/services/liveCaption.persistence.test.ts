// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    })
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
})
