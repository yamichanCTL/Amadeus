// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { BackendConnectionSettings } from './BackendConnectionSettings'

beforeEach(() => {
  useASRStore.setState({ settings: { ...structuredClone(DEFAULT_SETTINGS), serverUrl: 'https://existing.test:8443', backendConfirmed: true, llmApiToken: 'existing-fixture-key' } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('shared backend address confirmation', () => {
  it('keeps a draft local until confirmation and preserves unrelated credentials', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<BackendConnectionSettings />)
    fireEvent.change(screen.getByLabelText('后端地址'), { target: { value: '  http://127.0.0.1:8768/  ' } })
    expect(useASRStore.getState().settings.serverUrl).toBe('https://existing.test:8443')
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: 'http://127.0.0.1:8768', backendConfirmed: true, llmApiToken: 'existing-fixture-key' })
    expect(screen.getByRole('status').textContent).toContain('已确认后端地址：http://127.0.0.1:8768')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects invalid addresses without changing the active connection', () => {
    render(<BackendConnectionSettings />)
    fireEvent.change(screen.getByLabelText('后端地址'), { target: { value: 'not an address' } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.getByRole('status').textContent).toContain('地址格式无效')
    expect(useASRStore.getState().settings.serverUrl).toBe('https://existing.test:8443')
  })

  it('syncs external connection changes and supports explicitly clearing the address', () => {
    render(<BackendConnectionSettings />)
    fireEvent.change(screen.getByLabelText('后端地址'), { target: { value: 'draft.example:18000' } })
    act(() => useASRStore.getState().updateSettings({ serverUrl: 'http://127.0.0.1:8768', backendConfirmed: true }))
    expect((screen.getByLabelText('后端地址') as HTMLInputElement).value).toBe('http://127.0.0.1:8768')
    fireEvent.change(screen.getByLabelText('后端地址'), { target: { value: '' } })
    fireEvent.keyDown(screen.getByLabelText('后端地址'), { key: 'Enter' })
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: '', backendConfirmed: false, llmApiToken: 'existing-fixture-key' })
    expect(screen.getByRole('status').textContent).toContain('已清空后端地址')
  })

  it.each([['/', ''], ['existing.example:18000', 'http://existing.example:18000']])('preserves normalization of existing address format %s', (address, expected) => {
    render(<BackendConnectionSettings />)
    fireEvent.change(screen.getByLabelText('后端地址'), { target: { value: address } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(useASRStore.getState().settings).toMatchObject({ serverUrl: expected, backendConfirmed: Boolean(expected) })
  })
})
