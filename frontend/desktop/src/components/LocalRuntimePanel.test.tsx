// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalRuntimePanel } from './LocalRuntimePanel'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { connectLocalRuntime, useLocalRuntimeConnection } from '@/services/localRuntimeConnection'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'

const missing: LocalRuntimeState = { phase: 'missing', installed: false, url: null, message: '尚未安装本机环境', autoStart: true, root: 'C:\\Users\\test\\Amadeus', logPath: 'C:\\Users\\test\\Amadeus\\setup.log', owned: false }
const ready: LocalRuntimeState = { ...missing, phase: 'ready', installed: true, message: '本机环境安装完成' }
const running: LocalRuntimeState = { ...ready, phase: 'running', url: 'http://127.0.0.1:18000', message: '本机服务已启动', owned: true }

function mockApi(initial = missing) {
  let listener: (state: LocalRuntimeState) => void = () => undefined
  const off = vi.fn()
  const api = {
    localRuntimeStatus: vi.fn(async () => initial),
    localRuntimeInstall: vi.fn(async () => ready),
    localRuntimeStart: vi.fn(async () => running),
    localRuntimeStop: vi.fn(async () => ready),
    localRuntimeSetAutoStart: vi.fn(async (enabled: boolean) => ({ ...initial, autoStart: enabled })),
    localRuntimeOpenLogs: vi.fn(async () => undefined),
    localRuntimeOpenFolder: vi.fn(async () => undefined),
    onLocalRuntimeState: vi.fn((callback: (state: LocalRuntimeState) => void) => { listener = callback; return off }),
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  return { api, emit: (state: LocalRuntimeState) => act(() => listener(state)), off }
}

beforeEach(() => {
  localStorage.clear()
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: '', backendConfirmed: false } })
})
afterEach(cleanup)

describe('Windows local environment setup', () => {
  it('waits for installation before starting and connects only once running', async () => {
    const { api, emit } = mockApi()
    let finishInstall!: (state: LocalRuntimeState) => void
    api.localRuntimeInstall.mockImplementation(() => new Promise((resolve) => { finishInstall = resolve }))
    render(<LocalRuntimePanel />)
    const install = await screen.findByRole('button', { name: '一键安装并启动' })
    fireEvent.click(install)
    fireEvent.click(install)
    expect(api.localRuntimeInstall).toHaveBeenCalledTimes(1)
    expect(api.localRuntimeStart).not.toHaveBeenCalled()
    expect(useASRStore.getState().settings.backendConfirmed).toBe(false)
    emit({ ...missing, phase: 'installing', progress: 42, message: '正在准备环境' })
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('42')
    await act(async () => finishInstall(ready))
    await waitFor(() => expect(api.localRuntimeStart).toHaveBeenCalledTimes(1))
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: running.url, backendConfirmed: true })
    expect(screen.getByRole('button', { name: '停止本机服务' })).toBeTruthy()
  })

  it('supports installing in advance without starting or changing remote server settings', async () => {
    useASRStore.getState().updateSettings({ serverUrl: 'https://my-server.example', backendConfirmed: true })
    const { api } = mockApi()
    render(<LocalRuntimePanel />)
    fireEvent.click(await screen.findByRole('button', { name: '只安装环境' }))
    await screen.findByRole('button', { name: '启动本机服务' })
    expect(api.localRuntimeStart).not.toHaveBeenCalled()
    expect(useASRStore.getState().settings.serverUrl).toBe('https://my-server.example')
  })

  it('keeps failures visible and permits retry without starting an incomplete environment', async () => {
    const { api } = mockApi()
    api.localRuntimeInstall.mockResolvedValueOnce({ ...missing, phase: 'error', error: '下载失败，请检查网络' })
    render(<LocalRuntimePanel />)
    fireEvent.click(await screen.findByRole('button', { name: '一键安装并启动' }))
    expect((await screen.findByRole('alert')).textContent).toContain('下载失败')
    expect(api.localRuntimeStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试安装并启动' }))
    await screen.findByRole('button', { name: '停止本机服务' })
    expect(api.localRuntimeInstall).toHaveBeenCalledTimes(2)
  })

  it('repairs an installed environment after startup failure without starting or replacing a remote URL', async () => {
    useASRStore.getState().updateSettings({ serverUrl: 'https://my-server.example', backendConfirmed: true })
    const { api } = mockApi({ ...ready, phase: 'error', error: '缺少运行依赖，启动失败' })
    render(<LocalRuntimePanel />)
    fireEvent.click(await screen.findByRole('button', { name: '修复环境' }))
    await screen.findByRole('button', { name: '启动本机服务' })
    expect(api.localRuntimeInstall).toHaveBeenCalledTimes(1)
    expect(api.localRuntimeStart).not.toHaveBeenCalled()
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: 'https://my-server.example', backendConfirmed: true })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not stop an external service and needs explicit selection to replace a remote URL', async () => {
    useASRStore.getState().updateSettings({ serverUrl: 'https://my-server.example', backendConfirmed: true })
    const { api } = mockApi({ ...running, owned: false })
    render(<LocalRuntimePanel />)
    const connect = await screen.findByRole('button', { name: '连接此服务' })
    expect(useASRStore.getState().settings.serverUrl).toBe('https://my-server.example')
    const stop = screen.getByRole('button', { name: '停止本机服务' }) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    fireEvent.click(stop)
    expect(api.localRuntimeStop).not.toHaveBeenCalled()
    fireEvent.click(connect)
    expect(useASRStore.getState().settings.serverUrl).toBe(running.url)
  })

  it('saves auto-start preference through the desktop host and unsubscribes', async () => {
    const { api, off } = mockApi(ready)
    const view = render(<LocalRuntimePanel />)
    fireEvent.click(await screen.findByRole('checkbox', { name: '打开 Amadeus 时自动启动' }))
    await waitFor(() => expect(api.localRuntimeSetAutoStart).toHaveBeenCalledWith(false))
    view.unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('shows Windows desktop guidance when opened without the host API', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    render(<LocalRuntimePanel />)
    expect(screen.getByText(/请使用 Windows 桌面版/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '一键安装并启动' })).toBeNull()
  })
})

describe('automatic local service connection', () => {
  it('connects a first-run auto-started service, but not a disabled auto-start or remote configuration', () => {
    connectLocalRuntime({ ...running, autoStart: false })
    expect(useASRStore.getState().settings.serverUrl).toBe('')
    connectLocalRuntime(running)
    expect(useASRStore.getState().settings.serverUrl).toBe(running.url)
    useASRStore.getState().updateSettings({ serverUrl: 'https://remote.example', backendConfirmed: true })
    connectLocalRuntime({ ...running, url: 'http://127.0.0.1:18001' })
    expect(useASRStore.getState().settings.serverUrl).toBe('https://remote.example')
  })

  it('follows a managed port change while leaving unrelated localhost services alone', () => {
    connectLocalRuntime(running, true)
    connectLocalRuntime({ ...running, url: 'http://127.0.0.1:18001' })
    expect(useASRStore.getState().settings.serverUrl).toBe('http://127.0.0.1:18001')
    useASRStore.getState().updateSettings({ serverUrl: 'http://127.0.0.1:8000', backendConfirmed: true })
    connectLocalRuntime({ ...running, url: 'http://127.0.0.1:18002' })
    expect(useASRStore.getState().settings.serverUrl).toBe('http://127.0.0.1:8000')
  })

  it('handles state events without opening Settings and ignores an older pending snapshot', async () => {
    const { api, emit, off } = mockApi()
    let finishStatus!: (state: LocalRuntimeState) => void
    api.localRuntimeStatus.mockImplementation(() => new Promise((resolve) => { finishStatus = resolve }))
    function Connection() { useLocalRuntimeConnection(); return null }
    const view = render(<Connection />)
    emit(running)
    expect(useASRStore.getState().settings.serverUrl).toBe(running.url)
    await act(async () => finishStatus({ ...running, url: 'http://127.0.0.1:19999' }))
    expect(useASRStore.getState().settings.serverUrl).toBe(running.url)
    view.unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
