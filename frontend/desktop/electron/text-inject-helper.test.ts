// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { textInjectionFailure } from './text-inject-helper'

describe('text injection failure details', () => {
  it.each(['target-missing', 'focus-not-restored', 'not-editable', 'clipboard-busy', 'input-rejected', 'timeout'])('keeps an actionable fixed explanation for %s', code => {
    expect(textInjectionFailure(code)).toMatch(/自动填充未(?:完成|确认)：/)
    expect(textInjectionFailure(code)).toContain('结果已保留，可点击复制')
  })

  it('does not expose unknown upstream text or exception messages', () => {
    const reason = textInjectionFailure('user secret text from UIAutomation')
    expect(reason).not.toContain('secret')
    expect(reason).toContain('输入框的焦点和运行权限')
  })
})
