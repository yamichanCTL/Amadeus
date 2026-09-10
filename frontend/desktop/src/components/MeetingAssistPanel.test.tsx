// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ streams: [] as any[] }))
vi.mock('@/services/audio', () => ({
  captureSpeakerAudio: vi.fn(),
  StreamingASRClient: class {
    config: any
    stop = vi.fn()
    constructor(_url: string, public emit: (event: any) => void) { mocks.streams.push(this) }
    start = vi.fn(async (config: any) => { this.config = config; this.emit({ type: 'configured' }) })
  },
}))
import { MeetingAssistPanel } from './MeetingAssistPanel'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { latestMeetingExcerpt } from '@/services/meeting'

const requests: any[] = []
let pending: ((value: Response) => void) | null = null
let hold = false
const response = (target: string) => Response.json({ target, result: { status: 'completed', text: '这是这段话的解释。', usage: { total_tokens: 42 } } })
beforeEach(() => {
  localStorage.clear()
  mocks.streams.length = 0; requests.length = 0; hold = false; pending = null
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, backendConfirmed: true, serverUrl: 'http://backend.test', agentMemory: '绝对不应发送的历史记忆', agentPrompt: '绝对不应发送的角色设定' } })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body)
    if (hold) return new Promise<Response>((resolve) => { pending = resolve })
    return response(body.target)
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })
const start = async () => {
  fireEvent.click(screen.getByRole('button', { name: '开始旁听' }))
  await screen.findByText('持续旁听中')
  return mocks.streams[0]
}

it('freezes the explanation target while ASR continues and sends no previous chat context', async () => {
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  const stream = await start()
  expect(stream.config).toMatchObject({ endpointing: 'manual', archive: false, recordAudio: false })
  expect(stream.config.agent).toBeUndefined()
  act(() => stream.emit({ type: 'partial', text: '前面讨论缓存。这里使用乐观锁。' }))
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '截取最近一句' }))
  expect((screen.getByLabelText('本次解释原文') as HTMLTextAreaElement).value).toBe('这里使用乐观锁。')
  hold = true
  fireEvent.click(screen.getByRole('button', { name: '解释这段原话' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  act(() => stream.emit({ type: 'partial', text: '前面讨论缓存。这里使用乐观锁。现在换一个话题。' }))
  expect(requests[0]).toMatchObject({ target: '这里使用乐观锁。', preceding_context: '前面讨论缓存。' })
  expect(JSON.stringify(requests[0])).not.toContain('绝对不应发送')
  expect(stream.stop).not.toHaveBeenCalled()
  await act(async () => pending!(response(requests[0].target)))
  expect(screen.getByRole('blockquote').textContent).toBe('这里使用乐观锁。')
})

it('supports precise selection and default preceding context without future speech', async () => {
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: '前文。目标术语。后文。' }))
  const transcript = screen.getByLabelText('会议实时转写') as HTMLTextAreaElement
  transcript.focus(); transcript.setSelectionRange(3, 8); fireEvent.select(transcript)
  act(() => stream.emit({ type: 'partial', text: '前文。目标术语。后文。更多新话。' }))
  fireEvent.click(screen.getByRole('button', { name: '解释选中内容' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: '目标术语。', preceding_context: '前文。' })
})

it('triggers immediately on the preceding window, excludes future speech and deduplicates revisions', async () => {
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  fireEvent.click(screen.getByLabelText('语音口令触发'))
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: '前面讨论缓存。这里使用乐观锁。解释一下，刚才这句话！未来新话题。' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: '前面讨论缓存。这里使用乐观锁。', focus: 'recent_window' })
  expect(JSON.stringify(requests[0])).not.toContain('未来新话题')
  expect(JSON.stringify(requests[0])).not.toContain('解释一下')
  expect(requests[0].following_context).toBeUndefined()
  act(() => {
    stream.emit({ type: 'partial', text: '前面讨论缓存。这里使用乐观锁。解释一下刚才这句话。更新话题' })
    stream.emit({ type: 'final', text: '前面讨论缓存。这里使用乐观锁。解释 一下：刚才这句话。更新话题' })
  })
  expect(requests).toHaveLength(1)
  expect(stream.stop).not.toHaveBeenCalled()
})

it('supports a keyboard trigger and ignores key repeat', async () => {
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: 'An earlier topic. The cache expires.' }))
  fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyE' })
  await waitFor(() => expect(requests).toHaveLength(1))
  fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyE', repeat: true })
  expect(requests).toHaveLength(1)
  expect(requests[0].target).toBe('An earlier topic. The cache expires.')
})

it('does not wait for future speech when the command is spoken before any meeting content', async () => {
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  fireEvent.click(screen.getByLabelText('语音口令触发'))
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: '解释一下，刚才这句话！' }))
  expect(requests).toHaveLength(0)
  expect(screen.getByText(/所选回看时段内还没有/)).toBeTruthy()
  act(() => stream.emit({ type: 'partial', text: '解释一下刚才这句话。这里说的法定人数是什么？' }))
  expect(requests).toHaveLength(0)
})

it('allows custom hotkeys, ignores typing, can disable shortcuts and persists preferences', async () => {
  const view = render(<MeetingAssistPanel onBusy={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /设置快捷键/ }))
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, code: 'KeyJ' })
  expect(screen.getByRole('button', { name: '设置快捷键：Ctrl + Shift + J' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('预置提示词'), { target: { value: '请面向后端工程师解释金融概念' } })
  fireEvent.change(screen.getByLabelText('关注要点'), { target: { value: '业务风险\n实现代价' } })
  fireEvent.change(screen.getByLabelText('末尾关注程度'), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText('回看时长（秒）'), { target: { value: '60' } })
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: '背景。风险重点。' }))
  fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyE' })
  fireEvent.keyDown(screen.getByLabelText('预置提示词'), { ctrlKey: true, shiftKey: true, code: 'KeyJ' })
  expect(requests).toHaveLength(0)
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, code: 'KeyJ' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ preset_prompt: '请面向后端工程师解释金融概念', focus_points: '业务风险\n实现代价', recent_weight: 5, lookback_seconds: 60 })
  fireEvent.click(screen.getByLabelText('启用解释快捷键'))
  fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, code: 'KeyJ' })
  expect(requests).toHaveLength(1)
  view.unmount()
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  expect((screen.getByLabelText('预置提示词') as HTMLTextAreaElement).value).toBe('请面向后端工程师解释金融概念')
  expect((screen.getByLabelText('回看时长（秒）') as HTMLInputElement).value).toBe('60')
  expect((screen.getByLabelText('启用解释快捷键') as HTMLInputElement).checked).toBe(false)
})

it('uses the current time window and preferences even when changed during listening', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
  render(<MeetingAssistPanel onBusy={vi.fn()} />)
  const stream = await start()
  act(() => stream.emit({ type: 'partial', text: '很早的背景。' }))
  now.mockReturnValue(71000)
  act(() => stream.emit({ type: 'partial', text: '很早的背景。近期主题。' }))
  now.mockReturnValue(101000)
  act(() => stream.emit({ type: 'partial', text: '很早的背景。近期主题。最新重点。' }))
  fireEvent.change(screen.getByLabelText('回看时长（秒）'), { target: { value: '60' } })
  fireEvent.change(screen.getByLabelText('重点关注末尾（秒）'), { target: { value: '10' } })
  fireEvent.click(screen.getByLabelText('附带会议前文帮助 Agent 理解（最多 8,000 字符）'))
  fireEvent.click(screen.getByRole('button', { name: '解释最近一段' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ target: '近期主题。最新重点。', recent_excerpt: '最新重点。', preceding_context: '', recent_seconds: 10 })
  now.mockRestore()
})

it('bounds an unpunctuated transcript without mixing its prefix into the target', () => {
  const snapshot = latestMeetingExcerpt('旧'.repeat(12000) + '新'.repeat(700))
  expect(snapshot.target).toBe('新'.repeat(600))
  expect(snapshot.preceding.length).toBe(8000)
})
