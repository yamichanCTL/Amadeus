// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'

describe('title bar close choice', () => {
  it('asks on every X click and performs the explicit action', () => {
    const closeWithAction = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { closeWithAction } })
    render(<TitleBar />)

    fireEvent.click(screen.getByTitle('关闭'))
    expect(screen.getByRole('dialog', { name: '关闭 Amadeus' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保留后台' }))
    expect(closeWithAction).toHaveBeenCalledWith('hide')

    fireEvent.click(screen.getByTitle('关闭'))
    fireEvent.click(screen.getByRole('button', { name: '完全退出' }))
    expect(closeWithAction).toHaveBeenCalledWith('quit')
  })
})
