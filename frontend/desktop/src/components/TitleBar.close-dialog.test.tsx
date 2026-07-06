// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

describe('title bar close choice', () => {
  it('remembers an explicit close action and reuses the shared setting', () => {
    const closeWithAction = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { closeWithAction } })
    useASRStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    render(<TitleBar />)

    fireEvent.click(screen.getByTitle('关闭'))
    expect(screen.getByRole('dialog', { name: '关闭 Amadeus' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '记住选择' }))
    fireEvent.click(screen.getByRole('button', { name: '保留后台' }))
    expect(closeWithAction).toHaveBeenCalledWith('hide')
    expect(useASRStore.getState().settings.keepRunningInBackground).toBe(true)
    expect(useASRStore.getState().settings.rememberCloseAction).toBe(true)

    fireEvent.click(screen.getByTitle('关闭'))
    expect(screen.queryByRole('dialog', { name: '关闭 Amadeus' })).toBeNull()
    expect(closeWithAction).toHaveBeenLastCalledWith('hide')
  })
})
