// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { createSummaryWorkspace, useASRStore } from '@/store/useASRStore'

describe('summary streaming and generated log loading', () => {
  beforeEach(() => {
    finishStream = null
    streamArchiveSummary.mockClear()
    const settings = useASRStore.getState().settings
    useASRStore.setState({
      settings: { ...settings, llmModel: 'demo', llmBaseUrl: 'https://llm.test', llmApiToken: 'token' },
      summaryWorkspace: { ...createSummaryWorkspace(new Date(2026, 6, 4, 12, 0)), date: '2026-07-04', dateFollowsToday: false },
      history: [],
    })
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

  it('displays an existing generated Markdown summary immediately and switches without confirmation', async () => {
    const listSummaryLogs = vi.fn(async () => [{
      name: 'saved.md', path: 'D:/saved.md', modifiedAt: '2026-07-04T12:00:00Z', content: '# 已保存标题\n\n历史总结正文',
    }, {
      name: 'older.md', path: 'D:/older.md', modifiedAt: '2026-07-04T10:00:00Z', content: '# 更早总结',
    }])
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { listSummaryLogs } })
    render(<SummaryPage />)

    expect(await screen.findByRole('heading', { name: '已保存标题' })).toBeTruthy()
    expect(screen.getByText('历史总结正文')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载显示' })).toBeNull()

    fireEvent.change(screen.getByLabelText('已生成总结'), { target: { value: 'D:/older.md' } })
    expect(await screen.findByRole('heading', { name: '更早总结' })).toBeTruthy()
  })
})
