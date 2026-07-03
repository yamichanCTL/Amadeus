// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createSummaryWorkspace, useASRStore } from './useASRStore'

describe('summary workspace and prompt cards', () => {
  beforeEach(() => {
    const state = useASRStore.getState()
    useASRStore.setState({
      page: 'summary',
      summaryWorkspace: createSummaryWorkspace(new Date(2026, 6, 3, 15, 30)),
      settings: {
        ...state.settings,
        showDesktopCaptions: true,
      },
    })
  })

  it('keeps a generated summary when navigating away and back', () => {
    const result = {
      summary: '## 总览\n\n- 已完成',
      model: 'demo',
      source_count: 2,
      input_chars: 20,
      estimated_input_tokens: 8,
      chunk_count: 1,
      truncated: false,
      date: '2026-07-03',
    }
    useASRStore.getState().updateSummaryWorkspace({ result })
    useASRStore.getState().setPage('models')
    useASRStore.getState().setPage('summary')
    expect(useASRStore.getState().summaryWorkspace.result).toEqual(result)
  })

  it('selects a prompt card and prefills the active LLM prompt', () => {
    const translation = useASRStore.getState().settings.promptCards.find((card) => card.id === 'translate-en')
    expect(translation).toBeTruthy()
    useASRStore.getState().updateSettings({ activePromptCardId: translation!.id })
    expect(useASRStore.getState().settings.llmPolishPrompt).toBe(translation!.prompt)
  })

  it('defaults desktop captions to enabled', () => {
    expect(useASRStore.getState().settings.showDesktopCaptions).toBe(true)
  })

  it('defaults summaries to explicit local records and supports summary prompt cards', () => {
    expect(useASRStore.getState().summaryWorkspace.source).toBe('local')
    const card = useASRStore.getState().settings.summaryPromptCards.find((item) => item.id === 'todo-review')
    expect(card).toBeTruthy()
    useASRStore.getState().updateSettings({ activeSummaryPromptCardId: card!.id })
    expect(useASRStore.getState().settings.summaryPrompt).toBe(card!.prompt)
  })
})
