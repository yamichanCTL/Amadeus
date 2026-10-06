import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const io = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), capture: vi.fn(), transcribe: vi.fn() }))
vi.mock('./audio', () => ({ speechRecorder: { prepare: vi.fn(async () => undefined), start: io.start, stop: io.stop, cancel: io.cancel, takePreparedStream: vi.fn() }, captureSpeakerAudio: io.capture, blobToBase64: vi.fn() }))
vi.mock('./liveCaption', () => ({ liveCaptionService: { stop: vi.fn(async () => undefined) } }))
vi.mock('./api', () => ({ ASRApi: class { transcribe = io.transcribe }, isAsyncResponse: () => false }))
import { RecordingService } from './recordingService'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  io.start.mockResolvedValue(undefined)
  useASRStore.setState({ settings: structuredClone({ ...DEFAULT_SETTINGS, serverUrl: 'http://asr.test', backendConfirmed: true }), recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', fileBatchRunning: false, asrModelLoading: false, activeTaskId: null, error: '' })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { captureTextTarget: vi.fn(async () => true), showStatusOverlay: vi.fn(async () => true), hideStatusOverlay: vi.fn(async () => true), hideCaptionOverlay: vi.fn(async () => true) } })
})

describe('offline recording startup and stop ownership', () => {
  it('blocks hotkey capture and file submission while the model is loading', async () => {
    useASRStore.setState({ asrModelLoading: true })
    const service = new RecordingService()
    expect(service.isBusy).toBe(true)
    await service.toggle(true)
    await service.runTranscription(new Blob(['audio']), 'test.wav', false)
    await service.runFileBatch([{ blob: new Blob(['audio']), name: 'test.wav' }])
    expect(io.start).not.toHaveBeenCalled()
    expect(io.transcribe).not.toHaveBeenCalled()
    expect(useASRStore.getState().recordStatus).toBe('idle')
    expect(useASRStore.getState().error).toBe('识别模型正在加载，请稍候。')
    useASRStore.setState({ asrModelLoading: false })
    expect(service.isBusy).toBe(false)
  })

  it('opens the microphone without waiting for the overlay, and cancels late startup safely', async () => {
    const overlay = deferred<boolean>()
    const microphone = deferred<void>()
    io.start.mockReturnValueOnce(microphone.promise)
    window.electronAPI!.showStatusOverlay = vi.fn(() => overlay.promise)
    const service = new RecordingService()
    const opening = service.toggle()
    expect(service.isBusy).toBe(true)
    expect(io.start).toHaveBeenCalledOnce()
    await service.forceStop()
    overlay.resolve(true)
    microphone.resolve()
    await opening
    expect(io.cancel).toHaveBeenCalled()
    expect(window.electronAPI!.hideStatusOverlay).toHaveBeenCalled()
    expect(useASRStore.getState().recordStatus).toBe('idle')
    expect(service.isBusy).toBe(false)
  })

  it('releases speaker tracks that arrive after cancellation', async () => {
    useASRStore.getState().updateSettings({ inputSource: 'speaker' })
    const capture = deferred<MediaStream>()
    const track = { stop: vi.fn() }
    io.capture.mockReturnValueOnce(capture.promise)
    const service = new RecordingService()
    const opening = service.toggle()
    await vi.waitFor(() => expect(io.capture).toHaveBeenCalled())
    await service.forceStop()
    capture.resolve({ getTracks: () => [track] } as unknown as MediaStream)
    await opening
    expect(track.stop).toHaveBeenCalledOnce()
    expect(io.start).not.toHaveBeenCalled()
    expect(useASRStore.getState().recordStatus).toBe('idle')
  })

  it('ignores an old microphone failure after a new recording has started', async () => {
    const pending = deferred<void>()
    io.start.mockReturnValueOnce(pending.promise)
    const service = new RecordingService()
    const oldOpening = service.toggle()
    await vi.waitFor(() => expect(io.start).toHaveBeenCalledOnce())
    await service.forceStop()
    await service.toggle()
    expect(io.start).toHaveBeenCalledTimes(2)
    const cancellations = io.cancel.mock.calls.length
    pending.reject(new Error('old microphone failed'))
    await oldOpening
    expect(useASRStore.getState().recordStatus).toBe('recording')
    expect(useASRStore.getState().error).not.toContain('old microphone')
    expect(io.cancel).toHaveBeenCalledTimes(cancellations)
  })

  it('does not submit a recording whose stop completion arrived after force stop', async () => {
    const stopped = deferred<{ blob: Blob }>()
    io.stop.mockReturnValueOnce(stopped.promise)
    const service = new RecordingService()
    await service.toggle()
    const stopping = service.toggle()
    await vi.waitFor(() => expect(io.stop).toHaveBeenCalledOnce())
    await service.toggle()
    expect(io.start).toHaveBeenCalledOnce()
    await service.forceStop()
    stopped.resolve({ blob: new Blob([new Uint8Array(1024)]) })
    await stopping
    expect(io.transcribe).not.toHaveBeenCalled()
    expect(useASRStore.getState().recordStatus).toBe('idle')
  })
})
