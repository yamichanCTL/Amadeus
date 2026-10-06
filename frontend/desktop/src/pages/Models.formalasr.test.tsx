// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@/services/api'

const apiMocks = vi.hoisted(() => ({
  models: vi.fn(),
  loadModel: vi.fn(),
  hotwords: vi.fn(async () => null),
}))

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return { ...actual, ASRApi: class {
    models = apiMocks.models
    loadModel = apiMocks.loadModel
    hotwords = apiMocks.hotwords
  } }
})

import { ModelsPage } from './Models'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const model = (engine: string, streaming = false): ModelInfo => ({
  engine, model_name: engine === 'formalasr' ? 'TaurenMountain/FormalASR-1.7B' : engine,
  is_loaded: false, device: null, compute_type: null, languages: ['zh'],
  extra: { model_modes: [streaming ? 'streaming' : 'offline'], supports_streaming: streaming },
})

describe('FormalASR configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.models.mockResolvedValue([model('sensevoice'), model('formalasr'), model('x-asr', true)])
    apiMocks.loadModel.mockResolvedValue({})
    useASRStore.setState({ models: [], settings: {
      ...DEFAULT_SETTINGS, serverUrl: 'http://backend.test', backendConfirmed: true,
      llmAutoPolish: true, llmAutoTranslate: false,
    } })
  })

  afterEach(cleanup)

  it('offers FormalASR for offline use, loads its own weights, and only disables extra LLM processing on request', async () => {
    render(<ModelsPage />)
    const offline = await screen.findByRole('combobox', { name: /离线识别模型/ })
    await waitFor(() => expect(within(offline).getByRole('option', { name: /FormalASR/ })).toBeTruthy())
    const streaming = screen.getByRole('combobox', { name: /实时流式模型/ })
    expect(within(streaming).queryByRole('option', { name: /FormalASR/ })).toBeNull()

    fireEvent.change(offline, { target: { value: 'formalasr' } })
    expect(useASRStore.getState().settings.offlineEngine).toBe('formalasr')
    expect(useASRStore.getState().settings.streamingEngine).toBe('x-asr')
    expect(useASRStore.getState().settings.llmAutoPolish).toBe(true)
    expect(screen.getByRole('note', { name: 'FormalASR 输出说明' }).textContent).toContain('追加 LLM 处理已开启')

    fireEvent.click(screen.getByRole('button', { name: /FormalASR · 中文口语整理/ }))
    const row = screen.getByRole('article', { name: /FormalASR · 中文口语整理 配置/ })
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    await waitFor(() => expect(apiMocks.loadModel).toHaveBeenCalledWith('formalasr', {
      model_name: 'TaurenMountain/FormalASR-1.7B', device: 'cuda:0', extra: {},
    }))

    fireEvent.click(screen.getByRole('button', { name: '关闭追加 LLM 处理' }))
    expect(useASRStore.getState().settings.llmAutoPolish).toBe(false)
    expect(useASRStore.getState().settings.llmAutoTranslate).toBe(false)
    expect(screen.getByRole('note', { name: 'FormalASR 输出说明' }).textContent).toContain('追加 LLM 处理已关闭')
  })

  it('migrates saved settings without changing selected engines or custom model paths', async () => {
    const oldSettings = {
      ...DEFAULT_SETTINGS,
      offlineEngine: 'whisper', streamingEngine: 'x-asr', llmAutoPolish: true,
      asrModelConfigs: { qwen3asr: { modelName: 'F:/models/custom-qwen', device: 'cpu', computeType: 'float32', extraJson: '{"max_new_tokens":256}' } },
    }
    const migrated = await useASRStore.persist.getOptions().migrate!({ settings: oldSettings }, 43) as { settings: typeof DEFAULT_SETTINGS }
    expect(migrated.settings.asrModelConfigs.formalasr).toEqual(DEFAULT_SETTINGS.asrModelConfigs.formalasr)
    expect(migrated.settings.asrModelConfigs.qwen3asr).toEqual(oldSettings.asrModelConfigs.qwen3asr)
    expect(migrated.settings.offlineEngine).toBe('whisper')
    expect(migrated.settings.streamingEngine).toBe('x-asr')
    expect(migrated.settings.llmAutoPolish).toBe(true)
  })

  it.each(['cpu', 'auto'])('sends an explicitly selected %s device instead of using the backend CUDA default', async (device) => {
    render(<ModelsPage asrSection="models" />)
    const expand = await screen.findByRole('button', { name: /FormalASR · 中文口语整理/ })
    fireEvent.click(expand)
    const row = screen.getByRole('article', { name: /FormalASR · 中文口语整理 配置/ })
    fireEvent.change(within(row).getByRole('combobox', { name: '加载设备' }), { target: { value: device } })
    fireEvent.click(within(row).getByRole('button', { name: '加载' }))
    await waitFor(() => expect(apiMocks.loadModel).toHaveBeenCalledWith('formalasr', {
      model_name: 'TaurenMountain/FormalASR-1.7B', device, extra: {},
    }))
    expect(useASRStore.getState().settings.asrModelConfigs.formalasr.deviceConfigured).toBe(true)
  })

  it('retains custom model, precision, and JSON edits while inspecting another engine', async () => {
    render(<ModelsPage asrSection="models" />)
    fireEvent.click(await screen.findByRole('button', { name: /FormalASR · 中文口语整理/ }))
    fireEvent.click(screen.getByText('模型路径与高级参数'))
    fireEvent.change(screen.getByRole('textbox', { name: /模型 \/ 路径/ }), { target: { value: 'F:/models/formal-custom' } })
    fireEvent.change(screen.getByRole('textbox', { name: '计算精度 / dtype' }), { target: { value: 'float32' } })
    fireEvent.change(screen.getByRole('textbox', { name: '参数 JSON' }), { target: { value: '{"max_new_tokens":256}' } })
    fireEvent.click(screen.getByRole('button', { name: /SenseVoice/ }))
    fireEvent.click(screen.getByRole('button', { name: /FormalASR · 中文口语整理/ }))
    fireEvent.click(screen.getByRole('button', { name: '加载' }))
    await waitFor(() => expect(apiMocks.loadModel).toHaveBeenCalledWith('formalasr', {
      model_name: 'F:/models/formal-custom', device: 'cuda:0', compute_type: 'float32', extra: { max_new_tokens: 256 },
    }))
  })
})
