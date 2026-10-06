// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const audio = vi.hoisted(() => ({
  clients: [] as Array<{ event: (event: any) => void; stop: ReturnType<typeof vi.fn> }>,
  start: vi.fn(async () => {}), capture: vi.fn(),
}))
vi.mock('./audio', () => ({
  StreamingASRClient: class {
    stop = vi.fn()
    start = audio.start
    constructor(_url: string, public event: (event: any) => void) { audio.clients.push(this) }
  },
  speechRecorder: { takePreparedStream: vi.fn(() => undefined) },
  audioRelayMixer: { isActive: vi.fn(() => false), createInputStream: vi.fn() },
  captureSpeakerAudio: audio.capture,
  blobToBase64: vi.fn(async () => ''),
}))

import { LiveCaptionService } from './liveCaption'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function host() {
  const api = { showCaptionOverlay: vi.fn(async () => true), hideCaptionOverlay: vi.fn(async () => true), notifyLiveCaptionState: vi.fn(), archiveTranscription: vi.fn(async () => null) }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  return api
}
beforeEach(() => {
  audio.clients.length = 0
  audio.start.mockReset().mockResolvedValue(undefined)
  audio.capture.mockReset()
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: 'http://fixture.test', backendConfirmed: true, showDesktopCaptions: true, liveCaptionEnabled: false }, history: [], currentResult: null, liveUtterances: [], recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', fileBatchRunning: false, error: '' })
})

describe('live caption cancellation during startup', () => {
  it('treats pending overlay startup as active and prevents a stopped startup from connecting', async () => {
    const api = host()
    const overlay = deferred<boolean>()
    api.showCaptionOverlay.mockReturnValueOnce(overlay.promise)
    const service = new LiveCaptionService()
    const start = service.start()
    expect(service.isActive).toBe(true)
    await service.start()
    expect(api.showCaptionOverlay).toHaveBeenCalledTimes(1)
    await service.stop()
    overlay.resolve(true)
    await start
    expect(audio.clients).toHaveLength(0)
    expect(service.isActive).toBe(false)
    expect(useASRStore.getState().liveCaptionStatus).toBe('idle')
    expect(useASRStore.getState().settings.liveCaptionEnabled).toBe(false)
    expect(api.notifyLiveCaptionState).not.toHaveBeenCalledWith(true)
  })

  it('releases speaker tracks returned after stop instead of starting a client', async () => {
    host()
    useASRStore.getState().updateSettings({ inputSource: 'speaker' })
    const capture = deferred<MediaStream>()
    const stopTrack = vi.fn()
    audio.capture.mockReturnValueOnce(capture.promise)
    const service = new LiveCaptionService()
    const start = service.start()
    await vi.waitFor(() => expect(audio.capture).toHaveBeenCalledTimes(1))
    await service.stop()
    capture.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
    await start
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(audio.start).not.toHaveBeenCalled()
    expect(service.isActive).toBe(false)
    expect(useASRStore.getState().liveCaptionStatus).toBe('idle')
  })

  it.each(['resolve', 'reject'] as const)('ignores an old startup %s and archives its late close without changing the new session', async outcome => {
    const api = host()
    const pending = deferred<void>()
    audio.start.mockReturnValueOnce(pending.promise)
    const service = new LiveCaptionService()
    const oldStart = service.start()
    await vi.waitFor(() => expect(audio.clients).toHaveLength(1))
    const old = audio.clients[0]
    old.event({ type: 'final', text: '旧会话文本' })
    await service.stop()
    await service.start()
    const current = audio.clients[1]
    current.event({ type: 'configured' })
    current.event({ type: 'final', text: '新会话文本' })
    const currentId = useASRStore.getState().currentResult?.task_id
    if (outcome === 'resolve') pending.resolve(undefined)
    else pending.reject(new Error('old startup failed'))
    await oldStart
    old.event({ type: 'error', message: '旧错误' })
    old.event({ type: 'closed', recording: null })
    expect(service.isActive).toBe(true)
    expect(current.stop).not.toHaveBeenCalled()
    expect(useASRStore.getState().liveCaptionStatus).toBe('listening')
    expect(useASRStore.getState().settings.liveCaptionEnabled).toBe(true)
    expect(useASRStore.getState().currentResult?.task_id).toBe(currentId)
    expect(useASRStore.getState().currentResult?.full_text).toContain('新会话文本')
    expect(useASRStore.getState().history[0]?.full_text).toContain('旧会话文本')
    expect(useASRStore.getState().history[0]?.full_text).not.toContain('新会话文本')
    expect(useASRStore.getState().error).not.toBe('旧错误')
    expect(api.notifyLiveCaptionState).toHaveBeenLastCalledWith(true)
    await service.stop()
  })
})
