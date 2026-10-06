// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { LEGACY_CONNECTION_ID, normalizeTaskModels, resolveTaskLLM } from './taskModels'
import { buildTranscribeOptions } from './recordingService'

beforeEach(() => useASRStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) }))

describe('task model configuration', () => {
  it('migrates existing global configuration into one shared connection and independent task selections', async () => {
    const old = { ...DEFAULT_SETTINGS, llmProvider: 'deepseek', llmBaseUrl: 'https://example.test/v1', llmApiToken: 'test-credential', llmModel: 'old-model' }
    const result = await useASRStore.persist.getOptions().migrate!({ settings: old }, 44) as { settings: typeof DEFAULT_SETTINGS }
    expect(result.settings.modelConnections).toHaveLength(1)
    for (const task of ['asr_postprocess', 'summary', 'agent'] as const) {
      expect(resolveTaskLLM(result.settings, task)).toEqual({ provider: 'deepseek', baseUrl: old.llmBaseUrl, apiToken: old.llmApiToken, model: 'old-model' })
    }
    useASRStore.setState({ settings: result.settings })
    useASRStore.getState().updateSettings({ taskModels: { ...result.settings.taskModels, summary: { connectionId: LEGACY_CONNECTION_ID, model: 'summary-model' } } })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'summary').model).toBe('summary-model')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('old-model')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'agent').model).toBe('old-model')
  })

  it('routes recognition requests to the chosen task connection even when the agent uses another key and model', () => {
    useASRStore.getState().updateSettings({ llmAutoPolish: true, modelConnections: [
      { id: 'asr', name: '识别连接', provider: 'qwen', baseUrl: 'https://asr.test/v1', apiToken: 'asr-test-key' },
      { id: 'agent', name: '对话连接', provider: 'deepseek', baseUrl: 'https://agent.test/v1', apiToken: 'agent-test-key' },
    ], taskModels: {
      asr_postprocess: { connectionId: 'asr', model: 'fast-model' }, agent: { connectionId: 'agent', model: 'reasoning-model' },
    } })
    expect(buildTranscribeOptions().llm).toMatchObject({ provider: 'qwen', model: 'fast-model', base_url: 'https://asr.test/v1', api_token: 'asr-test-key' })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'agent')).toMatchObject({ model: 'reasoning-model', apiToken: 'agent-test-key' })
    const settings = useASRStore.getState().settings
    useASRStore.getState().updateSettings({ modelConnections: settings.modelConnections.map((connection) => connection.id === 'asr' ? { ...connection, apiToken: 'updated-asr-test-key' } : connection) })
    expect(buildTranscribeOptions().llm?.api_token).toBe('updated-asr-test-key')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'agent').apiToken).toBe('agent-test-key')
  })

  it('keeps a cleared task model empty and never uses legacy credentials for an invalid connection', () => {
    const settings = { ...DEFAULT_SETTINGS, llmModel: 'old-model', llmApiToken: 'old-key', llmBaseUrl: 'https://old.test', modelConnections: [], taskModels: { summary: { connectionId: 'missing', model: '' } } }
    Object.assign(settings, normalizeTaskModels(settings, settings))
    expect(resolveTaskLLM(settings, 'summary')).toEqual({ provider: 'custom', model: '', baseUrl: '', apiToken: '' })
  })

  it('keeps explicitly cleared legacy connection fields empty despite retained migration fields', () => {
    useASRStore.getState().updateSettings({ llmModel: 'old-model', llmApiToken: 'old-key', llmBaseUrl: 'https://old.test', llmAutoPolish: true })
    const settings = useASRStore.getState().settings
    useASRStore.getState().updateSettings({
      modelConnections: settings.modelConnections.map((connection) => ({ ...connection, baseUrl: '', apiToken: '' })),
      taskModels: { ...settings.taskModels, asr_postprocess: { connectionId: LEGACY_CONNECTION_ID, model: '' } },
    })
    const cleared = useASRStore.getState().settings
    expect(cleared.llmApiToken).toBe('old-key')
    expect(resolveTaskLLM(cleared, 'asr_postprocess')).toEqual({ provider: 'custom', model: '', baseUrl: '', apiToken: '' })
    expect(buildTranscribeOptions().llm).toBeUndefined()
  })

  it('migrates old automatic defaults to CUDA but preserves explicit device choices and custom paths', async () => {
    const settings = { ...DEFAULT_SETTINGS, asrModelConfigs: {
      ...DEFAULT_SETTINGS.asrModelConfigs,
      formalasr: { modelName: 'TaurenMountain/FormalASR-1.7B', device: 'auto', computeType: 'auto', extraJson: '{}' },
      qwen3asr: { modelName: 'F:/models/my-qwen', device: 'cpu', computeType: 'float32', extraJson: '{}' },
    } }
    const migrated = await useASRStore.persist.getOptions().migrate!({ settings }, 45) as { settings: typeof DEFAULT_SETTINGS }
    expect(migrated.settings.asrModelConfigs.formalasr).toMatchObject({ device: 'cuda:0', computeType: 'auto' })
    expect(migrated.settings.asrModelConfigs.qwen3asr).toMatchObject({ modelName: 'F:/models/my-qwen', device: 'cpu', computeType: 'float32' })
    for (const device of ['cpu', 'auto']) {
      const explicit = await useASRStore.persist.getOptions().migrate!({ settings: { ...settings, asrModelConfigs: { ...settings.asrModelConfigs, formalasr: { ...settings.asrModelConfigs.formalasr, device, deviceConfigured: true } } } }, 45) as { settings: typeof DEFAULT_SETTINGS }
      expect(explicit.settings.asrModelConfigs.formalasr.device).toBe(device)
    }
  })
})
