// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let finishStream: (() => void) | null = null
const finalResult = {
  summary: '流式总结完成', model: 'demo', source_count: 2, input_chars: 20,
  estimated_input_tokens: 10, chunk_count: 1, truncated: false,
  date: '2026-07-04', time_range: '00:00-12:00',
}
const streamArchiveSummary = vi.hoisted(() => vi.fn(async (_payload, onEvent) => {
  await onEvent({ type: 'meta', source_count: 2, input_chars: 20, estimated_input_tokens: 10, date: '2026-07-04', time_range: '00:00-12:00' })
  await onEvent({ type: 'delta', text: '流式' })
  await new Promise<void>((resolve) => { finishStream = resolve })
  await onEvent({ type: 'delta', text: '总结完成' })
  await onEvent({ type: 'done', result: finalResult })
  return finalResult
}))

vi.mock('@/services/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/api')>()
  return { ...original, ASRApi: class { streamArchiveSummary = streamArchiveSummary } }
})

import { SummaryPage } from './Summary'
import { createSummaryWorkspace, DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { useActivityStore } from '@/services/activity'

describe('summary streaming and generated log loading', () => {
  beforeEach(() => {
    finishStream = null
    streamArchiveSummary.mockClear()
    useASRStore.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      summaryWorkspace: { ...createSummaryWorkspace(new Date(2026, 6, 4, 12, 0)), date: '2026-07-04', dateFollowsToday: false },
      history: [],
    })
    useASRStore.getState().updateSettings({ llmModel: 'demo', llmBaseUrl: 'https://llm.test', llmApiToken: 'token' })
  })

  it('renders deltas before the model sends done', async () => {
    const saveSummaryLog = vi.fn(async () => ({ saved: true, path: 'D:/summary.md' }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs: vi.fn(async () => []), saveSummaryLog } })
    render(<SummaryPage />)

    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))

    expect(await screen.findByText('流式')).toBeTruthy()
    expect(screen.getByText('正在流式生成总结')).toBeTruthy()
    expect(saveSummaryLog).not.toHaveBeenCalled()
    finishStream?.()
    await waitFor(() => expect(saveSummaryLog).toHaveBeenCalled())
    expect(await screen.findByText('流式总结完成')).toBeTruthy()
  })

  it('uses the summary task model and connection without sending the ASR credential', async () => {
    useASRStore.getState().updateSettings({ modelConnections: [
      { id: 'asr', name: '识别', provider: 'qwen', baseUrl: 'https://asr.test/v1', apiToken: 'asr-fixture' },
      { id: 'summary', name: '总结', provider: 'deepseek', baseUrl: 'https://summary.test/v1', apiToken: 'summary-fixture' },
    ], taskModels: {
      asr_postprocess: { connectionId: 'asr', model: 'asr-model' },
      summary: { connectionId: 'summary', model: 'summary-model' },
    } })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs: vi.fn(async () => []) } })
    render(<SummaryPage />)
    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))
    await waitFor(() => expect(streamArchiveSummary).toHaveBeenCalled())
    expect(streamArchiveSummary.mock.calls[0][0]).toMatchObject({ model: 'summary-model', provider: 'deepseek', base_url: 'https://summary.test/v1', api_token: 'summary-fixture' })
    await screen.findByText('流式')
    finishStream?.()
    await screen.findByText('流式总结完成')
  })

  it('displays an existing generated Markdown summary immediately and switches without confirmation', async () => {
    const listSummaryLogs = vi.fn(async () => [{
      name: 'saved.md', path: 'D:/saved.md', modifiedAt: '2026-07-04T12:00:00Z', content: '# 已保存标题\n\n历史总结正文',
    }, {
      name: 'older.md', path: 'D:/older.md', modifiedAt: '2026-07-04T10:00:00Z', content: '# 更早总结',
    }])
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs } })
    render(<SummaryPage />)

    fireEvent.click(screen.getByRole('button', { name: '已保存' }))
    expect(await screen.findByRole('heading', { name: '已保存标题' })).toBeTruthy()
    expect(screen.getByText('历史总结正文')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载显示' })).toBeNull()

    fireEvent.change(screen.getByLabelText('已生成总结'), { target: { value: 'D:/older.md' } })
    expect(await screen.findByRole('heading', { name: '更早总结' })).toBeTruthy()
  })

  it('keeps the active draft when browsing saved logs and stops without replacing it with late results', async () => {
    const saveSummaryLog = vi.fn()
    const listSummaryLogs = vi.fn(async () => [{ name: 'saved.md', path: 'D:/saved.md', modifiedAt: '2026-07-04T12:00:00Z', content: '# 已保存标题' }])
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs, saveSummaryLog } })
    render(<SummaryPage />)
    expect(screen.getByText('模型与总结模板').closest('details')?.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))
    await screen.findByText('流式')
    expect(useActivityStore.getState().tasks['summary-generation']?.onStop).toBeTypeOf('function')
    const runDate = screen.getByLabelText('开始日期') as HTMLInputElement
    expect(runDate.closest('fieldset')?.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '已保存' }))
    await screen.findByRole('heading', { name: '已保存标题' })
    await waitFor(() => expect(useASRStore.getState().summaryWorkspace.result?.summary).toBe('流式'))
    expect(screen.getByText(/本次生成：本机记录/).textContent).toContain('2026-07-04')
    fireEvent.click(screen.getByRole('button', { name: '生成' }))
    expect(screen.getByText('流式')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(useASRStore.getState().summaryWorkspace.loading).toBe(false)
    expect(screen.getByText(/已停止生成，已输出的草稿保留/)).toBeTruthy()
    await act(async () => { finishStream?.() })
    expect(useASRStore.getState().summaryWorkspace.result?.summary).toBe('流式')
    expect(saveSummaryLog).not.toHaveBeenCalled()
    expect(useActivityStore.getState().tasks['summary-generation']).toBeUndefined()
  })

  it('retains partial text when leaving the page aborts an active stream', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs: vi.fn(async () => []) } })
    const page = render(<SummaryPage />)
    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))
    await screen.findByText('流式')
    page.unmount()
    expect(useASRStore.getState().summaryWorkspace.loading).toBe(false)
    expect(useASRStore.getState().summaryWorkspace.result?.summary).toBe('流式')
    await act(async () => { finishStream?.() })
  })
})
