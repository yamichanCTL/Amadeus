// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@/services/api'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { resolveTaskLLM } from '@/services/taskModels'

const mocks = vi.hoisted(() => ({ models: vi.fn(), load: vi.fn(), catalog: vi.fn(), llmModels: vi.fn() }))
vi.mock('@/services/api', async (original) => ({ ...await original<typeof import('@/services/api')>(), ASRApi: class {
  models = mocks.models; loadModel = mocks.load; modelDownloadCatalog = mocks.catalog; listLLMModels = mocks.llmModels
} }))
import { RecognitionModelQuickSettings } from './RecognitionModelQuickSettings'
import { RecordButton } from './RecordButton'

const model = (engine: string, streaming = false, loaded = false): ModelInfo => ({
  engine, model_name: engine, is_loaded: loaded, device: loaded ? 'cuda:0' : null,
  compute_type: loaded ? 'bfloat16' : null, languages: ['zh'], extra: { model_modes: [streaming ? 'streaming' : 'offline'] },
})
const engines = () => [model('sensevoice'), model('formalasr'), model('x-asr', true)]
const configure = vi.fn()
function mount(busy = false, mode: 'offline' | 'streaming' = 'offline') {
  return render(<RecognitionModelQuickSettings busy={busy} mode={mode} onConfigure={configure} />)
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
  const panel = screen.getByRole('dialog', { name: '识别模型快捷设置' })
  await waitFor(() => expect((within(panel).getByRole('combobox', { name: '快捷离线模型' }) as HTMLSelectElement).disabled).toBe(false))
  return panel
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  localStorage.removeItem('amadeus.localRuntime.lastUrl')
  mocks.models.mockResolvedValue(engines())
  mocks.catalog.mockResolvedValue({ models: [], jobs: [] })
  mocks.load.mockResolvedValue({ ok: true })
  mocks.llmModels.mockResolvedValue({ connected: true, models: ['text-new'] })
  useASRStore.setState({ models: [], asrModelLoading: false, recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', fileBatchRunning: false,
    settings: { ...structuredClone(DEFAULT_SETTINGS), backendConfirmed: true, serverUrl: 'http://backend.test', offlineEngine: 'sensevoice', streamingEngine: 'x-asr' },
  })
  useASRStore.getState().updateSettings({})
})
afterEach(() => { cleanup(); useASRStore.setState({ asrModelLoading: false }) })

describe('recognition model shortcuts', () => {
  it('separates offline, streaming and optional text models without exposing credentials', async () => {
    mount()
    const panel = await open()
    const offline = within(panel).getByRole('combobox', { name: '快捷离线模型' })
    const streaming = within(panel).getByRole('combobox', { name: '快捷流式模型' })
    expect(within(offline).getAllByRole('option').map(item => item.getAttribute('value'))).toEqual(['sensevoice', 'formalasr'])
    expect(within(streaming).getAllByRole('option').map(item => item.getAttribute('value'))).toEqual(['x-asr'])
    expect(within(panel).getByText('自动整理未启用')).toBeTruthy()
    expect(within(panel).queryByLabelText(/API Key/)).toBeNull()
    fireEvent.change(offline, { target: { value: 'formalasr' } })
    expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr')
    expect(useASRStore.getState().settings.streamingEngine).toBe('x-asr')
    expect(mocks.load).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '模型快捷设置' }).textContent).toContain('待加载')
  })

  it('loads the chosen engine with saved CUDA, precision, path and extra parameters then reports actual runtime', async () => {
    useASRStore.getState().updateSettings({ offlineEngine: 'formalasr', asrModelConfigs: {
      ...useASRStore.getState().settings.asrModelConfigs,
      formalasr: { modelName: 'F:/fixture/formal', device: 'cuda:0', computeType: 'bfloat16', extraJson: '{"batch_size":2}' },
    } })
    mount()
    const panel = await open()
    mocks.models.mockResolvedValue([model('sensevoice'), model('formalasr', false, true), model('x-asr', true)])
    const row = within(panel).getByText('录音与文件转写').closest('.recognition-model-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith('formalasr', { model_name: 'F:/fixture/formal', device: 'cuda:0', compute_type: 'bfloat16', extra: { batch_size: 2 } }))
    await within(row).findByText('已加载 · cuda:0')
    await waitFor(() => expect(useASRStore.getState().asrModelLoading).toBe(false))
    expect(screen.getByRole('button', { name: '模型快捷设置' }).textContent).toContain('已加载')
  })

  it('keeps a process lock after closing and unmounting the popup while loading', async () => {
    const pending = deferred<{ ok: boolean }>()
    mocks.load.mockReturnValue(pending.promise)
    const view = mount()
    const panel = await open()
    const row = within(panel).getByText('录音与文件转写').closest('.recognition-model-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    expect(useASRStore.getState().asrModelLoading).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: '关闭模型快捷设置' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useASRStore.getState().asrModelLoading).toBe(true)
    view.unmount()
    render(<RecordButton onToggle={vi.fn()} />)
    expect((screen.getByRole('button', { name: /开始录音/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true }) })
    expect(useASRStore.getState().asrModelLoading).toBe(false)
    expect((screen.getByRole('button', { name: /开始录音/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables model changes during a task without hiding the current choices', async () => {
    mount(true)
    fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
    const offline = screen.getByRole('combobox', { name: '快捷离线模型' }) as HTMLSelectElement
    await waitFor(() => expect(within(offline).getAllByRole('option')).toHaveLength(2))
    expect(offline.disabled).toBe(true)
    expect(screen.getByText('当前任务正在运行，结束后可切换或加载模型。')).toBeTruthy()
    fireEvent.change(offline, { target: { value: 'formalasr' } })
    expect(useASRStore.getState().settings.offlineEngine).toBe('sensevoice')
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('shows missing components and load errors, with a direct route to installation', async () => {
    mocks.catalog.mockResolvedValue({ jobs: [], models: [{ engine: 'sensevoice', runtime: { installed: false } }] })
    mocks.load.mockRejectedValue(new Error('sensevoice 缺少运行组件，请先安装。'))
    mount()
    const panel = await open()
    await within(panel).findByText('缺少运行组件，请在模型下载中安装。')
    const row = within(panel).getByText('录音与文件转写').closest('.recognition-model-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    expect(await within(panel).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('sensevoice 缺少运行组件'))
    expect(useASRStore.getState().asrModelLoading).toBe(false)
    fireEvent.click(within(panel).getByRole('button', { name: '检查模型与组件' }))
    expect(configure).toHaveBeenCalledWith('downloads')
  })

  it('rejects an invalid advanced parameter object before sending a load request', async () => {
    const settings = useASRStore.getState().settings
    useASRStore.getState().updateSettings({ asrModelConfigs: { ...settings.asrModelConfigs, sensevoice: { ...settings.asrModelConfigs.sensevoice, extraJson: '[]' } } })
    mount()
    const panel = await open()
    const row = within(panel).getByText('录音与文件转写').closest('.recognition-model-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    expect(await within(panel).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('JSON 必须是对象'))
    expect(mocks.load).not.toHaveBeenCalled()
    expect(useASRStore.getState().asrModelLoading).toBe(false)
  })

  it('switches only ASR postprocessing and reuses saved connections without changing other tasks', async () => {
    useASRStore.getState().updateSettings({ modelConnections: [
      { id: 'a', name: '连接 A', provider: 'deepseek', baseUrl: 'https://a.test', apiToken: 'fixture-a' },
      { id: 'b', name: '连接 B', provider: 'qwen', baseUrl: 'https://b.test', apiToken: 'fixture-b' },
    ], taskModels: { asr_postprocess: { connectionId: 'a', model: 'asr-old' }, agent: { connectionId: 'a', model: 'brain-unchanged' }, summary: { connectionId: 'b', model: 'summary-unchanged' } } })
    const connections = structuredClone(useASRStore.getState().settings.modelConnections)
    mount()
    const panel = await open()
    fireEvent.change(within(panel).getByRole('combobox', { name: '快捷文本服务连接' }), { target: { value: 'b' } })
    fireEvent.change(within(panel).getByRole('combobox', { name: '快捷文本模型' }), { target: { value: 'manual' } })
    expect((within(panel).getByRole('textbox', { name: '快捷文本模型（手动填写）' }) as HTMLInputElement).value).toBe('')
    fireEvent.change(within(panel).getByRole('textbox', { name: '快捷文本模型（手动填写）' }), { target: { value: 'new-asr-model' } })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess')).toMatchObject({ model: 'new-asr-model', apiToken: 'fixture-b' })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'agent').model).toBe('brain-unchanged')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'summary').model).toBe('summary-unchanged')
    expect(useASRStore.getState().settings.modelConnections).toEqual(connections)
    fireEvent.click(within(panel).getByRole('button', { name: '获取可选模型' }))
    await waitFor(() => expect(mocks.llmModels).toHaveBeenCalledWith({ provider: 'qwen', base_url: 'https://b.test', api_token: 'fixture-b' }))
    await waitFor(() => expect(within(within(panel).getByRole('combobox', { name: '快捷文本模型' })).getByRole('option', { name: 'text-new' })).toBeTruthy())
    fireEvent.change(within(panel).getByRole('combobox', { name: '快捷文本模型' }), { target: { value: 'model:0' } })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('text-new')
    expect(useASRStore.getState().settings.modelConnections).toEqual(connections)
    expect(useASRStore.getState().settings.llmAutoPolish).toBe(false)
  })

  it('ignores a slow model catalog after the backend URL changes', async () => {
    const old = deferred<ModelInfo[]>()
    mocks.models.mockReturnValueOnce(old.promise)
    mount()
    act(() => { useASRStore.getState().updateSettings({ serverUrl: 'https://new-backend.test', backendConfirmed: true }) })
    await waitFor(() => expect(useASRStore.getState().models).toEqual(engines()))
    await act(async () => { old.resolve([model('old-only', false, true)]) })
    expect(useASRStore.getState().models).toEqual(engines())
    expect(screen.getByRole('button', { name: '模型快捷设置' }).textContent).toContain('待加载')
  })

  it('discards text catalog responses and errors after switching backends', async () => {
    const old = deferred<{ connected: boolean; models: string[] }>()
    const pendingNew = deferred<{ connected: boolean; models: string[] }>()
    useASRStore.getState().updateSettings({ llmProvider: 'deepseek', llmBaseUrl: 'https://llm.test', llmApiToken: 'fixture-key', llmModel: 'keep-model' })
    mocks.llmModels.mockReturnValueOnce(old.promise).mockReturnValueOnce(pendingNew.promise)
    mount()
    const panel = await open()
    fireEvent.click(within(panel).getByRole('button', { name: '获取可选模型' }))
    act(() => useASRStore.getState().updateSettings({ serverUrl: 'https://new-backend.test', backendConfirmed: true }))
    await waitFor(() => expect((within(panel).getByRole('button', { name: '获取可选模型' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(panel).getByRole('button', { name: '获取可选模型' }))
    await act(async () => old.reject(new Error('old response fixture-key')))
    expect(within(panel).queryByRole('alert')).toBeNull()
    expect(within(panel).getByRole('button', { name: '正在获取…' })).toHaveProperty('disabled', true)
    await act(async () => pendingNew.resolve({ connected: true, models: ['new-text'] }))
    const picker = within(panel).getByRole('combobox', { name: '快捷文本模型' })
    expect(within(picker).getByRole('option', { name: 'new-text' })).toBeTruthy()
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('keep-model')
    act(() => useASRStore.getState().updateSettings({ serverUrl: 'https://third-backend.test', backendConfirmed: true }))
    expect(within(picker).queryByRole('option', { name: 'new-text' })).toBeNull()
  })

  it('uses the official DeepSeek OpenAI address and reports safe HTTP reasons without revealing upstream messages', async () => {
    useASRStore.getState().updateSettings({ llmProvider: 'deepseek', llmBaseUrl: 'https://api.deepseek.com/anthropic', llmApiToken: 'private-fixture-key', llmModel: 'keep-model' })
    mocks.llmModels.mockResolvedValueOnce({ connected: false, models: [], status_code: 404, message: 'upstream private-fixture-key' })
    mount()
    const panel = await open()
    fireEvent.click(within(panel).getByRole('button', { name: '获取可选模型' }))
    await waitFor(() => expect(mocks.llmModels).toHaveBeenCalledWith({ provider: 'deepseek', base_url: 'https://api.deepseek.com', api_token: 'private-fixture-key' }))
    expect(await within(panel).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('HTTP 404'))
    expect(panel.textContent).not.toContain('private-fixture-key')
    expect(panel.textContent).not.toContain('upstream')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess')).toMatchObject({ model: 'keep-model', apiToken: 'private-fixture-key' })
  })

  it('pauses requests during installation of the selected local service, then refreshes when restarted', async () => {
    let receive!: (value: LocalRuntimeState) => void
    const state = (phase: LocalRuntimeState['phase']): LocalRuntimeState => ({ phase, url: phase === 'running' ? 'http://backend.test' : null, message: '正在安装组件', owned: true, autoStart: true, installed: true, root: 'F:/fixture', logPath: 'F:/fixture/log' })
    localStorage.setItem('amadeus.localRuntime.lastUrl', 'http://backend.test')
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localRuntimeStatus: vi.fn(async () => state('installing')), onLocalRuntimeState: (handler: typeof receive) => { receive = handler; return vi.fn() } } })
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: '模型快捷设置' }).textContent).toContain('环境安装中'))
    const calls = mocks.models.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.models).toHaveBeenCalledTimes(calls)
    act(() => { receive(state('running')) })
    await waitFor(() => expect((screen.getByRole('combobox', { name: '快捷离线模型' }) as HTMLSelectElement).disabled).toBe(false))
  })

  it('keeps real remote backend failures visible when the local environment is installing', async () => {
    useASRStore.getState().updateSettings({ serverUrl: 'https://remote.test', backendConfirmed: true })
    localStorage.setItem('amadeus.localRuntime.lastUrl', 'http://127.0.0.1:8000')
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localRuntimeStatus: vi.fn(async () => ({ phase: 'installing', url: null, message: '安装组件' })), onLocalRuntimeState: () => vi.fn() } })
    mocks.models.mockRejectedValue(new Error('remote backend failed'))
    mount()
    fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('remote backend failed'))
  })

  it('supports Escape to close and restores focus to the shortcut', async () => {
    mount(false, 'streaming')
    await open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '模型快捷设置' }))
    expect(screen.getByRole('button', { name: '模型快捷设置' }).textContent).toContain('实时字幕模型')
  })
})
