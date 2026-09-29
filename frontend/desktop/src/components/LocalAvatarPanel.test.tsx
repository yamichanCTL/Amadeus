import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAvatarPanel } from './LocalAvatarPanel'
import type { LocalAvatarStatus } from '../vite-env'

const empty: LocalAvatarStatus = { available: false, name: null, size: 0, revision: null }
const imported: LocalAvatarStatus = { available: true, name: '我的模型.glb', size: 1024, revision: 'new' }
let changed: (value: LocalAvatarStatus) => void
let api: Record<string, any>
beforeEach(() => {
  api = {
    localAvatarStatus: vi.fn(async () => empty), localAvatarRead: vi.fn(),
    localAvatarImport: vi.fn(async () => imported), localAvatarClear: vi.fn(async () => empty),
    onLocalAvatarChanged: vi.fn((callback) => { changed = callback; return vi.fn() }),
  }
  window.electronAPI = api as any
})
afterEach(() => { cleanup(); delete window.electronAPI })

describe('local avatar import controls', () => {
  it('imports a local GLB and reacts to remove events from the desktop', async () => {
    render(<LocalAvatarPanel />)
    fireEvent.click(screen.getByRole('button', { name: '导入本地 GLB' }))
    await screen.findByText('我的模型.glb')
    expect(api.localAvatarImport).toHaveBeenCalledWith()
    expect(api.localAvatarRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '移除本机模型' }))
    await waitFor(() => expect(api.localAvatarClear).toHaveBeenCalledTimes(1))
    act(() => changed(empty))
    await screen.findByRole('button', { name: '导入本地 GLB' })
  })

  it('keeps the current model when the file chooser is cancelled', async () => {
    api.localAvatarStatus.mockResolvedValue(imported)
    api.localAvatarImport.mockResolvedValue({ ...empty, cancelled: true })
    render(<LocalAvatarPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '更换本地模型' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '更换本地模型' }).hasAttribute('disabled')).toBe(false))
    expect(screen.getByText('我的模型.glb')).toBeTruthy()
  })

  it('shows a validation failure without replacing an existing model', async () => {
    api.localAvatarStatus.mockResolvedValue(imported)
    api.localAvatarImport.mockResolvedValue({ ...imported, error: '模型包含外部贴图，请导出自包含 GLB。' })
    render(<LocalAvatarPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '更换本地模型' }))
    expect((await screen.findByRole('alert')).textContent).toContain('外部贴图')
    expect(screen.getByText('我的模型.glb')).toBeTruthy()
  })

  it('explains the desktop requirement when IPC is unavailable', () => {
    delete window.electronAPI
    render(<LocalAvatarPanel compact />)
    expect(screen.getByRole('button', { name: '导入本地 GLB' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('请在 Windows 桌面版中导入本地模型。')).toBeTruthy()
  })
})
