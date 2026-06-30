// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { selectDeliveryText } from './recordingService'
import { copyText } from './export'
import type { TranscribeResponse } from './api'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const result: TranscribeResponse = {
  task_id: 'task-regression',
  status: 'success',
  full_text: '普通 ASR 结果',
  language: 'zh',
  engine_used: 'fireredasr2',
  confidence: 0.99,
  duration_sec: 1,
  elapsed_sec: 1,
  segments: [],
  llm_outputs: {
    polish: { text: '已经润色的结果', operation: 'polish', model: 'test-model', elapsed_sec: 0.1 },
    translate: { text: 'Translated result', operation: 'translate', model: 'test-model', elapsed_sec: 0.1 },
  },
}

describe('desktop result delivery regressions', () => {
  beforeEach(() => {
    useASRStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  it('auto-fills the polished result when offline polish is enabled', () => {
    useASRStore.setState({
      settings: { ...DEFAULT_SETTINGS, llmAutoPolish: true, llmAutoTranslate: false },
    })

    expect(selectDeliveryText(result)).toBe('已经润色的结果')
  })

  it('auto-fills the translated result when translation is enabled', () => {
    useASRStore.setState({
      settings: { ...DEFAULT_SETTINGS, llmAutoPolish: false, llmAutoTranslate: true },
    })

    expect(selectDeliveryText(result)).toBe('Translated result')
  })

  it('falls back to ASR text when enhancement is disabled or unavailable', () => {
    expect(selectDeliveryText(result)).toBe('普通 ASR 结果')
    useASRStore.setState({
      settings: { ...DEFAULT_SETTINGS, llmAutoPolish: true, llmAutoTranslate: false },
    })
    expect(selectDeliveryText({ ...result, llm_outputs: undefined })).toBe('普通 ASR 结果')
  })

  it('uses a fire-and-forget Electron clipboard path without awaiting another process', async () => {
    const textToClipboard = vi.fn(() => true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { textToClipboard },
    })

    await expect(copyText('立即复制')).resolves.toBe(true)
    expect(textToClipboard).toHaveBeenCalledWith('立即复制')
  })
})
