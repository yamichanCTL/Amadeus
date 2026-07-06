// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const streamArchiveSummary = vi.hoisted(() => vi.fn(async (_payload, onEvent) => {
  const result = {
    summary: '## 自动总结', model: 'demo', source_count: 1, input_chars: 10,
    estimated_input_tokens: 5, chunk_count: 1, truncated: false,
    date: '2026-07-04', time_range: '00:00-12:00',
  }
  await onEvent({ type: 'delta', text: '## 自动总结' })
  await onEvent({ type: 'done', result })
  return result
}))

vi.mock('@/services/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/api')>()
  return { ...original, ASRApi: class { streamArchiveSummary = streamArchiveSummary } }
})

import { SummaryPage } from './Summary'
import { createSummaryWorkspace, useASRStore } from '@/store/useASRStore'

describe('summary source and automatic log persistence', () => {
  beforeEach(() => {
    streamArchiveSummary.mockClear()
    const settings = useASRStore.getState().settings
    useASRStore.setState({
      settings: { ...settings, backendConfirmed: true, serverUrl: 'http://backend.test', llmModel: 'demo', llmBaseUrl: 'https://llm.test', llmApiToken: 'token' },
      summaryWorkspace: { ...createSummaryWorkspace(new Date(2026, 6, 4, 12, 0)), date: '2026-07-04', dateFollowsToday: false },
      history: [],
    })
  })

  it('uses local records explicitly and auto-saves every generated summary', async () => {
    const saveSummaryLog = vi.fn(async () => ({ saved: true, path: 'D:/summary-logs/summary.md' }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { saveSummaryLog, textToClipboard: vi.fn() } })
    render(<SummaryPage />)

    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))

    await waitFor(() => expect(streamArchiveSummary).toHaveBeenCalledWith(expect.objectContaining({ records: [] }), expect.any(Function), expect.any(AbortSignal)))
    await waitFor(() => expect(saveSummaryLog).toHaveBeenCalled())
    expect(await screen.findByText(/已自动保存总结日志/)).toBeTruthy()
  })

  it('keeps server archive as a separate explicit source', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { saveSummaryLog: vi.fn(async () => ({ saved: true, path: 'log.md' })) } })
    render(<SummaryPage />)
    fireEvent.change(screen.getAllByLabelText('文本来源')[0], { target: { value: 'server' } })
    fireEvent.click(screen.getByRole('button', { name: '生成总结' }))

    await waitFor(() => expect(streamArchiveSummary).toHaveBeenCalledWith(expect.objectContaining({ records: undefined }), expect.any(Function), expect.any(AbortSignal)))
  })
})
