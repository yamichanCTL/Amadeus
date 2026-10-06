// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelector } from './ModelSelector'

afterEach(cleanup)
describe('model dropdown and manual entry', () => {
  it('opens a real select with deduplicated model choices and reports the selected ID', () => {
    const change = vi.fn()
    render(<ModelSelector label="模型选择" value="first" models={['first', ' second ', 'first', '', 'second']} onChange={change} catalogStatus="ready" />)
    const select = screen.getByRole('combobox', { name: '模型选择' })
    fireEvent.change(select, { target: { value: within(select).getByRole('option', { name: 'second' }).getAttribute('value') } })
    expect(change).toHaveBeenCalledExactlyOnceWith('second')
    expect(screen.getByText('2 个可选模型；也可手动填写。')).toBeTruthy()
  })

  it('does not change an existing model when fetching suggestions or entering manual mode', () => {
    const change = vi.fn()
    const view = render(<ModelSelector label="模型选择" value="saved-model" models={[]} onChange={change} />)
    view.rerender(<ModelSelector label="模型选择" value="saved-model" models={['other']} onChange={change} catalogStatus="ready" />)
    const select = screen.getByRole('combobox', { name: '模型选择' })
    expect((within(select).getByRole('option', { name: 'saved-model · 当前配置' }) as HTMLOptionElement).selected).toBe(true)
    fireEvent.change(select, { target: { value: 'manual' } })
    expect((screen.getByRole('textbox', { name: '模型选择（手动填写）' }) as HTMLInputElement).value).toBe('saved-model')
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '模型选择（手动填写）' }), { target: { value: 'my-custom' } })
    expect(change).toHaveBeenCalledWith('my-custom')
  })

  it('can select a catalog model literally named manual without confusing it with manual entry', () => {
    const change = vi.fn()
    render(<ModelSelector label="模型选择" value="" models={['manual', 'saved', 'empty']} onChange={change} />)
    const select = screen.getByRole('combobox', { name: '模型选择' })
    fireEvent.change(select, { target: { value: within(select).getByRole('option', { name: 'manual' }).getAttribute('value') } })
    expect(change).toHaveBeenCalledWith('manual')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('supports intentional clearing without inventing a model in an empty catalog', () => {
    const change = vi.fn()
    render(<ModelSelector label="模型选择" value="configured" models={[]} onChange={change} catalogStatus="ready" />)
    expect(screen.getByText('服务未返回可选模型，可手动填写模型名称。')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'empty' } })
    expect(change).toHaveBeenCalledWith('')
  })
})
