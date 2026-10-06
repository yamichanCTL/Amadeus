import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import type { HotwordConfig, ModelInfo } from '@/services/api'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'

const apiMocks = vi.hoisted(() => ({ models: vi.fn(), hotwords: vi.fn(), loadModel: vi.fn(), unloadModel: vi.fn() }))
vi.mock('@/services/api', async importOriginal => ({ ...await importOriginal<typeof import('@/services/api')>(), ASRApi: class {
  models = apiMocks.models; hotwords = apiMocks.hotwords; loadModel = apiMocks.loadModel; unloadModel = apiMocks.unloadModel
} }))
vi.mock('@/components/ModelDownloads', () => ({ ModelDownloads: () => <div>下载进度区域</div> }))
import { ModelsPage } from './Models'

const localUrl = 'http://127.0.0.1:8768'
const state = (phase: LocalRuntimeState['phase'], extra: Partial<LocalRuntimeState> = {}): LocalRuntimeState => ({ phase, installed: true, owned: phase === 'running' || phase === 'stopping',
  url: phase === 'running' || phase === 'stopping' ? localUrl : null, message: '正在安装组件', root: 'F:/fixture', logPath: '', autoStart: false, ...extra })
const model = (engine: string, loaded = false): ModelInfo => ({ engine, model_name: engine, is_loaded: loaded, device: loaded ? 'cuda:0' : null, compute_type: loaded ? 'bfloat16' : null,
  languages: ['zh'], extra: { model_modes: [engine === 'x-asr' ? 'streaming' : 'offline'] } })
const catalogue = [model('sensevoice'), model('formalasr'), model('x-asr')]
const hotwords: HotwordConfig = { enabled: true, rule_enabled: false, hotwords: '测试人名', rules: '', threshold: .8, similar_threshold: .6, hotword_count: 1, rule_count: 0 }
let emit!: (value: LocalRuntimeState) => void

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function host(initial: Promise<LocalRuntimeState> = Promise.resolve(state('running'))) {
  const off = vi.fn()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localRuntimeStatus: vi.fn(() => initial), onLocalRuntimeState: vi.fn(callback => { emit = callback; return off }),
  } })
  return off
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('amadeus.localRuntime.lastUrl', localUrl)
  useASRStore.setState({ models: structuredClone(catalogue), serverStatus: 'connected', settings: structuredClone({ ...DEFAULT_SETTINGS,
    serverUrl: localUrl, backendConfirmed: true, offlineEngine: 'formalasr', streamingEngine: 'x-asr' }) })
  apiMocks.models.mockReset().mockResolvedValue(catalogue)
  apiMocks.hotwords.mockReset().mockResolvedValue(hotwords)
  host()
})
afterEach(() => { cleanup(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined }) })

describe('model settings during intentional local environment transitions', () => {
  it('aborts pending model and hotword reads, ignores their late failures, preserves choices and refreshes after restart', async () => {
    const pendingModels = deferred<ModelInfo[]>()
    const pendingHotwords = deferred<HotwordConfig>()
    apiMocks.models.mockReturnValueOnce(pendingModels.promise)
    apiMocks.hotwords.mockReturnValueOnce(pendingHotwords.promise)
    render(<ModelsPage asrSection="models" />)
    await waitFor(() => expect(apiMocks.models).toHaveBeenCalledOnce())
    const modelSignal = apiMocks.models.mock.calls[0][0].signal as AbortSignal
    const hotwordSignal = apiMocks.hotwords.mock.calls[0][0] as AbortSignal
    act(() => { emit(state('stopping')); emit(state('installing')); useASRStore.getState().setServerStatus('disconnected') })
    expect(modelSignal.aborted).toBe(true)
    expect(hotwordSignal.aborted).toBe(true)
    expect(useASRStore.getState().models).toEqual(catalogue)
    expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr')
    expect(useASRStore.getState().settings.streamingEngine).toBe('x-asr')
    expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { pendingModels.reject(new TypeError('Failed to fetch models')); pendingHotwords.reject(new TypeError('Failed to fetch hotwords')) })
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
    expect(apiMocks.models).toHaveBeenCalledOnce()
    expect(apiMocks.hotwords).toHaveBeenCalledOnce()
    apiMocks.models.mockResolvedValue(catalogue.map(item => ({ ...item, is_loaded: item.engine === 'formalasr' })))
    act(() => emit(state('running')))
    await waitFor(() => expect(apiMocks.models).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useASRStore.getState().models.find(item => item.engine === 'formalasr')?.is_loaded).toBe(true))
    expect(apiMocks.hotwords).toHaveBeenCalledTimes(2)
    expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr')
    expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears a just-reported local fetch error when component installation begins', async () => {
    apiMocks.models.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<ModelsPage asrSection="models" />)
    expect(await screen.findByText(/Failed to fetch/)).toBeTruthy()
    act(() => emit(state('stopping')))
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('服务恢复后会自动刷新')
    expect(useASRStore.getState().models).toEqual(catalogue)
  })

  it('pauses after navigating into an already installing local runtime with url cleared', async () => {
    host(Promise.resolve(state('installing')))
    render(<ModelsPage asrSection="models" />)
    await screen.findByRole('status')
    const requests = apiMocks.models.mock.calls.length
    const hotwordRequests = apiMocks.hotwords.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    act(() => useASRStore.getState().setServerStatus('disconnected'))
    expect(apiMocks.models).toHaveBeenCalledTimes(requests)
    expect(apiMocks.hotwords).toHaveBeenCalledTimes(hotwordRequests)
    expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr')
  })

  it('never suppresses errors or disables refresh for a different remote backend', async () => {
    useASRStore.getState().updateSettings({ serverUrl: 'https://remote.example.test', backendConfirmed: true })
    host(Promise.resolve(state('installing')))
    apiMocks.models.mockRejectedValue(new Error('remote backend unavailable'))
    render(<ModelsPage asrSection="models" />)
    expect(await screen.findByText('remote backend unavailable')).toBeTruthy()
    expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false)
    act(() => emit(state('starting')))
    expect(screen.getByText('remote backend unavailable')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ignores a delayed initial running status after a newer installing event', async () => {
    const initial = deferred<LocalRuntimeState>()
    host(initial.promise)
    render(<ModelsPage asrSection="models" />)
    act(() => emit(state('installing')))
    await act(async () => initial.resolve(state('running')))
    expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => emit(state('running')))
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('does not apply an old hotword response over the restarted service response', async () => {
    const oldHotwords = deferred<HotwordConfig>()
    apiMocks.hotwords.mockReturnValueOnce(oldHotwords.promise)
    render(<ModelsPage asrSection="hotwords" />)
    act(() => { emit(state('stopping')); emit(state('installing')) })
    apiMocks.hotwords.mockResolvedValue({ ...hotwords, hotwords: '新服务的热词' })
    act(() => emit(state('running')))
    await waitFor(() => expect((screen.getByRole('textbox', { name: /热词词典/ }) as HTMLTextAreaElement).value).toBe('新服务的热词'))
    await act(async () => oldHotwords.resolve({ ...hotwords, hotwords: '旧服务热词' }))
    expect((screen.getByRole('textbox', { name: /热词词典/ }) as HTMLTextAreaElement).value).toBe('新服务的热词')
  })
})
