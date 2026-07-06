// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { asyncTaskPollTimeoutMs, captureRendererTextTarget, insertIntoRendererTextTarget } from './recordingService'

describe('Amadeus renderer text target', () => {
  it('keeps asynchronous long-audio polling alive for at least 30 minutes', () => {
    expect(asyncTaskPollTimeoutMs(20)).toBe(30 * 60 * 1000)
    expect(asyncTaskPollTimeoutMs(3600)).toBe(3600 * 1000)
  })

  it('inserts ASR text at the current textarea selection and emits input', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'Prompt: []'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.setSelectionRange(8, 8)
    const onInput = vi.fn()
    textarea.addEventListener('input', onInput)

    const target = captureRendererTextTarget(document)
    expect(insertIntoRendererTextTarget(target, '识别内容')).toBe(true)
    expect(textarea.value).toBe('Prompt: 识别内容[]')
    expect(onInput).toHaveBeenCalledTimes(1)
  })

  it('updates a React-controlled prompt textarea instead of being rolled back', () => {
    function ControlledPrompt() {
      const [value, setValue] = useState('提示词：')
      return createElement('textarea', { 'aria-label': 'Prompt', value, onChange: (event) => setValue((event.currentTarget as HTMLTextAreaElement).value) })
    }
    render(createElement(ControlledPrompt))
    const textarea = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)

    expect(insertIntoRendererTextTarget(captureRendererTextTarget(document), '自动填充')).toBe(true)
    expect(textarea.value).toBe('提示词：自动填充')
  })

  it('rejects a target that was removed while recognition was running', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const target = captureRendererTextTarget(document)
    input.remove()
    expect(insertIntoRendererTextTarget(target, '不会写入')).toBe(false)
  })
})
