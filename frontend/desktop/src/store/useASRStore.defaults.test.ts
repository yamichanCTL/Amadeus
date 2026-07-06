import { describe, expect, it } from 'vitest'
import { createSummaryWorkspace, DEFAULT_SETTINGS } from './useASRStore'

describe('desktop product defaults', () => {
  it('starts with a blank custom LLM configuration', () => {
    expect(DEFAULT_SETTINGS.llmProvider).toBe('custom')
    expect(DEFAULT_SETTINGS.llmBaseUrl).toBe('')
    expect(DEFAULT_SETTINGS.llmModel).toBe('')
  })

  it('starts a daily summary for today, both types, through 23:59', () => {
    const workspace = createSummaryWorkspace(new Date(2026, 6, 6, 8, 30))
    expect(workspace.date).toBe('2026-07-06')
    expect(workspace.category).toBe('')
    expect(workspace.endTime).toBe('23:59')
  })
})
