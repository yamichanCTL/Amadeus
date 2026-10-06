// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDownloadCatalog, ModelDownloadJob, DownloadableModel } from '@/services/modelDownloads'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'

const requests = vi.hoisted(() => ({ catalog: vi.fn(), start: vi.fn(), cancel: vi.fn() }))
vi.mock('@/services/api', () => ({
  ASRApi: class {
    constructor(private url: string) {}
    modelDownloadCatalog(signal?: AbortSignal) { return requests.catalog(this.url, signal) }
    startModelDownload(id: string, region: string, source: string) { return requests.start(this.url, id, region, source) }
    cancelModelDownload(id: string) { return requests.cancel(this.url, id) }
  },
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
}))

import { ModelDownloads } from './ModelDownloads'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const backendUrl = 'http://127.0.0.1:8768'
const runtime: LocalRuntimeState = { phase: 'running', installed: true, url: backendUrl, message: '已启动', autoStart: false, root: 'C:/Amadeus', logPath: 'C:/Amadeus/backend.log', owned: true }
const model: DownloadableModel = {
  id: 'whisper-tiny', engine: 'whisper', model_name: 'tiny', label: 'Whisper tiny',
  sources: [{ id: 'huggingface', label: 'Hugging Face（作者官方）' }, { id: 'hf-mirror', label: 'HF-Mirror（第三方镜像）' }],
  weights: { status: 'missing', verified: false, path: 'C:/Amadeus/models/whisper/tiny' },
  runtime: { installed: false, extra: 'whisper', missing_modules: ['faster_whisper'] },
}
const job: ModelDownloadJob = { id: model.id, status: 'downloading', downloaded_bytes: 10, total_bytes: 100, speed_bytes_per_second: 4, current_file: 'model.bin', source: 'hf-mirror' }
let catalog: ModelDownloadCatalog

function host(owned = true) {
  const api = {
    localRuntimeStatus: vi.fn(async () => ({ ...runtime, owned })),
    onLocalRuntimeState: vi.fn((_callback: (state: LocalRuntimeState) => void) => vi.fn()),
    localRuntimeInstallExtra: vi.fn(async () => runtime),
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  return api
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('amadeus.modelDownload.region', 'mainland')
  catalog = { models: [structuredClone(model)], jobs: [] }
  requests.catalog.mockImplementation(async () => structuredClone(catalog))
  requests.start.mockResolvedValue(job)
  requests.cancel.mockResolvedValue({ ...job, status: 'cancelled' })
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: backendUrl, backendConfirmed: true, asrModelConfigs: structuredClone(DEFAULT_SETTINGS.asrModelConfigs) } })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('local model download UI', () => {
  it('shows the real installer items while pausing catalog reads during a local backend restart', async () => {
    vi.useFakeTimers()
    const api = host()
    let listener: ((state: LocalRuntimeState) => void) | undefined
    api.onLocalRuntimeState.mockImplementation(callback => { listener = callback; return vi.fn() })
    localStorage.setItem('amadeus.localRuntime.lastUrl', backendUrl)
    render(<ModelDownloads />)
    await act(async () => undefined)
    requests.catalog.mockClear()
    await act(async () => listener?.({ ...runtime, phase: 'installing', url: null, owned: false, message: '正在下载运行组件', installProgress: {
      stage: 'downloading', startedAt: Date.now(), updatedAt: Date.now(), lastEventAt: Date.now(), observedItems: 1, completedItems: 0,
      items: [{ id: 'torch', name: 'torch', version: '2.11.0+cu128', kind: 'package', status: 'downloading', totalBytes: 2.6 * 1024 ** 3, totalBytesApproximate: true }],
    } }))
    expect(screen.getByRole('region', { name: '下载与安装明细' })).toBeTruthy()
    expect(screen.getByText('2.11.0+cu128')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'torch 下载进度' }).hasAttribute('value')).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(1600))
    expect(requests.catalog).not.toHaveBeenCalled()
    await act(async () => listener?.(runtime))
    expect(requests.catalog).toHaveBeenCalled()
  })

  it('keeps installation progress visible after navigating back before the catalog is available', async () => {
    const api = host()
    localStorage.setItem('amadeus.localRuntime.lastUrl', backendUrl)
    api.localRuntimeStatus.mockResolvedValue({ ...runtime, phase: 'installing', owned: false, url: null, message: '正在安装运行组件', installProgress: {
      stage: 'installing', startedAt: Date.now(), updatedAt: Date.now(), lastEventAt: Date.now(), observedItems: 0, completedItems: 0, items: [],
    } } as LocalRuntimeState)
    render(<ModelDownloads />)
    expect(await screen.findByRole('region', { name: '下载与安装明细' })).toBeTruthy()
    expect(screen.getByText('正在安装运行组件')).toBeTruthy()
  })

  it('does not request a catalog until a backend is confirmed', async () => {
    useASRStore.getState().updateSettings({ backendConfirmed: false })
    render(<ModelDownloads />)
    await act(async () => undefined)
    expect(requests.catalog).not.toHaveBeenCalled()
    expect(screen.getByText(/请先在首页启动本机服务/)).toBeTruthy()
  })

  it('keeps ASR status and missing components visible while collapsing technical notes without avatar resources', async () => {
    host()
    catalog.models[0].notes = '本模型需要单独准备运行源码。'
    render(<ModelDownloads />)
    const install = await screen.findByRole('button', { name: '安装本模型运行组件（会重启服务）' })
    expect(screen.getByText('尚未下载权重').closest('details')).toBeNull()
    expect(screen.getByText('还需安装本模型运行组件').closest('details')).toBeNull()
    expect(screen.getByText('faster_whisper').closest('details')).toBeNull()
    expect(install.closest('details')).toBeNull()
    const details = screen.getByText('来源与下载说明').closest('details')
    expect(details?.open).toBe(false)
    expect(screen.getByText(model.weights.path).closest('details')).toBeNull()
    expect(screen.getByText(/来源与网络：/).closest('details')).toBe(details)
    expect(screen.getByText('本模型需要单独准备运行源码。').closest('details')).toBe(details)
    expect(screen.queryByText(/3D|数字人|GLB|角色资产/)).toBeNull()
  })

  it('sends the selected region and explicit mirror source, preserving a readable source label', async () => {
    render(<ModelDownloads />)
    await screen.findByRole('option', { name: 'Whisper tiny' })
    fireEvent.change(screen.getByRole('combobox', { name: '模型下载地区' }), { target: { value: 'global' } })
    fireEvent.change(screen.getByRole('combobox', { name: '模型下载来源' }), { target: { value: 'hf-mirror' } })
    fireEvent.click(screen.getByRole('button', { name: '从此来源下载' }))
    await waitFor(() => expect(requests.start).toHaveBeenCalledWith(backendUrl, model.id, 'global', 'hf-mirror'))
    expect(localStorage.getItem('amadeus.modelDownload.region')).toBe('global')
    expect(screen.getByRole('option', { name: 'HF-Mirror（第三方镜像）' })).toBeTruthy()
  })

  it('shows download progress and pauses the chosen task without changing source mid-download', async () => {
    catalog.jobs = [job]
    render(<ModelDownloads />)
    const pause = await screen.findByRole('button', { name: '暂停下载' })
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('10')
    expect((screen.getByRole('combobox', { name: '模型下载来源' }) as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(pause)
    await waitFor(() => expect(requests.cancel).toHaveBeenCalledWith(backendUrl, model.id))
  })

  it('shows real file sizes and progress with the destination visible', async () => {
    catalog.jobs = [{ ...job, downloaded_bytes: 30, current_file_downloaded_bytes: 10, current_file_total_bytes: 80, completed_files: 1, total_files: 2,
      files: [{ path: 'config.json', size: 20, downloaded_bytes: 20, status: 'completed' }, { path: 'model.bin', size: 80, downloaded_bytes: 10, status: 'downloading' }] }]
    render(<ModelDownloads />)
    await screen.findByRole('button', { name: '暂停下载' })
    expect(screen.getByText(model.weights.path).closest('details')).toBeNull()
    expect(screen.getByText('已下载 30 B / 100 B · 30.0%')).toBeTruthy()
    expect(screen.getByText('平均速度 4 B/s')).toBeTruthy()
    expect(screen.getByText('已校验文件 1 / 2')).toBeTruthy()
    expect(screen.getByText('10 B / 80 B')).toBeTruthy()
    fireEvent.click(screen.getByText('文件清单（2）'))
    expect(screen.getByRole('rowheader', { name: 'config.json' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '下载中' })).toBeTruthy()
  })

  it('does not invent a percentage from the estimated size while the inventory is unknown', async () => {
    catalog.models[0].estimated_size_bytes = 1024 * 1024
    catalog.jobs = [{ ...job, status: 'queued', downloaded_bytes: 0, total_bytes: 0, current_file: '', speed_bytes_per_second: 0 }]
    render(<ModelDownloads />)
    await screen.findByRole('button', { name: '暂停下载' })
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false)
    expect(screen.getByText('已下载 0 B · 总大小未知')).toBeTruthy()
    expect(screen.getByText(/总大小尚未取得，暂不显示百分比/)).toBeTruthy()
    expect(screen.getByText('预计下载 1.0 MB')).toBeTruthy()
  })

  it('blocks environment restart while another model is downloading', async () => {
    host()
    catalog.jobs = [{ ...job, id: 'another-model' }]
    render(<ModelDownloads />)
    const install = await screen.findByRole('button', { name: '安装本模型运行组件（会重启服务）' }) as HTMLButtonElement
    expect(install.disabled).toBe(true)
  })

  it('never offers to install dependencies into an external or remote backend', async () => {
    host(false)
    render(<ModelDownloads />)
    await screen.findByRole('option', { name: 'Whisper tiny' })
    expect(screen.queryByRole('button', { name: '安装本模型运行组件（会重启服务）' })).toBeNull()
  })

  it('refreshes the new backend URL after installing an extra causes its port to change', async () => {
    const api = host()
    const moved = { ...runtime, url: 'http://127.0.0.1:8769' }
    api.localRuntimeInstallExtra.mockResolvedValue(moved)
    render(<ModelDownloads />)
    const install = await screen.findByRole('button', { name: '安装本模型运行组件（会重启服务）' })
    requests.catalog.mockClear()
    fireEvent.click(install)
    await screen.findByText('本模型运行组件安装完成，后端已重新启动。')
    expect(api.localRuntimeInstallExtra).toHaveBeenCalledWith('whisper')
    expect(requests.catalog.mock.calls.length).toBeGreaterThan(0)
    expect(requests.catalog.mock.calls.every(call => call[0] === moved.url)).toBe(true)
    expect(useASRStore.getState().settings.serverUrl).toBe(moved.url)
  })

  it('keeps an action failure visible when the next background catalog poll succeeds', async () => {
    vi.useFakeTimers()
    requests.start.mockRejectedValueOnce(new Error('磁盘空间不足'))
    render(<ModelDownloads />)
    await act(async () => undefined)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '智能下载' })))
    expect(screen.getByRole('alert').textContent).toBe('磁盘空间不足')
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(requests.catalog.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByRole('alert').textContent).toBe('磁盘空间不足')
  })

  it('selects the downloaded model path while retaining existing user device and decoding preferences', async () => {
    catalog.models[0].weights = { ...model.weights, status: 'ready', verified: true }
    useASRStore.getState().updateSettings({ asrModelConfigs: { whisper: { modelName: 'base', device: 'cpu', computeType: 'int8', extraJson: '{"beam_size":2}' } } })
    render(<ModelDownloads />)
    fireEvent.click(await screen.findByRole('button', { name: '设为识别模型' }))
    await waitFor(() => expect(useASRStore.getState().settings.offlineEngine).toBe('whisper'))
    const selected = useASRStore.getState().settings.asrModelConfigs.whisper
    expect(selected).toMatchObject({ modelName: 'tiny', device: 'cpu', computeType: 'int8' })
    expect(JSON.parse(selected.extraJson)).toEqual({ beam_size: 2, model_dir: model.weights.path })
  })

  it('uses CUDA and automatic precision for newly downloaded FormalASR weights', async () => {
    catalog.models = [{ ...model, id: 'formalasr-1.7b', engine: 'formalasr', model_name: 'TaurenMountain/FormalASR-1.7B', label: 'FormalASR',
      weights: { ...model.weights, status: 'ready', verified: true, path: 'C:/Amadeus/models/formalasr' } }]
    render(<ModelDownloads />)
    fireEvent.click(await screen.findByRole('button', { name: '设为识别模型' }))
    await waitFor(() => expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr'))
    expect(useASRStore.getState().settings.asrModelConfigs.formalasr).toMatchObject({ device: 'cuda:0', computeType: 'auto' })
  })

  it('preserves explicit FormalASR CPU precision when selecting downloaded weights', async () => {
    catalog.models = [{ ...model, id: 'formalasr-1.7b', engine: 'formalasr', model_name: 'TaurenMountain/FormalASR-1.7B', label: 'FormalASR',
      weights: { ...model.weights, status: 'ready', verified: true } }]
    useASRStore.getState().updateSettings({ asrModelConfigs: { ...DEFAULT_SETTINGS.asrModelConfigs, formalasr: {
      modelName: 'old-path', device: 'cpu', computeType: 'float32', extraJson: '{}', deviceConfigured: true,
    } } })
    render(<ModelDownloads />)
    fireEvent.click(await screen.findByRole('button', { name: '设为识别模型' }))
    await waitFor(() => expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr'))
    expect(useASRStore.getState().settings.asrModelConfigs.formalasr).toMatchObject({ device: 'cpu', computeType: 'float32', deviceConfigured: true })
  })
})
