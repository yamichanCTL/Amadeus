// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptTemplatePicker } from './PromptTemplatePicker'
import type { PromptCard } from '@/store/useASRStore'

afterEach(cleanup)
const initialCards: PromptCard[] = [
  { id: 'clean', name: '口语整理', prompt: '只整理口语，不新增内容。' },
  { id: 'translate', name: '翻译英文', prompt: '只输出英文译文。' },
]

function Editor() {
  const [value, setValue] = useState({ cards: initialCards, activeCardId: 'clean', prompt: initialCards[0].prompt })
  return <PromptTemplatePicker {...value} autoProcessing={false} textModelName="" textModelReady={false} onChange={setValue} onAutoProcessingChange={() => {}} onConfigureModel={() => {}} />
}

describe('inline recognition prompt templates', () => {
  it('edits, adds and deletes templates in one expandable editor and retains at least one', () => {
    render(<Editor />)
    fireEvent.click(screen.getByText('编辑当前模板'))
    fireEvent.change(screen.getByRole('textbox', { name: '模板名称' }), { target: { value: '我的整理' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 内容' }), { target: { value: '保留术语。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(screen.getByRole('button', { name: '选择模板：我的整理' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增模板' }))
    expect(screen.getByRole('button', { name: '选择模板：自定义 3' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('textbox', { name: 'Prompt 内容' }) as HTMLTextAreaElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }))
    expect(screen.queryByRole('button', { name: '选择模板：自定义 3' })).toBeNull()
    expect(screen.getByRole('button', { name: '选择模板：我的整理' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '选择模板：翻译英文' }))
    expect((screen.getByRole('textbox', { name: 'Prompt 内容' }) as HTMLTextAreaElement).value).toBe('只输出英文译文。')
    fireEvent.click(screen.getByRole('button', { name: '删除模板' }))
    expect((screen.getByRole('button', { name: '删除模板' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports auto-processing model readiness without calling a model when a template is selected', () => {
    const onChange = vi.fn()
    const autoChange = vi.fn()
    const props = { cards: initialCards, activeCardId: 'clean', autoProcessing: true, textModelName: 'deepseek-flash', textModelReady: false, onChange, onAutoProcessingChange: autoChange, onConfigureModel: vi.fn() }
    const { rerender } = render(<PromptTemplatePicker {...props} />)
    expect(screen.getByText('自动整理已开启 · 待配置模型')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择模板：翻译英文' }))
    expect(onChange).toHaveBeenCalledWith({ cards: initialCards, activeCardId: 'translate', prompt: initialCards[1].prompt })
    expect(autoChange).not.toHaveBeenCalled()
    rerender(<PromptTemplatePicker {...props} textModelReady />)
    expect(screen.getByText('自动整理已开启 · deepseek-flash')).toBeTruthy()
  })
})
