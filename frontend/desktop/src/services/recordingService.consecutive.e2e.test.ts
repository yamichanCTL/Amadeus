// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ filename: string; sentAt: number; respondedAt: number }>,
}))

const store = vi.hoisted(() => {
  const state: Record<string, any> = {
    recordStatus: 'idle',
    transcribeStatus: 'idle',
    liveCaptionStatus: 'idle',
    activeTaskId: null,
    currentResult: null,
    history: [],
    error: '',
    settings: {
      serverUrl: 'http://instant-asr.test',
      backendConfirmed: true,
      offlineEngine: 'sensevoice',
      timeoutSec: 20,
      defaultLanguage: 'auto',
      whisperModel: 'large-v3',
      enablePunctuation: true,
      allowServerDataCollection: false,
      archiveDir: '',
      userId: 'e2e',
      llmAutoTranslate: false,
      llmAutoPolish: false,
      translationProvider: '',
      translationModel: '',
      translationBaseUrl: '',
      translationApiToken: '',
      llmProvider: '',
      llmModel: '',
      llmBaseUrl: '',
      llmApiToken: '',
      llmTargetLanguage: 'English',
      llmStyle: '',
      injectMode: 'inject',
    },
  }
  Object.assign(state, {
    setRecordStatus: vi.fn((value: string) => { state.recordStatus = value }),
    setTranscribeStatus: vi.fn((value: string) => { state.transcribeStatus = value }),
    setActiveTaskId: vi.fn((value: string | null) => { state.activeTaskId = value }),
    setCurrentResult: vi.fn((value: unknown) => { state.currentResult = value }),
    setError: vi.fn((value: string) => { state.error = value }),
    addHistory: vi.fn((value: unknown) => { state.history.unshift(value) }),
    updateHistoryResult: vi.fn(),
  })
  return { state }
})

vi.mock('@/store/useASRStore', () => ({
  useASRStore: { getState: () => store.state },
}))

vi.mock('./audio', () => ({
  speechRecorder: { prepare: vi.fn(), cancel: vi.fn() },
  captureSpeakerAudio: vi.fn(),
  blobToBase64: vi.fn(async () => ''),
}))

vi.mock('./liveCaption', () => ({
  liveCaptionService: { stop: vi.fn(async () => undefined) },
}))

vi.mock('./telemetry', () => ({
  startTelemetryTrace: vi.fn(() => ({ startedAt: performance.now() })),
  recordTelemetryStage: vi.fn(),
  finishTelemetryTrace: vi.fn(),
}))

vi.mock('./api', () => ({
  ASRApi: class {
    async transcribe(_blob: Blob, filename: string) {
      const sentAt = performance.now()
      const respondedAt = performance.now()
      backend.calls.push({ filename, sentAt, respondedAt })
      const round = filename.includes('second') ? 2 : Number(filename.match(/round-(\d+)/)?.[1] || 1)
      return {
        task_id: `task-${round}`,
        status: 'success',
        full_text: `第${round}次识别`,
        segments: [],
        language: 'zh',
        engine_used: 'sensevoice',
        confidence: 0.99,
        duration_sec: 0.1,
        elapsed_sec: 0.001,
      }
    }
  },
  isAsyncResponse: vi.fn(() => false),
}))

import { RecordingService } from './recordingService'

type FillEvent = { text: string; calledAt: number; completedAt: number }

describe('consecutive offline ASR auto-fill latency', () => {
  beforeEach(() => {
    backend.calls.length = 0
    store.state.recordStatus = 'idle'
    store.state.transcribeStatus = 'idle'
    store.state.activeTaskId = null
    store.state.currentResult = null
    store.state.history.length = 0
    store.state.error = ''
    vi.restoreAllMocks()
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:e2e') })
  })

  it('fills the second result immediately when the first Electron injection is stuck', async () => {
    const fills: FillEvent[] = []
    let rejectActive: ((error: Error) => void) | null = null
    const injectText = vi.fn((text: string) => {
      const calledAt = performance.now()
      rejectActive?.(new Error('stale injection cancelled'))
      return (async () => {
        // Reproduce a UI Automation/helper stall on the first request. The
        // scheduler must cancel it when ASR #2 has already returned.
        if (text === '第1次识别') {
          await new Promise<never>((_resolve, reject) => { rejectActive = reject })
        }
        fills.push({ text, calledAt, completedAt: performance.now() })
        return true
      })()
    })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      injectText,
      hideStatusOverlay: vi.fn(async () => true),
      showStatusOverlay: vi.fn(async () => true),
      archiveTranscription: vi.fn(async () => ({ json: '' })),
      getDefaultArchiveDir: vi.fn(async () => ''),
    } })

    const service = new RecordingService()
    const audio = new Blob([new Uint8Array(1_024)], { type: 'audio/wav' })
    const first = service.runTranscription(audio, 'first.wav', true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = service.runTranscription(audio, 'second.wav', true)
    await Promise.all([first, second])

    const secondRequest = backend.calls.find((call) => call.filename === 'second.wav')!
    const secondFill = fills.find((fill) => fill.text === '第2次识别')!
    const sendToFillMs = secondFill.completedAt - secondRequest.sentAt
    expect(sendToFillMs, `第二次发送→回填耗时 ${sendToFillMs.toFixed(1)} ms`).toBeLessThan(500)
  }, 5_000)

  it('keeps 30 immediate-backend offline recognition fills below 500ms', async () => {
    const fills: FillEvent[] = []
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      injectText: vi.fn(async (text: string) => {
        const calledAt = performance.now()
        fills.push({ text, calledAt, completedAt: performance.now() })
        return true
      }),
      hideStatusOverlay: vi.fn(async () => true),
      showStatusOverlay: vi.fn(async () => true),
      archiveTranscription: vi.fn(async () => ({ json: '' })),
      getDefaultArchiveDir: vi.fn(async () => ''),
    } })

    const service = new RecordingService()
    const audio = new Blob([new Uint8Array(1_024)], { type: 'audio/wav' })
    for (let round = 1; round <= 30; round += 1) {
      await service.runTranscription(audio, `round-${round}.wav`, true)
    }

    const latencies = backend.calls.map((request, index) => fills[index].completedAt - request.sentAt)
    const sorted = [...latencies].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    const max = sorted[sorted.length - 1]
    console.info(`[offline ASR fill stress] runs=30 p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`)
    expect(fills).toHaveLength(30)
    expect(max).toBeLessThan(500)
  })
})
