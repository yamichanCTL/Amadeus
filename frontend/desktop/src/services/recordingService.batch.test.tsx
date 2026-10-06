// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), stop: vi.fn(async () => undefined), start: vi.fn(), cancelTask: vi.fn(async () => undefined) }))
vi.mock('./api', () => ({ ASRApi: class { transcribe = mocks.transcribe; cancelTask = mocks.cancelTask }, isAsyncResponse: () => false }))
vi.mock('./audio', () => ({ speechRecorder: { prepare: vi.fn(async () => undefined), cancel: vi.fn(), start: mocks.start }, captureSpeakerAudio: vi.fn(), blobToBase64: vi.fn(async () => '') }))
vi.mock('./liveCaption', () => ({ liveCaptionService: { stop: mocks.stop } }))
vi.mock('./telemetry', () => ({ startTelemetryTrace: vi.fn(() => ({ startedAt: performance.now() })), recordTelemetryStage: vi.fn(), finishTelemetryTrace: vi.fn() }))

import { RecordingService } from './recordingService'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const file = (name: string) => ({ name, blob: new Blob([new Uint8Array(1024)], { type: 'audio/wav' }) })
const result = (filename: string) => ({ task_id: filename, status: 'success', full_text: filename, segments: [], engine_used: 'sensevoice', language: 'zh', confidence: 1, duration_sec: 1, elapsed_sec: 0.001 })
function BatchStatus() { const running = useASRStore((state) => state.fileBatchRunning); return <p>{running ? '批次运行中' : '批次空闲'}</p> }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transcribe.mockImplementation(async (_blob: Blob, filename: string) => result(filename))
  useASRStore.setState({ settings: structuredClone({ ...DEFAULT_SETTINGS, serverUrl: 'http://batch.test', backendConfirmed: true }),
    fileBatchRunning: false, recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', activeTaskId: null, currentResult: null, history: [], error: '' })
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:batch-test') })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { hideStatusOverlay: vi.fn(async () => undefined), hideCaptionOverlay: vi.fn(async () => undefined),
    textToClipboard: vi.fn(), archiveTranscription: vi.fn(async () => ({})), getDefaultArchiveDir: vi.fn(async () => '') } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('file batch singleton ownership', () => {
  it('retains batch status across page unmount and blocks recording or another batch until all files finish', async () => {
    const delivery = deferred<boolean>()
    window.electronAPI!.hideStatusOverlay = vi.fn(() => delivery.promise)
    const service = new RecordingService()
    const firstPage = render(<BatchStatus />)
    const batch = service.runFileBatch([file('first.wav'), file('second.wav')])
    await screen.findByText('批次运行中')
    await vi.waitFor(() => expect(useASRStore.getState().transcribeStatus).toBe('done'))
    firstPage.unmount()
    render(<BatchStatus />)
    expect(screen.getByText('批次运行中')).toBeTruthy()
    expect(service.isBusy).toBe(true)
    await service.toggle()
    await service.runFileBatch([file('intruder.wav')])
    await service.runTranscription(file('other.wav').blob, 'other.wav', false)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.transcribe.mock.calls.map((call) => call[1])).toEqual(['first.wav'])
    await act(async () => { delivery.resolve(true); await batch })
    expect(mocks.transcribe.mock.calls.map((call) => call[1])).toEqual(['first.wav', 'second.wav'])
    expect(screen.getByText('批次空闲')).toBeTruthy()
    expect(service.isBusy).toBe(false)
  })

  it('stops during result delivery and prevents the stopped queue from starting its next file or releasing a new queue', async () => {
    const oldDelivery = deferred<boolean>()
    const newDelivery = deferred<boolean>()
    const hide = vi.fn().mockImplementationOnce(() => oldDelivery.promise).mockResolvedValueOnce(undefined).mockImplementationOnce(() => newDelivery.promise)
    window.electronAPI!.hideStatusOverlay = hide
    const service = new RecordingService()
    const stoppedBatch = service.runFileBatch([file('old-first.wav'), file('old-next.wav')])
    await vi.waitFor(() => expect(useASRStore.getState().currentResult?.task_id).toBe('old-first.wav'))
    await service.forceStop()
    expect(useASRStore.getState().fileBatchRunning).toBe(false)
    const newBatch = service.runFileBatch([file('new-first.wav')])
    await vi.waitFor(() => expect(useASRStore.getState().currentResult?.task_id).toBe('new-first.wav'))
    oldDelivery.resolve(true)
    await stoppedBatch
    expect(mocks.transcribe.mock.calls.map((call) => call[1])).toEqual(['old-first.wav', 'new-first.wav'])
    expect(useASRStore.getState().currentResult?.task_id).toBe('new-first.wav')
    expect(useASRStore.getState().fileBatchRunning).toBe(true)
    expect(service.isBusy).toBe(true)
    newDelivery.resolve(true)
    await newBatch
    expect(useASRStore.getState().fileBatchRunning).toBe(false)
  })

  it('ignores an aborted old request that returns after a new task has already published its result', async () => {
    const late = deferred<ReturnType<typeof result>>()
    mocks.transcribe.mockImplementationOnce(() => late.promise)
    const service = new RecordingService()
    const oldBatch = service.runFileBatch([file('late-old.wav'), file('never.wav')])
    await service.forceStop()
    await service.runFileBatch([file('new-result.wav')])
    late.resolve(result('late-old.wav'))
    await oldBatch
    expect(useASRStore.getState().currentResult?.task_id).toBe('new-result.wav')
    expect(useASRStore.getState().transcribeStatus).toBe('done')
    expect(useASRStore.getState().history.map((item) => item.filename)).toEqual(['new-result.wav'])
  })
})
