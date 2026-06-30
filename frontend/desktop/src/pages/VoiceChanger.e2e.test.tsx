// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let relayActive = true
  let referenceDelayMs = 0
  let resolveTts: ((value: unknown) => void) | null = null
  return {
    recorderStart: vi.fn(async () => undefined),
    recorderStop: vi.fn(async () => ({
      blob: new Blob([new Uint8Array(4096)], { type: 'audio/wav' }),
      durationSec: 1,
      mimeType: 'audio/wav',
    })),
    relayCreateInputStream: vi.fn(() => new MediaStream()),
    referenceAudioAsr: vi.fn(async () => {
      if (referenceDelayMs) await new Promise((resolve) => setTimeout(resolve, referenceDelayMs))
      return {
        text: '后端已经返回的识别文本',
        engine: 'sensevoice',
        language: 'zh',
        confidence: 0.99,
        elapsed_sec: referenceDelayMs / 1000,
      }
    }),
    higgsAudioToSpeech: vi.fn(() => new Promise(() => undefined)),
    higgsSpeak: vi.fn(() => new Promise((resolve) => { resolveTts = resolve })),
    voiceStreamStart: vi.fn(async (_config: Record<string, unknown>) => undefined),
    reset() {
      relayActive = true
      referenceDelayMs = 0
      resolveTts = null
    },
    get relayActive() { return relayActive },
    set relayActive(value: boolean) { relayActive = value },
    set referenceDelayMs(value: number) { referenceDelayMs = value },
    resolveTts(value: unknown) { resolveTts?.(value) },
  }
})

vi.mock('@/services/api', () => ({
  ASRApi: class {
    higgsConnection = vi.fn(async () => ({ connected: true, elapsed_sec: 0.01 }))
    higgsVoices = vi.fn(async () => ({ voices: ['Elysia'] }))
    higgsVoicePresets = vi.fn(async () => ({ presets: [], voices: [] }))
    referenceAudioAsr = mocks.referenceAudioAsr
    higgsAudioToSpeech = mocks.higgsAudioToSpeech
    higgsSpeak = mocks.higgsSpeak
  },
}))

vi.mock('@/services/audio', () => ({
  AudioRecorder: class {
    prepare = vi.fn(async () => undefined)
    takePreparedStream = vi.fn(() => undefined)
    start = mocks.recorderStart
    stop = mocks.recorderStop
    cancel = vi.fn()
  },
  AudioRelayMixer: class {
    isActive = () => mocks.relayActive
    createInputStream = mocks.relayCreateInputStream
    start = vi.fn(async () => ({ sinkApplied: true }))
    stop = vi.fn()
    setOutputDevice = vi.fn(async () => undefined)
    playBlob = vi.fn(async () => undefined)
    pushPcm16 = vi.fn(async () => undefined)
    getPcmPlaybackRemainingMs = vi.fn(async () => 0)
  },
  Pcm16ChunkPlayer: class {
    start = vi.fn(async () => undefined)
    push = vi.fn(async () => undefined)
    stop = vi.fn()
    getPlaybackRemainingMs = vi.fn(async () => 0)
  },
  VoiceTTSStreamingClient: class {
    start = mocks.voiceStreamStart
    stop = vi.fn()
    setOutputPlaybackActive = vi.fn()
  },
  listAudioOutputDevices: vi.fn(async () => []),
  playAudioBlob: vi.fn(async () => ({ audio: new Audio(), url: 'blob:output', sinkApplied: true })),
  playAudioBlobToDevice: vi.fn(async () => ({ stop: vi.fn(), sinkApplied: true, sampleRate: 48000 })),
  testAudioOutputDevice: vi.fn(async () => ({ sinkApplied: true, sampleRate: 48000 })),
}))

const store = vi.hoisted(() => ({
  state: {
    settings: {
      serverUrl: 'http://backend.test',
      backendConfirmed: true,
      audioInputDeviceId: 'physical-microphone-id',
      audioOutputDeviceId: 'virtual-cable-output',
      offlineEngine: 'sensevoice',
      streamingEngine: 'x-asr',
      defaultLanguage: 'zh',
      higgsTtsProvider: 'local',
      higgsTtsBaseUrl: 'http://localhost:8002',
      higgsTtsRemoteBaseUrl: '',
      higgsTtsApiToken: '',
      higgsTtsRemoteModel: 'higgs-audio-v3-tts',
      higgsTtsVoice: 'Elysia',
      higgsTtsVoices: ['Elysia'],
      higgsTtsFormat: 'wav',
      higgsTtsSpeed: 1,
      higgsTtsTemperature: 0.7,
      higgsTtsTopP: 0.95,
      higgsTtsTopK: 50,
      higgsTtsSeed: -1,
      higgsTtsMaxNewTokens: 2048,
      higgsTtsReferenceAudioDataUrl: '',
      higgsTtsReferenceAudioName: '',
      higgsTtsReferenceUrl: '',
      higgsTtsReferenceText: '',
      higgsTtsReferenceCodesJson: '',
      higgsTtsEmotion: '',
      higgsTtsStyle: '',
      higgsTtsProsodySpeed: '',
      higgsTtsPitch: '',
      higgsTtsExpressiveness: '',
      higgsTtsInitialCodecChunkFrames: 1,
    },
    updateSettings: vi.fn(),
  },
}))

vi.mock('@/store/useASRStore', () => {
  const useASRStore = (selector: (value: typeof store.state) => unknown) => selector(store.state)
  return { useASRStore }
})

vi.mock('@/services/telemetry', () => ({
  startTelemetryTrace: vi.fn(() => ({ id: 'trace', name: 'test', category: 'tts', startedAt: 0, lastAt: 0 })),
  recordTelemetryStage: vi.fn(),
  finishTelemetryTrace: vi.fn(),
}))

import { VoiceChangerPage } from './VoiceChanger'

describe('VoiceChanger end-to-end ASR delivery and microphone isolation', () => {
  beforeEach(() => {
    mocks.reset()
    vi.clearAllMocks()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    })
    vi.stubGlobal('MediaStream', class {})
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        showStatusOverlay: vi.fn(async () => true),
        hideStatusOverlay: vi.fn(async () => true),
      },
    })
  })

  afterEach(() => cleanup())

  it('shows the ASR result within 500ms while TTS is still pending', async () => {
    mocks.referenceDelayMs = 220
    render(<VoiceChangerPage />)

    fireEvent.click(screen.getByRole('button', { name: '录音' }))
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledTimes(1))
    const requestStartedAt = performance.now()
    fireEvent.click(screen.getByRole('button', { name: '停止并处理' }))
    await screen.findByText('后端已经返回的识别文本', {}, { timeout: 500 })
    expect(performance.now() - requestStartedAt).toBeLessThan(500)
    expect(mocks.referenceAudioAsr).toHaveBeenCalledTimes(1)
    expect(mocks.higgsSpeak).toHaveBeenCalledTimes(1)
    expect(mocks.higgsAudioToSpeech).not.toHaveBeenCalled()
  })

  it('records from the selected physical microphone even when relay output is active', async () => {
    render(<VoiceChangerPage />)

    fireEvent.click(screen.getByRole('button', { name: '录音' }))
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledTimes(1))

    expect(mocks.recorderStart).toHaveBeenCalledWith(
      'physical-microphone-id',
      undefined,
      expect.any(Function),
    )
    expect(mocks.relayCreateInputStream).not.toHaveBeenCalled()
  })

  it('keeps realtime ASR on the selected microphone instead of the relay mix', async () => {
    render(<VoiceChangerPage />)

    fireEvent.click(screen.getByRole('button', { name: '实时 ASR + TTS' }))
    fireEvent.click(screen.getByRole('button', { name: '开始实时 ASR + TTS' }))
    await waitFor(() => expect(mocks.voiceStreamStart).toHaveBeenCalledTimes(1))

    const config = mocks.voiceStreamStart.mock.calls[0][0]
    expect(config.deviceId).toBe('physical-microphone-id')
    expect('inputStreamFactory' in config).toBe(false)
    expect(mocks.relayCreateInputStream).not.toHaveBeenCalled()
  })

  it('passes 30 consecutive ASR-to-DOM fill cycles under the 500ms budget', async () => {
    const latencies: number[] = []
    for (let index = 0; index < 30; index += 1) {
      render(<VoiceChangerPage />)
      fireEvent.click(screen.getByRole('button', { name: '录音' }))
      await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledTimes(index + 1))
      fireEvent.click(screen.getByRole('button', { name: '停止并处理' }))
      const receivedAt = performance.now()
      await screen.findByText('后端已经返回的识别文本', {}, { timeout: 500 })
      latencies.push(performance.now() - receivedAt)
      cleanup()
    }

    const ordered = [...latencies].sort((a, b) => a - b)
    const p50 = ordered[Math.floor(ordered.length * 0.5)]
    const p95 = ordered[Math.floor(ordered.length * 0.95)]
    const maximum = ordered.at(-1) || 0
    console.info(`[ASR fill stress] runs=${latencies.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${maximum.toFixed(1)}ms`)
    expect(maximum).toBeLessThan(500)
  })
})
