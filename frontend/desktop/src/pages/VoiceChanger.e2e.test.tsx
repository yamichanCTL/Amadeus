// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let relayActive = true
  let referenceDelayMs = 0
  let resolveTts: ((value: unknown) => void) | null = null
  let streamEvent: ((event: Record<string, unknown>) => void) | null = null
  return {
    recorderStart: vi.fn(async (): Promise<void> => undefined),
    recorderPrepare: vi.fn(async () => undefined),
    recorderCancel: vi.fn(),
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
    voiceStreamStop: vi.fn(),
    stopInjectedAudio: vi.fn(),
    relayStop: vi.fn(),
    relayStart: vi.fn(async () => ({ sinkApplied: true })),
    devicePlay: vi.fn(async (_blob: Blob, _device?: string) => ({ stop: vi.fn(), sinkApplied: true, sampleRate: 48000 })),
    set streamEvent(value: ((event: Record<string, unknown>) => void) | null) { streamEvent = value },
    emitStream(event: Record<string, unknown>) { streamEvent?.(event) },
    reset() {
      relayActive = true
      referenceDelayMs = 0
      resolveTts = null
      streamEvent = null
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
    prepare = mocks.recorderPrepare
    takePreparedStream = vi.fn(() => undefined)
    start = mocks.recorderStart
    stop = mocks.recorderStop
    cancel = mocks.recorderCancel
  },
  AudioRelayMixer: class {
    isActive = () => mocks.relayActive
    createInputStream = mocks.relayCreateInputStream
    start = mocks.relayStart
    stop = mocks.relayStop
    stopInjectedAudio = mocks.stopInjectedAudio
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
    constructor(_url: string, onEvent: (event: Record<string, unknown>) => void) { mocks.streamEvent = onEvent }
    start = mocks.voiceStreamStart
    stop = mocks.voiceStreamStop
    setOutputPlaybackActive = vi.fn()
  },
  listAudioOutputDevices: vi.fn(async () => []),
  playAudioBlob: vi.fn(async () => ({ audio: new Audio(), url: 'blob:output', sinkApplied: true })),
  playAudioBlobToDevice: mocks.devicePlay,
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
vi.mock('@/pages/Models', () => ({ ModelsPage: () => <div>模型配置占位</div> }))

import { VoiceChangerPage } from './VoiceChanger'
import { useActivityStore } from '@/services/activity'

describe('VoiceChanger end-to-end ASR delivery and microphone isolation', () => {
  beforeEach(() => {
    mocks.reset()
    vi.clearAllMocks()
    useActivityStore.setState({ tasks: {} })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
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

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('shows the ASR result within 500ms while TTS is still pending', async () => {
    mocks.referenceDelayMs = 220
    render(<VoiceChangerPage />)

    fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))

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

    fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))

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

    fireEvent.click(screen.getByRole('button', { name: /实时转换/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始实时转换' }))
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
      fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))
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

  it('starts in text mode and never opens the microphone just by switching tasks', () => {
    render(<VoiceChangerPage />)
    expect(screen.getByLabelText('合成文本')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '启用中转' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))
    expect(mocks.recorderPrepare).not.toHaveBeenCalled()
    expect(mocks.recorderStart).not.toHaveBeenCalled()
  })

  it('keeps stop actions and the global activity available after switching away from recording', async () => {
    render(<VoiceChangerPage />)
    fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))
    fireEvent.click(screen.getByRole('button', { name: '录音' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止并处理' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /文字合成/ }))
    expect(screen.getByRole('button', { name: '取消录音' })).toBeTruthy()
    expect(useActivityStore.getState().tasks['voice-work'].label).toContain('录音中')
    act(() => { void useActivityStore.getState().tasks['voice-work'].onStop?.() })
    expect(mocks.recorderCancel).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '取消录音' })).toBeNull()
    expect(useActivityStore.getState().tasks['voice-work']).toBeUndefined()
    expect(mocks.referenceAudioAsr).not.toHaveBeenCalled()
  })

  it('cancels microphone startup on unmount and cleans up a late startup completion', async () => {
    let release!: () => void
    mocks.recorderStart.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const view = render(<VoiceChangerPage />)
    fireEvent.click(screen.getByRole('button', { name: /语音转换/ }))
    fireEvent.click(screen.getByRole('button', { name: '录音' }))
    view.unmount()
    expect(mocks.recorderCancel).toHaveBeenCalledTimes(1)
    await act(async () => { release(); await Promise.resolve() })
    expect(mocks.recorderCancel).toHaveBeenCalledTimes(2)
    expect(useActivityStore.getState().tasks['voice-work']).toBeUndefined()
  })

  it('stops realtime capture across task switches and ignores old events', async () => {
    render(<VoiceChangerPage />)
    fireEvent.click(screen.getByRole('button', { name: /实时转换/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始实时转换' }))
    fireEvent.click(screen.getByRole('button', { name: /文字合成/ }))
    fireEvent.click(screen.getByRole('button', { name: '停止实时模式' }))
    expect(mocks.voiceStreamStop).toHaveBeenCalled()
    act(() => mocks.emitStream({ type: 'final', text: '已停止会话的迟到文字' }))
    expect(screen.queryByText('已停止会话的迟到文字')).toBeNull()
    expect(useActivityStore.getState().tasks['voice-work']).toBeUndefined()
  })

  it('drops a cancelled synthesis result and sends only when explicitly requested', async () => {
    mocks.relayActive = false
    render(<VoiceChangerPage />)
    fireEvent.change(screen.getByLabelText('合成文本'), { target: { value: '你好' } })
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }))
    fireEvent.click(screen.getByRole('button', { name: '取消等待' }))
    const result = { audio: new Blob(['fixture'], { type: 'audio/wav' }), text: '你好', timing: { tts_sec: 0.2, total_sec: 0.2 } }
    await act(async () => { mocks.resolveTts(result); await Promise.resolve() })
    expect(screen.queryByLabelText('合成语音本机试听')).toBeNull()
    expect(mocks.devicePlay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }))
    await act(async () => { mocks.resolveTts(result); await Promise.resolve() })
    expect(screen.getByLabelText('合成语音本机试听')).toBeTruthy()
    expect(mocks.devicePlay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送到所选输出设备' }))
    await waitFor(() => expect(mocks.devicePlay).toHaveBeenCalledWith(result.audio, 'virtual-cable-output'))
  })

  it('cleans up a pending relay start when leaving the page', async () => {
    mocks.relayActive = false
    let release!: (value: { sinkApplied: boolean }) => void
    mocks.relayStart.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const view = render(<VoiceChangerPage />)
    fireEvent.click(screen.getByRole('button', { name: /直播混音与音效/ }))
    fireEvent.click(screen.getByRole('button', { name: '启用中转' }))
    expect(useActivityStore.getState().tasks['voice-relay']).toBeTruthy()
    view.unmount()
    await act(async () => { release({ sinkApplied: true }); await Promise.resolve() })
    expect(mocks.relayStop).toHaveBeenCalledTimes(2)
    expect(useActivityStore.getState().tasks['voice-relay']).toBeUndefined()
  })

  it('stops the microphone stream when realtime reports an error', async () => {
    render(<VoiceChangerPage />)
    fireEvent.click(screen.getByRole('button', { name: /实时转换/ }))
    fireEvent.click(screen.getByRole('button', { name: '开始实时转换' }))
    act(() => mocks.emitStream({ type: 'error', message: '模型连接中断' }))
    expect(screen.getByRole('alert').textContent).toContain('模型连接中断')
    expect(mocks.voiceStreamStop).toHaveBeenCalled()
    expect(useActivityStore.getState().tasks['voice-work']).toBeUndefined()
    expect(screen.queryByRole('button', { name: '停止实时模式' })).toBeNull()
  })

  it('stops output and shows an error if the chosen device was not applied', async () => {
    mocks.relayActive = false
    const stop = vi.fn()
    mocks.devicePlay.mockResolvedValueOnce({ stop, sinkApplied: false, sampleRate: 48000 })
    render(<VoiceChangerPage />)
    fireEvent.change(screen.getByLabelText('合成文本'), { target: { value: '路由测试' } })
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }))
    await act(async () => { mocks.resolveTts({ audio: new Blob(['fixture']), text: '路由测试', timing: { tts_sec: 0.1, total_sec: 0.1 } }); await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '发送到所选输出设备' }))
    await screen.findByRole('alert')
    expect(stop).toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('无法使用所选输出设备')
  })
})
