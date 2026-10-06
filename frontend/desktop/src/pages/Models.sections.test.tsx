// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HotwordConfig, ModelInfo } from '@/services/api'

const apiMocks = vi.hoisted(() => ({
  models: vi.fn(),
  hotwords: vi.fn(),
  saveHotwords: vi.fn(),
  previewHotwords: vi.fn(),
  unloadModel: vi.fn(),
}))

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return { ...actual, ASRApi: class {
    models = apiMocks.models
    hotwords = apiMocks.hotwords
    saveHotwords = apiMocks.saveHotwords
    previewHotwords = apiMocks.previewHotwords
    unloadModel = apiMocks.unloadModel
  } }
})
vi.mock('@/components/ModelDownloads', () => ({ ModelDownloads: () => <div>模型下载测试面板</div> }))

import { ModelsPage, type AsrSettingsSection } from './Models'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const model = (engine: string, isLoaded = false): ModelInfo => ({
  engine, model_name: engine, is_loaded: isLoaded,
  device: isLoaded ? 'cpu' : null, compute_type: isLoaded ? 'float32' : null,
  languages: ['zh'], extra: { model_modes: ['offline'] },
})
const hotwords: HotwordConfig = {
  enabled: true, rule_enabled: false, threshold: .8, similar_threshold: .6,
  hotwords: '撒贝宁|撒贝你', rules: '50赫兹 = 50Hz', hotword_count: 1, rule_count: 1,
}
const workspace = (section: AsrSettingsSection) => <ModelsPage initialTab="asr" allowedTabs={['asr']} embedded asrSection={section} />

describe('scoped ASR settings workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.models.mockResolvedValue([model('sensevoice'), model('formalasr', true)])
    apiMocks.hotwords.mockResolvedValue(hotwords)
    apiMocks.saveHotwords.mockImplementation(async (config) => config)
    apiMocks.previewHotwords.mockResolvedValue({ text: '撒贝宁' })
    apiMocks.unloadModel.mockResolvedValue({})
    useASRStore.setState({ models: [], settings: {
      ...DEFAULT_SETTINGS, backendConfirmed: true, serverUrl: 'http://backend.test', offlineEngine: 'sensevoice',
    } })
  })
  afterEach(cleanup)

  it('shows one engine detail and distinguishes actual CPU runtime from the next CUDA configuration', async () => {
    render(workspace('models'))
    fireEvent.click(await screen.findByRole('button', { name: /FormalASR · 中文口语整理/ }))
    const detail = screen.getByRole('article', { name: /FormalASR · 中文口语整理 配置/ })
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.queryByText('模型下载测试面板')).toBeNull()
    expect(screen.queryByRole('textbox', { name: /热词词典/ })).toBeNull()
    expect(screen.queryByText('识别模型与运行组件')).toBeNull()
    expect(within(detail).getByText('cpu')).toBeTruthy()
    expect(within(detail).getByText('float32')).toBeTruthy()
    expect((within(detail).getByRole('combobox', { name: '加载设备' }) as HTMLSelectElement).value).toBe('cuda:0')
    expect(within(detail).getByText('模型路径与高级参数').closest('details')?.open).toBe(false)
    fireEvent.click(within(detail).getByRole('button', { name: '卸载' }))
    await waitFor(() => expect(apiMocks.unloadModel).toHaveBeenCalledWith('formalasr'))
  })

  it('keeps advanced parameters but moves task model selection to the shortcut', async () => {
    render(<ModelsPage initialTab="asr" allowedTabs={['asr']} embedded asrSection="models" taskSelectionInShortcut />)
    await screen.findByRole('article', { name: /SenseVoice 配置/ })
    expect(screen.queryByRole('combobox', { name: '离线识别模型' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: '实时流式模型' })).toBeNull()
    expect(screen.queryByRole('button', { name: '设为离线' })).toBeNull()
    expect(screen.getByRole('combobox', { name: '加载设备' })).toBeTruthy()
    expect(screen.getByText('模型路径与高级参数')).toBeTruthy()
  })

  it('renders downloads alone, hides ASR for none, and retains the chosen engine across section changes', async () => {
    const view = render(workspace('models'))
    fireEvent.click(await screen.findByRole('button', { name: /FormalASR · 中文口语整理/ }))
    fireEvent.click(screen.getByText('模型路径与高级参数'))
    fireEvent.change(screen.getByRole('textbox', { name: /模型 \/ 路径/ }), { target: { value: 'F:/models/custom-formal' } })
    view.rerender(workspace('downloads'))
    expect(screen.getByText('模型下载测试面板')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '识别引擎列表' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /热词词典/ })).toBeNull()
    view.rerender(workspace('none'))
    expect(view.container.textContent).toBe('')
    view.rerender(workspace('models'))
    expect(screen.getByRole('article', { name: /FormalASR · 中文口语整理 配置/ })).toBeTruthy()
    fireEvent.click(screen.getByText('模型路径与高级参数'))
    expect((screen.getByRole('textbox', { name: /模型 \/ 路径/ }) as HTMLInputElement).value).toBe('F:/models/custom-formal')
  })

  it('preserves unsaved hotword text while hidden and keeps save/preview operations working', async () => {
    const view = render(workspace('hotwords'))
    const dictionary = await screen.findByRole('textbox', { name: /热词词典/ })
    fireEvent.change(dictionary, { target: { value: '自定义术语|别名' } })
    expect(screen.queryByRole('region', { name: '识别引擎列表' })).toBeNull()
    expect(screen.getByText('正则替换规则').closest('details')?.open).toBe(false)
    expect(screen.getByText('高级匹配设置').closest('details')?.open).toBe(false)
    view.rerender(workspace('none'))
    view.rerender(workspace('hotwords'))
    expect((screen.getByRole('textbox', { name: /热词词典/ }) as HTMLTextAreaElement).value).toBe('自定义术语|别名')
    fireEvent.click(screen.getByRole('button', { name: '保存热词' }))
    await waitFor(() => expect(apiMocks.saveHotwords).toHaveBeenCalledWith({
      enabled: true, rule_enabled: false, threshold: .8, similar_threshold: .6,
      hotwords: '自定义术语|别名', rules: '50赫兹 = 50Hz',
    }))
    await waitFor(() => expect((screen.getByRole('button', { name: '保存热词' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByRole('textbox', { name: /效果预览/ }), { target: { value: '撒贝你' } })
    fireEvent.click(screen.getByRole('button', { name: '预览纠错结果' }))
    expect(await screen.findByText('撒贝宁')).toBeTruthy()
    expect(apiMocks.previewHotwords).toHaveBeenCalledWith('撒贝你')
  })
})
