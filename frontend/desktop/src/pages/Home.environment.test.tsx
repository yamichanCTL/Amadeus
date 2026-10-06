// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from './Home'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'

const ready: LocalRuntimeState = {
  phase: 'ready', installed: true, url: null, message: '环境已安装，可以启动。',
  autoStart: false, root: 'C:\\fixture\\runtime', logPath: '', owned: false,
}

beforeEach(() => {
  localStorage.clear()
  useASRStore.setState({ page: 'home', settings: structuredClone(DEFAULT_SETTINGS), history: [], serverStatus: 'disconnected' })
})
afterEach(cleanup)

function runtime(initial: LocalRuntimeState) {
  let current = initial
  const api = {
    localRuntimeStatus: vi.fn(async () => current),
    localRuntimeInstall: vi.fn(async () => ready),
    localRuntimeStart: vi.fn(async () => {
      current = { ...ready, phase: 'running', url: 'http://127.0.0.1:18000', owned: true }
      return current
    }),
    onLocalRuntimeState: vi.fn(() => vi.fn()),
  }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  return api
}

describe('homepage shared environment', () => {
  it('offers first-run setup once without repeating task model editors', async () => {
    const api = runtime({ ...ready, phase: 'missing', installed: false })
    render(<HomePage />)
    expect(await screen.findAllByRole('button', { name: '一键安装并启动' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '识别后处理模型配置' })).toBeNull()
    expect(screen.queryByLabelText('连接 API Key')).toBeNull()
    expect(api.localRuntimeInstall).not.toHaveBeenCalled()
    expect(api.localRuntimeStart).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /语音识别.*进入任务/ }))
    expect(useASRStore.getState().page).toBe('transcribe')
    expect(api.localRuntimeInstall).not.toHaveBeenCalled()
  })

  it('starts an existing environment and reuses its connection after navigating back', async () => {
    const api = runtime(ready)
    useASRStore.getState().updateSettings({ llmModel: 'existing-model', llmApiToken: 'fixture-token' })
    const connections = structuredClone(useASRStore.getState().settings.modelConnections)
    const first = render(<HomePage />)
    fireEvent.click(await screen.findByRole('button', { name: '启动本机服务' }))
    await screen.findByRole('button', { name: '停止本机服务' })
    expect(screen.queryByRole('list', { name: '开始使用步骤' })).toBeNull()
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: 'http://127.0.0.1:18000', backendConfirmed: true })
    first.unmount()
    render(<HomePage />)
    await waitFor(() => expect(screen.getByRole('button', { name: '停止本机服务' })).toBeTruthy())
    expect(api.localRuntimeStart).toHaveBeenCalledTimes(1)
    expect(api.localRuntimeInstall).not.toHaveBeenCalled()
    expect(useASRStore.getState().settings.modelConnections).toEqual(connections)
    expect(screen.queryByRole('button', { name: '一键安装并启动' })).toBeNull()
  })
})
