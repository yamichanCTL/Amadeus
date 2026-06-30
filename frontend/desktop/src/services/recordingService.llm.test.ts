// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { buildTranscribeOptions } from './recordingService'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

describe('offline ASR LLM polish options', () => {
  beforeEach(() => {
    useASRStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        backendConfirmed: true,
        serverUrl: 'http://backend.test:8000',
        llmAutoPolish: true,
        llmAutoTranslate: false,
        llmProvider: 'deepseek',
        llmModel: 'deepseek-chat',
        llmBaseUrl: 'https://llm.test/v1',
        llmApiToken: 'secret-token',
        llmPolishPrompt: '按会议纪要风格润色，不添加信息。',
      },
    })
  })

  it('includes the user preset prompt and token only in the request options', () => {
    const options = buildTranscribeOptions()

    expect(options.llm).toMatchObject({
      enable_polish: true,
      enable_translate: false,
      provider: 'deepseek',
      model: 'deepseek-chat',
      base_url: 'https://llm.test/v1',
      api_token: 'secret-token',
      prompt: '按会议纪要风格润色，不添加信息。',
    })
  })
})
