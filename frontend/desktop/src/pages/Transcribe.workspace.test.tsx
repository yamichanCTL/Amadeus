// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const mocks = vi.hoisted(() => ({
  runFileBatch: vi.fn(async () => undefined), toggle: vi.fn(), stop: vi.fn(),
  processText: vi.fn(async () => ({ text: '整理后的文本', operation: 'polish', model: 'asr-model' })),
  models: vi.fn(async () => [{ engine: 'sensevoice', model_name: 'sensevoice', is_loaded: false, device: null, compute_type: null, languages: ['zh'], extra: { model_modes: ['offline'] } }]),
  loadModel: vi.fn(async () => ({ ok: true })), catalog: vi.fn(async () => ({ models: [], jobs: [] })),
}))
vi.mock('@/services/recordingService', () => ({
  recordingService: { taskStartedAt: null, taskEndedAt: null, prepare: vi.fn(), toggle: mocks.toggle, forceStop: mocks.stop, runFileBatch: mocks.runFileBatch },
  selectDeliveryText: (result: { full_text: string }) => result.full_text,
}))
vi.mock('@/services/liveCaption', () => ({ liveCaptionService: { isActive: false, start: vi.fn(), stop: vi.fn() } }))
vi.mock('@/services/api', async (importOriginal) => ({ ...await importOriginal<typeof import('@/services/api')>(), ASRApi: class { processText = mocks.processText; models = mocks.models; loadModel = mocks.loadModel; modelDownloadCatalog = mocks.catalog } }))
vi.mock('@/components/AudioPlayer', () => ({ AudioPlayer: () => <div>回听录音</div> }))
vi.mock('@/pages/Models', () => ({ ModelsPage: ({ asrSection }: { asrSection: string }) => asrSection === 'none' ? null : <div>识别配置分区：{asrSection}</div> }))
import { TranscribePage } from './Transcribe'

beforeEach(() => {
  vi.clearAllMocks()
  useASRStore.setState({ settings: { ...structuredClone(DEFAULT_SETTINGS), serverUrl: 'http://backend.test', backendConfirmed: true },
    recordStatus: 'idle', transcribeStatus: 'idle', liveCaptionStatus: 'idle', fileBatchRunning: false, asrModelLoading: false, models: [], currentResult: null, error: '', liveUtterances: [], history: [],
  })
  useASRStore.getState().updateSettings({})
})
afterEach(cleanup)

describe('recognition task workspaces', () => {
  it('replaces the duplicate header connection status with shortcuts and routes advanced settings', async () => {
    render(<TranscribePage />)
    expect(screen.queryByText('服务已连接')).toBeNull()
    expect(screen.queryByText('服务未连接')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
    await screen.findByRole('dialog', { name: '识别模型快捷设置' })
    fireEvent.click(screen.getByRole('button', { name: '设备与高级参数 ↗' }))
    expect(screen.getByRole('tab', { name: '识别配置' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('识别配置分区：models')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps recording and subtitle start disabled while a model load continues behind the closed popup', async () => {
    let done!: (value: { ok: boolean }) => void
    mocks.loadModel.mockReturnValueOnce(new Promise(resolve => { done = resolve }))
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('button', { name: '模型快捷设置' }))
    await waitFor(() => expect((screen.getByRole('combobox', { name: '快捷离线模型' }) as HTMLSelectElement).disabled).toBe(false))
    fireEvent.click(screen.getAllByRole('button', { name: '加载' })[0])
    fireEvent.click(screen.getByRole('button', { name: '关闭模型快捷设置' }))
    expect((screen.getByRole('button', { name: /开始录音/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: '实时字幕' }))
    expect((screen.getByRole('button', { name: '开始实时字幕' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { done({ ok: true }) })
    expect((screen.getByRole('button', { name: '开始实时字幕' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('shows one task at a time, with separate model settings', () => {
    render(<TranscribePage />)
    expect(screen.getByRole('button', { name: /开始录音/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /拖拽音频/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '开始实时字幕' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '实时字幕' }))
    expect(screen.getByRole('button', { name: '开始实时字幕' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /开始录音/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '识别配置' }))
    expect(screen.getByText('识别配置分区：models')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '识别后处理模型配置' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '02 模型下载' }))
    expect(screen.getByText('识别配置分区：downloads')).toBeTruthy()
    expect(screen.queryByText('识别配置分区：models')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '04 文本整理' }))
    expect(screen.getByRole('region', { name: '识别后处理模型配置' })).toBeTruthy()
    expect(screen.queryByText('识别配置分区：downloads')).toBeNull()
    expect(screen.queryByRole('heading', { name: '运行环境' })).toBeNull()
    expect(screen.queryByRole('button', { name: '一键安装并启动' })).toBeNull()
    expect(screen.queryByLabelText('后端地址')).toBeNull()
  })

  it('preserves prompt drafts across configuration and task navigation without changing existing connections', () => {
    const connections = structuredClone(useASRStore.getState().settings.modelConnections)
    render(<TranscribePage />)
    fireEvent.click(screen.getByText('编辑当前模板'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt 内容' }), { target: { value: '只整理这段文字，不扩展。' } })
    fireEvent.click(screen.getByRole('tab', { name: '文件转写' }))
    expect((screen.getByRole('textbox', { name: 'Prompt 内容' }) as HTMLTextAreaElement).value).toBe('只整理这段文字，不扩展。')
    fireEvent.click(screen.getByRole('tab', { name: '识别配置' }))
    fireEvent.click(screen.getByRole('tab', { name: '03 热词纠错' }))
    fireEvent.click(screen.getByRole('tab', { name: '04 文本整理' }))
    expect(screen.queryByRole('region', { name: '识别处理模板' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Prompt 内容' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择处理模板 ↗' }))
    expect(screen.getByRole('tab', { name: '语音输入' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByRole('textbox', { name: 'Prompt 内容' }) as HTMLTextAreaElement).value).toBe('只整理这段文字，不扩展。')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(useASRStore.getState().settings.llmPolishPrompt).toBe('只整理这段文字，不扩展。')
    expect(useASRStore.getState().settings.modelConnections).toEqual(connections)
  })

  it('supports keyboard navigation through configuration categories', () => {
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('tab', { name: '识别配置' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: '01 识别引擎' }), { key: 'ArrowDown' })
    expect(screen.getByRole('tab', { name: '02 模型下载' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '02 模型下载' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: '04 文本整理' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '04 文本整理' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: '01 识别引擎' }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps selected files when switching tabs and uploads only after confirmation', async () => {
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('tab', { name: '文件转写' }))
    fireEvent.drop(screen.getByRole('button', { name: /拖拽音频/ }), { dataTransfer: { files: [new File(['audio'], 'meeting.wav', { type: 'audio/wav' })] } })
    await screen.findByText('meeting.wav')
    expect(mocks.runFileBatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: '语音输入' }))
    fireEvent.click(screen.getByRole('tab', { name: /文件转写/ }))
    expect(screen.getByText('meeting.wav')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认并开始识别' }))
    await waitFor(() => expect(mocks.runFileBatch).toHaveBeenCalledWith([expect.objectContaining({ blob: expect.any(Blob), name: 'meeting.wav' })]))
  })

  it('selects shared ASR templates directly without enabling automatic model calls or changing other tasks', () => {
    useASRStore.getState().updateSettings({ llmAutoPolish: false, llmAutoTranslate: false, promptCards: [
      { id: 'clean', name: '口语整理', prompt: '只整理文字。' },
      { id: 'english', name: '翻译英文', prompt: '只输出英文译文。' },
    ], activePromptCardId: 'clean' })
    const before = structuredClone(useASRStore.getState().settings)
    render(<TranscribePage />)
    expect(screen.getByRole('heading', { name: '语音输入' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '录音识别' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择模板：翻译英文' }))
    const next = useASRStore.getState().settings
    expect(next.activePromptCardId).toBe('english')
    expect(next.llmPolishPrompt).toBe('只输出英文译文。')
    expect(next.llmAutoPolish).toBe(false)
    expect(next.llmAutoTranslate).toBe(false)
    expect(next.modelConnections).toEqual(before.modelConnections)
    expect(next.taskModels).toEqual(before.taskModels)
    expect(next.summaryPromptCards).toEqual(before.summaryPromptCards)
    fireEvent.click(screen.getByRole('tab', { name: '文件转写' }))
    expect(screen.getByRole('button', { name: '选择模板：翻译英文' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('checkbox', { name: '识别后自动使用 Prompt 处理' }))
    expect(useASRStore.getState().settings.llmAutoPolish).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '处理模型设置 ↗' }))
    expect(screen.getByRole('region', { name: '识别后处理模型配置' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: '识别后自动使用 Prompt 处理' })).toBeNull()
    expect(screen.queryByRole('button', { name: '选择模板：翻译英文' })).toBeNull()
  })

  it('prevents changing processing preferences during recording and keeps templates out of live captions', () => {
    useASRStore.setState({ recordStatus: 'recording' })
    render(<TranscribePage />)
    expect((screen.getByRole('checkbox', { name: '识别后自动使用 Prompt 处理' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getAllByRole('button', { name: /^选择模板：/ })[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: '实时字幕' }))
    expect(screen.queryByRole('region', { name: '识别处理模板' })).toBeNull()
  })

  it('lets a recording survive switching tasks and disables competing file submission', async () => {
    useASRStore.setState({ recordStatus: 'recording' })
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('tab', { name: '文件转写' }))
    fireEvent.drop(screen.getByRole('button', { name: /拖拽音频/ }), { dataTransfer: { files: [new File(['audio'], 'later.wav')] } })
    await screen.findByText('later.wav')
    expect((screen.getByRole('button', { name: '确认并开始识别' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.stop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回进行中的任务' }))
    expect(screen.getByRole('button', { name: /停止并转写/ })).toBeTruthy()
  })

  it('routes manual text processing through the ASR task model and key', async () => {
    useASRStore.getState().updateSettings({ modelConnections: [
      { id: 'asr', name: '识别服务', provider: 'qwen', baseUrl: 'https://asr.test/v1', apiToken: 'asr-fixture' },
      { id: 'brain', name: '对话服务', provider: 'deepseek', baseUrl: 'https://brain.test/v1', apiToken: 'brain-fixture' },
    ], taskModels: { asr_postprocess: { connectionId: 'asr', model: 'asr-model' }, agent: { connectionId: 'brain', model: 'brain-model' } } })
    useASRStore.setState({ currentResult: { task_id: 'fixture', status: 'done', full_text: '原始文本', segments: [], language: 'zh', engine_used: 'formalasr', confidence: null, duration_sec: 1, elapsed_sec: 1 } })
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('button', { name: '使用当前 Prompt' }))
    await waitFor(() => expect(mocks.processText).toHaveBeenCalledWith(expect.objectContaining({ model: 'asr-model', provider: 'qwen', base_url: 'https://asr.test/v1', api_token: 'asr-fixture' })))
    expect(await screen.findByText('整理后的文本')).toBeTruthy()
  })

  it('archives completed polish on the original task without overwriting a newer recognition result', async () => {
    let resolve!: (value: { text: string; operation: string; model: string }) => void
    mocks.processText.mockReturnValueOnce(new Promise(done => { resolve = done }))
    useASRStore.getState().updateSettings({ modelConnections: [{ id: 'asr', name: '识别服务', provider: 'qwen', baseUrl: 'https://asr.test/v1', apiToken: 'asr-fixture' }], taskModels: { asr_postprocess: { connectionId: 'asr', model: 'asr-model' } } })
    const oldResult = { task_id: 'old', status: 'success', full_text: '旧的原文', segments: [], language: 'zh', engine_used: 'formalasr', confidence: null, duration_sec: 1, elapsed_sec: 1 }
    useASRStore.setState({ currentResult: oldResult, history: [{ ...oldResult, id: 'old', filename: 'old.wav', created_at: new Date().toISOString() }] })
    render(<TranscribePage />)
    fireEvent.click(screen.getByRole('button', { name: '使用当前 Prompt' }))
    await waitFor(() => expect(mocks.processText).toHaveBeenCalled())
    act(() => { useASRStore.getState().setCurrentResult({ ...oldResult, task_id: 'new', full_text: '新录音的原文' }) })
    await act(async () => { resolve({ text: '旧文本整理完成', operation: 'polish', model: 'asr-model' }) })
    expect(useASRStore.getState().currentResult?.task_id).toBe('new')
    expect(screen.getByText('新录音的原文')).toBeTruthy()
    expect(useASRStore.getState().history[0].llm_outputs?.polish?.text).toBe('旧文本整理完成')
  })
})
