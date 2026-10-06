// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { PageBoundary } from './PageBoundary'
import { ActivityBar } from './ActivityBar'
import { HomePage } from '@/pages/Home'
import { SettingsPage } from '@/pages/Settings'
import { useActivityStore, useActivityTask, type ActivityTask } from '@/services/activity'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'

const services = vi.hoisted(() => ({ forceStop: vi.fn(async () => {}), stopCaption: vi.fn(async () => {}) }))
vi.mock('@/services/recordingService', () => ({ recordingService: { forceStop: services.forceStop } }))
vi.mock('@/services/liveCaption', () => ({ liveCaptionService: { stop: services.stopCaption } }))
vi.mock('@/services/audio', () => ({
  audioRelayMixer: { isActive: vi.fn(() => false), getInputLevel: vi.fn(() => 0), getMonitorLevel: vi.fn(() => 0), stop: vi.fn(), stopMonitor: vi.fn(), startMonitor: vi.fn(), setOutputDevice: vi.fn(), start: vi.fn() },
  captureSpeakerAudio: vi.fn(), listAudioInputDevices: vi.fn(async () => []), listAudioOutputDevices: vi.fn(async () => []), testAudioInputDevice: vi.fn(), testAudioOutputDevice: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  useActivityStore.setState({ tasks: {} })
  useASRStore.setState({ page: 'home', settings: structuredClone(DEFAULT_SETTINGS), history: [], serverStatus: 'disconnected', recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', fileBatchRunning: false })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); useActivityStore.setState({ tasks: {} }) })

function SidebarHarness() {
  const [collapsed, setCollapsed] = useState(false)
  return <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} />
}
function RegisteredTask({ task }: { task: ActivityTask | null }) {
  useActivityTask('shell-fixture', task)
  return null
}

describe('workspace shell', () => {
  it('keeps navigation labels and current page semantics when the sidebar is collapsed', () => {
    render(<SidebarHarness />)
    const main = screen.getByRole('navigation', { name: '主导航' })
    expect(within(main).getByRole('button', { name: '首页' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: '折叠导航' }))
    expect(screen.getByRole('button', { name: '展开导航' })).toBeTruthy()
    fireEvent.click(within(main).getByRole('button', { name: '总结' }))
    expect(useASRStore.getState().page).toBe('summary')
    expect(within(main).getByRole('button', { name: '总结' }).getAttribute('aria-current')).toBe('page')
    expect(within(main).getByRole('button', { name: '首页' }).hasAttribute('aria-current')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '展开导航' }))
    expect(screen.getByRole('button', { name: '折叠导航' })).toBeTruthy()
  })

  it('isolates a failed page while preserving shell navigation and retries the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const suppressExpectedError = (event: ErrorEvent) => { if (event.message.includes('fixture render failure')) event.preventDefault() }
    window.addEventListener('error', suppressExpectedError)
    let fail = true
    function FragilePage() { if (fail) throw new Error('fixture render failure'); return <p>页面恢复</p> }
    render(<><Sidebar /><PageBoundary onHome={() => useASRStore.getState().setPage('home')}><FragilePage /></PageBoundary></>)
    expect(screen.getByRole('alert').textContent).toContain('这个页面暂时无法显示')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(useASRStore.getState().page).toBe('settings')
    fireEvent.click(screen.getByRole('button', { name: '返回首页' }))
    expect(useASRStore.getState().page).toBe('home')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试页面' }))
    expect(screen.getByText('页面恢复')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    window.removeEventListener('error', suppressExpectedError)
  })

  it('uses the current stop callback, reports failures, and clears unmounted activities', async () => {
    const originalStop = vi.fn(async () => {})
    const latestStop = vi.fn(async () => { throw new Error('停止失败示例') })
    const task: ActivityTask = { label: '测试生成任务', detail: '当前范围', page: 'summary', onStop: originalStop }
    const page = render(<><RegisteredTask task={task} /><ActivityBar /></>)
    await screen.findByRole('region', { name: '正在运行的任务' })
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(useASRStore.getState().page).toBe('summary')
    page.rerender(<><RegisteredTask task={{ ...task, onStop: latestStop }} /><ActivityBar /></>)
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '停止失败示例')
    expect(latestStop).toHaveBeenCalledTimes(1)
    expect(originalStop).not.toHaveBeenCalled()
    page.rerender(<ActivityBar />)
    await waitFor(() => expect(screen.queryByRole('region', { name: '正在运行的任务' })).toBeNull())
    expect(useActivityStore.getState().tasks).toEqual({})
  })

  it('disables a stop action until its pending operation finishes', async () => {
    let finish!: () => void
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<><RegisteredTask task={{ label: '正在处理', onStop: stop }} /><ActivityBar /></>)
    fireEvent.click(await screen.findByRole('button', { name: '停止' }))
    const pending = screen.getByRole('button', { name: '正在停止' }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    fireEvent.click(pending)
    expect(stop).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    expect((screen.getByRole('button', { name: '停止' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('dispatches recording and caption stop actions to their owning services', async () => {
    useASRStore.setState({ recordStatus: 'recording' })
    render(<ActivityBar />)
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(services.forceStop).toHaveBeenCalledTimes(1))
    await act(async () => { useASRStore.setState({ recordStatus: 'idle', liveCaptionStatus: 'connecting' }) })
    expect(screen.getByText('正在连接实时字幕')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() => expect(services.stopCaption).toHaveBeenCalledTimes(1))
    await act(async () => { useASRStore.setState({ liveCaptionStatus: 'idle' }) })
    expect(screen.queryByRole('region', { name: '正在运行的任务' })).toBeNull()
  })

  it('collapses connected environment controls and never reinstalls or restarts on navigation', async () => {
    const running: LocalRuntimeState = { phase: 'running', installed: true, owned: true, url: 'http://127.0.0.1:18000', autoStart: false, message: '环境运行中', root: 'C:/fixture', logPath: '' }
    const host = { localRuntimeStatus: vi.fn(async () => running), onLocalRuntimeState: vi.fn(() => vi.fn()), localRuntimeInstall: vi.fn(), localRuntimeStart: vi.fn() }
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: host })
    useASRStore.setState({ serverStatus: 'connected', settings: { ...DEFAULT_SETTINGS, serverUrl: running.url!, backendConfirmed: true } })
    const page = render(<HomePage />)
    const summary = screen.getByText('环境与连接管理').closest('summary')!
    expect(summary.closest('details')?.open).toBe(false)
    await waitFor(() => expect(host.localRuntimeStatus).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: '停止本机服务' }).closest('.home-ready-environment')).toBe(summary.closest('details'))
    fireEvent.click(summary)
    expect(await screen.findByRole('button', { name: '停止本机服务' })).toBeTruthy()
    page.unmount()
    render(<HomePage />)
    expect(screen.getByText('环境与连接管理').closest('details')?.open).toBe(false)
    expect(host.localRuntimeInstall).not.toHaveBeenCalled()
    expect(host.localRuntimeStart).not.toHaveBeenCalled()
    expect(useASRStore.getState().settings.serverUrl).toBe(running.url)
  })

  it('keeps avatar import inside its own settings category and links to the preview', () => {
    render(<SettingsPage />)
    expect(screen.queryByRole('region', { name: '本地 3D 模型' })).toBeNull()
    const avatar = screen.getByRole('button', { name: '角色与桌宠' })
    expect(avatar.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(avatar)
    expect(avatar.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: '本地 3D 模型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '导入本地 GLB' })).toBeTruthy()
    expect(screen.queryByLabelText('后端地址')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开角色预览' }))
    expect(useASRStore.getState().page).toBe('realtime')
    fireEvent.click(screen.getByRole('button', { name: '通用' }))
    expect(screen.queryByRole('region', { name: '本地 3D 模型' })).toBeNull()
  })
})
