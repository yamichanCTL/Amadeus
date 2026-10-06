import { describe, expect, it } from 'vitest'
import { deepSeekOpenAIBaseUrl, llmConnectionFailureMessage } from './llmProviders'

describe('known DeepSeek protocol address correction', () => {
  it.each(['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/', '  https://API.DEEPSEEK.COM/anthropic/  '])('corrects the official base %s', url => {
    expect(deepSeekOpenAIBaseUrl('deepseek', url)).toBe('https://api.deepseek.com')
  })
  it.each([
    ['custom', 'https://api.deepseek.com/anthropic'],
    ['openai', 'https://api.deepseek.com/anthropic'],
    ['deepseek', 'http://api.deepseek.com/anthropic'],
    ['deepseek', 'https://gateway.test/anthropic'],
    ['deepseek', 'https://api.deepseek.com.gateway.test/anthropic'],
    ['deepseek', 'https://api.deepseek.com:8443/anthropic'],
    ['deepseek', 'https://user:fixture@api.deepseek.com/anthropic'],
    ['deepseek', 'https://api.deepseek.com/anthropic?token=fixture'],
    ['deepseek', 'https://api.deepseek.com/anthropic#fixture'],
    ['deepseek', 'https://api.deepseek.com/anthropic/v1'],
    ['deepseek', 'https://api.deepseek.com'],
    ['deepseek', 'not a URL'],
  ])('preserves unrelated or ambiguous address (%s, %s)', (provider, url) => {
    expect(deepSeekOpenAIBaseUrl(provider, url)).toBeNull()
  })
})

describe('safe connection failure descriptions', () => {
  it.each([[401, '鉴权失败'], [402, '余额不足'], [403, '访问权限'], [404, '接口未找到'], [429, '限流'], [503, '暂不可用']] as const)('explains HTTP %s with a fixed Chinese message', (code, expected) => {
    expect(llmConnectionFailureMessage(code)).toContain(`HTTP ${code}`)
    expect(llmConnectionFailureMessage(code)).toContain(expected)
  })
  it.each([null, undefined, NaN, Infinity, -1, 999, 401.5, 'fixture-key'])('rejects an unsafe status value %s', code => {
    expect(llmConnectionFailureMessage(code as number)).toBe('连接检查失败，请检查后端、接口地址和 API Key。')
  })
})
