import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const requests = vi.hoisted(() => ({ transcribe: vi.fn(), task: vi.fn(), cancelTask: vi.fn() }))
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, ASRApi: class { transcribe = requests.transcribe; task = requests.task; cancelTask = requests.cancelTask } }
})
vi.mock('./audio', () => ({ speechRecorder: { prepare: vi.fn(async () => undefined), cancel: vi.fn() }, blobToBase64: vi.fn(async () => '') }))
vi.mock('./liveCaption', () => ({ liveCaptionService: { stop: vi.fn(async () => undefined) } }))
vi.mock('./telemetry', () => ({ startTelemetryTrace: vi.fn(() => ({ startedAt: performance.now() })), recordTelemetryStage: vi.fn(), finishTelemetryTrace: vi.fn() }))

import { RecordingService } from './recordingService'

const audio = () => new Blob([new Uint8Array(1024)], { type: 'audio/wav' })
const completed = { task_id: 'test-task', status: 'success', full_text: '今天下午去买东西。', segments: [], engine_used: 'formalasr', language: 'zh', confidence: null, duration_sec: 1, elapsed_sec: 0.2 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useASRStore.setState({ settings: structuredClone({ ...DEFAULT_SETTINGS, serverUrl: 'http://asr.test', backendConfirmed: true }),
    fileBatchRunning: false, recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', activeTaskId: null, currentResult: null, history: [], error: '' })
  requests.transcribe.mockResolvedValue({ task_id: 'test-task', status: 'pending', message: 'queued' })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { hideStatusOverlay: vi.fn(async () => undefined), textToClipboard: vi.fn(),
    archiveTranscription: vi.fn(async () => ({})), getDefaultArchiveDir: vi.fn(async () => '') } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-result')
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('asynchronous ASR task outcomes', () => {
  it('reports a backend task failure and preserves the previous result without archiving or copying failure output', async () => {
    useASRStore.setState({ currentResult: { ...completed, task_id: 'previous' } })
    requests.task.mockResolvedValue({ ...completed, status: 'failed', full_text: '', error_message: 'FormalASR 初始化失败：缺少 qwen_asr' })
    const service = new RecordingService()
    const work = service.runTranscription(audio(), 'failed.wav', false)
    await vi.advanceTimersByTimeAsync(200)
    await work
    expect(useASRStore.getState().transcribeStatus).toBe('error')
    expect(useASRStore.getState().error).toBe('FormalASR 初始化失败：缺少 qwen_asr')
    expect(useASRStore.getState().currentResult?.task_id).toBe('previous')
    expect(useASRStore.getState().history).toHaveLength(0)
    expect(window.electronAPI!.archiveTranscription).not.toHaveBeenCalled()
    expect(window.electronAPI!.textToClipboard).not.toHaveBeenCalled()
    expect(service.isBusy).toBe(false)
    expect(useASRStore.getState().activeTaskId).toBeNull()
  })

  it('shows cancellation returned by the server rather than treating it as successful empty transcription', async () => {
    requests.task.mockResolvedValue({ ...completed, status: 'cancelled', full_text: '' })
    const service = new RecordingService()
    const work = service.runTranscription(audio(), 'cancelled.wav', false)
    await vi.advanceTimersByTimeAsync(200)
    await work
    expect(useASRStore.getState().transcribeStatus).toBe('cancelled')
    expect(useASRStore.getState().history).toHaveLength(0)
    expect(useASRStore.getState().currentResult).toBeNull()
    expect(service.isBusy).toBe(false)
  })

  it('halts a file queue after its first failed asynchronous task', async () => {
    requests.task.mockResolvedValue({ ...completed, status: 'failed', error_message: '音频解码失败' })
    const service = new RecordingService()
    const work = service.runFileBatch([{ name: 'first.wav', blob: audio() }, { name: 'second.wav', blob: audio() }])
    await vi.advanceTimersByTimeAsync(200)
    await work
    expect(requests.transcribe).toHaveBeenCalledTimes(1)
    expect(useASRStore.getState().transcribeStatus).toBe('error')
    expect(useASRStore.getState().fileBatchRunning).toBe(false)
  })

  it('still delivers a successful asynchronous result after an intermediate running state', async () => {
    requests.task.mockResolvedValueOnce({ ...completed, status: 'running', full_text: '' }).mockResolvedValueOnce(completed)
    const service = new RecordingService()
    const work = service.runTranscription(audio(), 'success.wav', false)
    await vi.advanceTimersByTimeAsync(400)
    await work
    expect(useASRStore.getState().transcribeStatus).toBe('done')
    expect(useASRStore.getState().currentResult?.full_text).toBe(completed.full_text)
    expect(useASRStore.getState().history).toHaveLength(1)
    expect(useASRStore.getState().currentResult?.client_timing?.request_to_result_sec).toBeCloseTo(0.4, 2)
    expect(useASRStore.getState().history[0].client_timing).toEqual(useASRStore.getState().currentResult?.client_timing)
    expect(window.electronAPI!.textToClipboard).toHaveBeenCalledWith(completed.full_text)
  })
})
