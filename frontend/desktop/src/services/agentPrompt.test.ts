import { describe, expect, it } from 'vitest'
import { fillPromptFromAsr } from './agentPrompt'

describe('ASR prompt autofill', () => {
  it('fills an empty software prompt with the recognized text', () => {
    expect(fillPromptFromAsr('', '  今天继续修复流式总结。 ')).toBe('今天继续修复流式总结。')
  })

  it('appends a new ASR result without deleting a draft', () => {
    expect(fillPromptFromAsr('请整理：', '第一条记录')).toBe('请整理：\n第一条记录')
  })
})
