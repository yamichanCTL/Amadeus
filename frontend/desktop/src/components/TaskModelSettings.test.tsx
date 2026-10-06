// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { resolveTaskLLM } from '@/services/taskModels'
import type { LLMModelsResult } from '@/services/api'

const apiMocks = vi.hoisted(() => ({ list: vi.fn(), urls: [] as string[] }))
vi.mock('@/services/api', async (original) => ({ ...await original<typeof import('@/services/api')>(), ASRApi: class {
  constructor(url: string) { apiMocks.urls.push(url) }
  listLLMModels = apiMocks.list
} }))
import { TaskModelSettings } from './TaskModelSettings'

function manualModel(label: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value: 'manual' } })
  fireEvent.change(screen.getByRole('textbox', { name: `${label}（手动填写）` }), { target: { value } })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const success = (models: string[]): LLMModelsResult => ({ connected: true, models, provider: 'deepseek', base_url: 'https://llm.test/v1' })

beforeEach(() => {
  vi.resetAllMocks(); apiMocks.urls.length = 0
  apiMocks.list.mockResolvedValue(success(['listed-one', 'listed-two']))
  useASRStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) })
  useASRStore.getState().updateSettings({ backendConfirmed: true, serverUrl: 'http://backend.test', llmProvider: 'deepseek', llmModel: 'existing-model', llmBaseUrl: 'https://llm.test/v1', llmApiToken: 'fixture-key' })
})
afterEach(cleanup)

describe('task model settings UI', () => {
  it('uses one connection across independent task model fields', () => {
    render(<><TaskModelSettings task="asr" /><TaskModelSettings task="summary" /></>)
    manualModel('总结模型', 'summary-model')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'summary').model).toBe('summary-model')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
    expect(useASRStore.getState().settings.modelConnections).toHaveLength(1)
    expect(screen.getAllByLabelText('连接 API Key').every((input) => input.getAttribute('type') === 'password')).toBe(true)
  })

  it('creates a fresh connection for this task without copying another task credential', () => {
    render(<TaskModelSettings task="summary" />)
    fireEvent.click(screen.getByRole('button', { name: '新建服务连接' }))
    const settings = useASRStore.getState().settings
    expect(resolveTaskLLM(settings, 'summary')).toMatchObject({ model: '', apiToken: '', baseUrl: '' })
    expect(resolveTaskLLM(settings, 'asr_postprocess')).toMatchObject({ model: 'existing-model', apiToken: 'fixture-key' })
    expect(settings.modelConnections).toHaveLength(2)
  })

  it('clears the original connection and task model without resurrecting the old API credential', () => {
    render(<TaskModelSettings task="asr" />)
    fireEvent.change(screen.getByLabelText('连接接口地址'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('连接 API Key'), { target: { value: '' } })
    manualModel('识别后处理模型', '')
    const settings = useASRStore.getState().settings
    expect(settings.llmApiToken).toBe('fixture-key')
    expect(resolveTaskLLM(settings, 'asr_postprocess')).toEqual({ provider: 'deepseek', model: '', baseUrl: '', apiToken: '' })
    expect((screen.getByLabelText('连接 API Key') as HTMLInputElement).value).toBe('')
  })

  it('exposes a clickable model list while preserving an existing model outside the catalog', async () => {
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    await screen.findByText('连接成功 · 2 个可用模型')
    const selector = screen.getByRole('combobox', { name: '识别后处理模型' }) as HTMLSelectElement
    expect(selector.tagName).toBe('SELECT')
    expect((within(selector).getByRole('option', { name: 'existing-model · 当前配置' }) as HTMLOptionElement).selected).toBe(true)
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
    fireEvent.change(selector, { target: { value: within(selector).getByRole('option', { name: 'listed-two' }).getAttribute('value') } })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('listed-two')
    expect(useASRStore.getState().settings.llmAutoPolish).toBe(false)
    expect(resolveTaskLLM(useASRStore.getState().settings, 'summary').model).toBe('existing-model')
  })

  it('keeps empty catalogs editable and never invents or auto-selects a model', async () => {
    apiMocks.list.mockResolvedValue(success([]))
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    await screen.findByText('服务未返回可选模型，可手动填写模型名称。')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
    manualModel('识别后处理模型', 'custom-model')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('custom-model')
  })

  it('invalidates a previous success before rechecking and preserves only the configured model after failure', async () => {
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    await screen.findByText('连接成功 · 2 个可用模型')
    apiMocks.list.mockRejectedValue(new Error('upstream leaked fixture-key'))
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    expect(screen.queryByText('连接成功 · 2 个可用模型')).toBeNull()
    expect(within(screen.getByRole('combobox', { name: '识别后处理模型' })).queryByRole('option', { name: 'listed-two' })).toBeNull()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('连接检查失败，请检查后端、接口地址和 API Key。')
    expect(alert.textContent).not.toContain('fixture-key')
    expect(screen.queryByText('连接成功 · 2 个可用模型')).toBeNull()
    const selector = screen.getByRole('combobox', { name: '识别后处理模型' })
    expect(within(selector).queryByRole('option', { name: 'listed-two' })).toBeNull()
    expect((within(selector).getByRole('option', { name: 'existing-model · 当前配置' }) as HTMLOptionElement).selected).toBe(true)
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
  })

  it('ignores a previous connection error and finally while a new connection request is pending', async () => {
    const old = deferred<LLMModelsResult>(), next = deferred<LLMModelsResult>()
    apiMocks.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    useASRStore.getState().updateSettings({ modelConnections: [
      ...useASRStore.getState().settings.modelConnections,
      { id: 'second', name: '第二个连接', provider: 'qwen', baseUrl: 'https://second.test', apiToken: 'second-fixture' },
    ] })
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    fireEvent.change(screen.getByRole('combobox', { name: '识别后处理服务连接' }), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    await act(async () => { old.reject(new Error('old fixture-key error')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: '正在检查…' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { next.resolve(success(['second-model'])) })
    expect(within(screen.getByRole('combobox', { name: '识别后处理模型' })).queryByRole('option', { name: 'listed-one' })).toBeNull()
    expect(within(screen.getByRole('combobox', { name: '识别后处理模型' })).getByRole('option', { name: 'second-model' })).toBeTruthy()
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess')).toMatchObject({ apiToken: 'second-fixture', model: '' })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'summary').apiToken).toBe('fixture-key')
  })

  it.each(['url', 'scope', 'key'] as const)('invalidates catalog requests after changing %s', async (changed) => {
    const old = deferred<LLMModelsResult>()
    apiMocks.list.mockReturnValueOnce(old.promise)
    const view = render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    if (changed === 'url') act(() => { useASRStore.getState().updateSettings({ serverUrl: 'http://other-backend.test', backendConfirmed: true }) })
    else if (changed === 'scope') view.rerender(<TaskModelSettings task="summary" />)
    else fireEvent.change(screen.getByLabelText('连接 API Key'), { target: { value: 'edited-fixture' } })
    await act(async () => { old.resolve(success(['stale-model'])) })
    expect(screen.queryByText('连接成功 · 1 个可用模型')).toBeNull()
    expect(screen.queryByRole('option', { name: 'stale-model' })).toBeNull()
    expect(screen.getByRole('button', { name: '检查连接 / 获取模型' })).toBeTruthy()
  })

  it('locks catalog selection, manual editing and requests when the task is disabled', () => {
    const view = render(<TaskModelSettings task="asr" />)
    fireEvent.change(screen.getByRole('combobox', { name: '识别后处理模型' }), { target: { value: 'manual' } })
    view.rerender(<TaskModelSettings task="asr" disabled />)
    const input = screen.getByRole('textbox', { name: '识别后处理模型（手动填写）' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: '识别后处理模型' }) as HTMLSelectElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'blocked-model' } })
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    expect(apiMocks.list).not.toHaveBeenCalled()
  })

  it('offers a protocol correction without changing credentials, task models or another connection', () => {
    const latest = useASRStore.getState().settings
    const selectedId = latest.taskModels.asr_postprocess!.connectionId
    useASRStore.getState().updateSettings({ modelConnections: [
      ...latest.modelConnections.map(item => item.id === selectedId ? { ...item, baseUrl: 'https://api.deepseek.com/anthropic/' } : item),
      { id: 'other', name: '其他连接', provider: 'qwen', baseUrl: 'https://other.test', apiToken: 'other-fixture' },
    ] })
    const before = structuredClone(useASRStore.getState().settings)
    render(<TaskModelSettings task="asr" />)
    expect(screen.getByText(/当前地址是 DeepSeek 的 Anthropic 协议入口/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '使用 OpenAI 兼容地址' }))
    const after = useASRStore.getState().settings
    expect(after.modelConnections.find(item => item.id === selectedId)).toEqual({ ...before.modelConnections.find(item => item.id === selectedId), baseUrl: 'https://api.deepseek.com' })
    expect(after.modelConnections.find(item => item.id === 'other')).toEqual(before.modelConnections.find(item => item.id === 'other'))
    expect(after.taskModels).toEqual(before.taskModels)
    expect(after.llmAutoPolish).toBe(before.llmAutoPolish)
    expect(screen.getByText('已使用 OpenAI 兼容地址：https://api.deepseek.com')).toBeTruthy()
    expect(apiMocks.list).not.toHaveBeenCalled()
  })

  it.each(['immediate', 'deferred'] as const)('automatically checks and saves the compatible base without losing a %s response', async speed => {
    const current = useASRStore.getState().settings
    const selectedId = current.taskModels.asr_postprocess!.connectionId
    useASRStore.getState().updateSettings({ modelConnections: current.modelConnections.map(item => item.id === selectedId ? { ...item, baseUrl: 'https://api.deepseek.com/anthropic' } : item) })
    const pending = deferred<LLMModelsResult>()
    if (speed === 'deferred') apiMocks.list.mockReturnValueOnce(pending.promise)
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    expect(apiMocks.list).toHaveBeenCalledWith({ provider: 'deepseek', base_url: 'https://api.deepseek.com', api_token: 'fixture-key' })
    if (speed === 'deferred') {
      expect(screen.getByRole('button', { name: '正在检查…' })).toBeTruthy()
      await act(async () => { pending.resolve(success(['compatible-model'])) })
    }
    await screen.findByText(speed === 'deferred' ? '连接成功 · 1 个可用模型' : '连接成功 · 2 个可用模型')
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess')).toMatchObject({ baseUrl: 'https://api.deepseek.com', apiToken: 'fixture-key', model: 'existing-model' })
    expect(screen.getByText('已使用 OpenAI 兼容地址：https://api.deepseek.com')).toBeTruthy()
  })

  it.each([[401, '鉴权失败'], [402, '余额不足'], [404, '接口未找到']] as const)('explains disconnected HTTP %s without rendering upstream text', async (code, expected) => {
    apiMocks.list.mockResolvedValue({ ...success([]), connected: false, status_code: code, message: 'upstream fixture-key was echoed' })
    render(<TaskModelSettings task="asr" />)
    fireEvent.click(screen.getByRole('button', { name: '检查连接 / 获取模型' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(`HTTP ${code}`)
    expect(alert.textContent).toContain(expected)
    expect(alert.textContent).not.toContain('fixture-key')
    expect(screen.queryByText(/upstream fixture-key/)).toBeNull()
    expect(resolveTaskLLM(useASRStore.getState().settings, 'asr_postprocess').model).toBe('existing-model')
  })
})
