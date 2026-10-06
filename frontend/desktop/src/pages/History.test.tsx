// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryPage } from './History'
import { DEFAULT_SETTINGS, useASRStore, type HistoryItem } from '@/store/useASRStore'

const exports = vi.hoisted(() => ({ copyText: vi.fn(async () => true), saveText: vi.fn(async () => true), saveResult: vi.fn(async () => true) }))
vi.mock('@/services/export', async importOriginal => ({ ...await importOriginal<typeof import('@/services/export')>(), ...exports }))

const records: HistoryItem[] = [
  { id: 'recent', task_id: 'recent-task', status: 'completed', confidence: 1, elapsed_sec: 1, filename: '项目会议', full_text: '会议原文', language: 'zh', engine_used: 'whisper', duration_sec: 60, created_at: '2026-10-05T08:00:00Z', segments: [{ start: 0, end: 3, text: '会议原文' }], llm_outputs: { polish: { operation: 'polish', text: '整理后的会议内容', model: 'demo' } } },
  { id: 'older', task_id: 'older-task', status: 'completed', confidence: 1, elapsed_sec: 1, filename: 'English note', full_text: 'An older note', language: 'en', engine_used: 'whisper', duration_sec: 30, created_at: '2026-10-04T08:00:00Z', segments: [] },
]

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  useASRStore.setState({ history: structuredClone(records), settings: structuredClone(DEFAULT_SETTINGS) })
})

describe('history workspace', () => {
  it('deletes the selected record and restores its original position with undo', () => {
    render(<HistoryPage />)
    expect(screen.queryByText('▶')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除此记录' }))
    expect(useASRStore.getState().history.map(item => item.id)).toEqual(['older'])
    fireEvent.click(screen.getByRole('button', { name: '撤销删除' }))
    expect(useASRStore.getState().history.map(item => item.id)).toEqual(['recent', 'older'])
    expect(screen.getByRole('heading', { name: '项目会议' })).toBeTruthy()
  })

  it('requires confirmation to clear all history and can undo the clear', () => {
    render(<HistoryPage />)
    fireEvent.click(screen.getByRole('button', { name: '清空全部记录' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(useASRStore.getState().history).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(useASRStore.getState().history).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '清空全部记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }))
    expect(useASRStore.getState().history).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '撤销删除' }))
    expect(useASRStore.getState().history).toHaveLength(2)
  })

  it('copies and exports the currently displayed text with one toolbar and retains filters', async () => {
    render(<HistoryPage />)
    expect(screen.getAllByRole('button', { name: '复制当前' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '润色/翻译' }))
    fireEvent.click(screen.getByRole('button', { name: '复制当前' }))
    await waitFor(() => expect(exports.copyText).toHaveBeenCalledWith('整理后的会议内容'))
    fireEvent.click(screen.getByText('导出', { selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: '当前润色/翻译' }))
    expect(exports.saveText).toHaveBeenCalledWith('整理后的会议内容', 'recent-task_enhanced.txt')
    fireEvent.change(screen.getByLabelText('筛选语言'), { target: { value: 'en' } })
    expect(screen.getByRole('heading', { name: 'English note' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('搜索历史记录'), { target: { value: '不存在' } })
    expect(screen.getByText('当前条件下暂无历史记录。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }))
    expect(screen.getByRole('heading', { name: 'English note' })).toBeTruthy()
  })
})
