// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(async () => undefined),
  takePreparedStream: vi.fn(() => undefined),
  relayCreateInputStream: vi.fn(() => new MediaStream()),
  captureSpeakerAudio: vi.fn(async () => new MediaStream()),
}))

const store = vi.hoisted(() => {
  const state = {
    recordStatus: 'idle',
    transcribeStatus: 'idle',
    liveCaptionStatus: 'idle',
    settings: {
      inputSource: 'file',
      audioInputDeviceId: 'physical-microphone-id',
      offlineEngine: 'sensevoice',
    },
    setRecordStatus: vi.fn((value: string) => { state.recordStatus = value }),
    setError: vi.fn(),
  }
  return { state }
})

vi.mock('@/store/useASRStore', () => ({
  useASRStore: { getState: () => store.state },
}))

vi.mock('./audio', () => ({
  speechRecorder: {
    start: mocks.recorderStart,
    takePreparedStream: mocks.takePreparedStream,
    cancel: vi.fn(),
  },
  audioRelayMixer: {
    isActive: () => true,
    createInputStream: mocks.relayCreateInputStream,
  },
  captureSpeakerAudio: mocks.captureSpeakerAudio,
  blobToBase64: vi.fn(async () => ''),
}))

vi.mock('./liveCaption', () => ({
  liveCaptionService: { stop: vi.fn(async () => undefined) },
}))

vi.mock('./telemetry', () => ({
  startTelemetryTrace: vi.fn(),
  recordTelemetryStage: vi.fn(),
  finishTelemetryTrace: vi.fn(),
}))

vi.mock('./api', () => ({
  ASRApi: class {},
  isAsyncResponse: vi.fn(() => false),
}))

import { RecordingService } from './recordingService'

describe('offline ASR microphone isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.state.recordStatus = 'idle'
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        captureTextTarget: vi.fn(async () => true),
        showStatusOverlay: vi.fn(async () => true),
        hideStatusOverlay: vi.fn(async () => true),
      },
    })
  })

  it('opens the selected microphone directly even if a relay mixer is active', async () => {
    const service = new RecordingService()
    await service.toggle(true)

    expect(mocks.recorderStart).toHaveBeenCalledWith(
      'physical-microphone-id',
      undefined,
      expect.any(Function),
    )
    expect(mocks.relayCreateInputStream).not.toHaveBeenCalled()
    expect(mocks.captureSpeakerAudio).not.toHaveBeenCalled()
  })
})
