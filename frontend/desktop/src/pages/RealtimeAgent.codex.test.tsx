// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ streams: [] as any[], legacyChat: vi.fn() }))
vi.mock('@/components/AssistantFigure', () => ({ AssistantFigure: () => <img alt="Amadeus 助手" /> }))
vi.mock('@/services/api', async (original) => ({ ...await original<typeof import('@/services/api')>(),
  ASRApi: class { listSkills = async () => ({ skills: [] }); agentChatStream = mocks.legacyChat },
}))
vi.mock('@/services/audio', () => ({
  speechRecorder: { prepare: vi.fn(async () => undefined), cancel: vi.fn(), takePreparedStream: vi.fn() },
  audioRelayMixer: { isActive: () => false }, captureSpeakerAudio: vi.fn(),
  StreamingASRClient: class {
    config: any
    finish = vi.fn()
    cancelAgent = vi.fn()
    stop = vi.fn(() => this.event({ type: 'closed', intentional: true }))
    constructor(_url: string, public event: (event: any) => void) { mocks.streams.push(this) }
    start = vi.fn(async (config: any) => { this.config = config; this.event({ type: 'configured' }) })
  },
}))
import { RealtimeAgentPage } from './RealtimeAgent'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
const reply = { call_id: 'call-1', status: 'completed', text: '接口回复', model: 'test-codex', elapsed_sec: 1,
  usage: { input_tokens: 90, cached_input_tokens: 20, output_tokens: 10, total_tokens: 100 } }
const usage = { ...reply.usage, calls: 1, missing_usage: 0, complete: true }
let requests: { path: string; method: string; body: any }[]
let finishTurn: ((response: Response) => void) | undefined
let holdTurn = false
let catalogLoginFailed = false
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  catalogLoginFailed = false
  requests = []; mocks.streams.length = 0; mocks.legacyChat.mockClear(); holdTurn = false; finishTurn = undefined
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: 'http://backend.test', backendConfirmed: true,
    agentBackend: 'codex', codexModel: '', codexEffort: 'low', agentAutoSpeak: false,
    agentPrompt: '用户自己的角色设定', agentMemory: '喜欢简短回复', llmApiToken: '', llmBaseUrl: '', llmModel: '' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    requests.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path.endsWith('/models') && catalogLoginFailed) return Response.json({ detail: { code: 'codex_auth', message: 'Codex 登录不可用，请重新登录。' } }, { status: 503 })
    if (path.endsWith('/models')) return Response.json({ provider: 'local-codex', configured_model: 'test-codex', models: [
      { id: 'test-codex', efforts: ['low', 'high'], default_effort: 'low' },
      { id: 'other-codex', efforts: ['low', 'high'], default_effort: 'high' },
    ] })
    if (path.endsWith('/usage')) return Response.json(usage)
    if (path.endsWith('/turns')) {
      if (holdTurn) return await new Promise<Response>((resolve) => { finishTurn = resolve })
      return Response.json(reply)
    }
    return Response.json({ reset: true, cancelled: true })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const ready = async () => { render(<RealtimeAgentPage />); await screen.findByText('Codex 配置已读取 · local-codex') }
const send = async (text: string) => {
  fireEvent.change(screen.getByLabelText('对话消息'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(requests.filter((r) => r.path.endsWith('/turns')).length).toBeGreaterThan(0))
}
describe('Codex in the existing realtime UI', () => {
  it('shows login failure and recovers after checking the connection again', async () => {
    catalogLoginFailed = true
    render(<RealtimeAgentPage />)
    expect(await screen.findByText('Codex 登录不可用，请重新登录。')).toBeTruthy()
    expect(screen.queryByText('正在连接 Codex…')).toBeNull()
    expect(screen.queryByText('Codex 配置已读取 · local-codex')).toBeNull()
    catalogLoginFailed = false
    fireEvent.click(screen.getByRole('button', { name: '重新检查连接' }))
    expect(await screen.findByText('Codex 配置已读取 · local-codex')).toBeTruthy()
    expect(screen.queryByText('Codex 登录不可用，请重新登录。')).toBeNull()
    await send('重新登录后继续对话')
    expect(await screen.findByText(reply.text)).toBeTruthy()
  })
  it('migrates an existing installation while retaining its backend and character settings', async () => {
    const previous = { ...useASRStore.getState().settings, agentBackend: undefined, codexModel: undefined, codexEffort: undefined, agentAutoSpeak: true }
    const migrated = await useASRStore.persist.getOptions().migrate!({ settings: previous }, 39) as { settings: typeof DEFAULT_SETTINGS }
    expect(migrated.settings.agentAutoSpeak).toBe(false)
    expect(migrated.settings.agentBackend).toBe('codex')
    expect(migrated.settings.codexEffort).toBe('low')
    expect(migrated.settings.serverUrl).toBe('http://backend.test')
    expect(migrated.settings.agentPrompt).toBe('用户自己的角色设定')
  })
  it('preserves the character and uses Codex settings, persona and memory without legacy credentials', async () => {
    await ready(); expect(screen.getByAltText('Amadeus 助手')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Codex 模型'), { target: { value: 'other-codex' } })
    await send('你好'); expect(await screen.findByText(reply.text)).toBeTruthy()
    const request = requests.find((r) => r.path.endsWith('/turns'))!.body
    expect(request).toMatchObject({ text: '你好', model: 'other-codex', effort: 'high' })
    expect(request.context).toContain('用户自己的角色设定'); expect(request.context).toContain('喜欢简短回复')
    expect(request.llm_api_token).toBeUndefined(); expect(mocks.legacyChat).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Codex 用量').textContent).toContain('100 tokens')
  })
  it('keeps the session across turns, resets it, and cancels the current session on unmount', async () => {
    await ready(); await send('第一句'); await screen.findByText(reply.text)
    await send('第二句')
    await waitFor(() => expect(requests.filter((r) => r.path.endsWith('/turns'))).toHaveLength(2))
    const first = requests.find((r) => r.path.endsWith('/turns'))!.body.session_id
    expect(requests.filter((r) => r.path.endsWith('/turns'))[1].body.session_id).toBe(first)
    await waitFor(() => expect((screen.getByLabelText('对话消息') as HTMLInputElement).disabled).toBe(false))
    fireEvent.click(screen.getAllByRole('button', { name: '清空' })[0])
    await screen.findByText('上下文已清空。我们重新开始。')
    expect(requests.some((r) => r.method === 'DELETE' && r.path.endsWith(first))).toBe(true)
    await send('新对话')
    const latest = requests.filter((r) => r.path.endsWith('/turns')).at(-1)!.body.session_id
    expect(latest).not.toBe(first)
    cleanup(); expect(requests.some((r) => r.path.endsWith(`${latest}/cancel`))).toBe(true)
  })
  it('uses the existing ASR client, avoids duplicate HTTP submission and drains replies after recording stops', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: '语音' }))
    await waitFor(() => expect(mocks.streams).toHaveLength(1))
    const stream = mocks.streams[0]
    expect(stream.config.endpointing).toBe('manual')
    expect(stream.config.echoCancellation).toBe(true)
    expect(stream.config.agent).toMatchObject({ enabled: true, model: 'test-codex', effort: 'low' })
    act(() => {
      stream.event({ type: 'partial', text: '局部' }); stream.event({ type: 'final', text: '完整语音问题' })
      stream.config.onAgentEvent({ type: 'agent.queued', source_job_id: 1 })
      stream.config.onAgentEvent({ type: 'agent.started', call_id: 'call-1' })
    })
    expect(screen.getByText('完整语音问题')).toBeTruthy()
    expect(requests.some((r) => r.path.endsWith('/turns'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '结束语音' }))
    expect(stream.finish).toHaveBeenCalledOnce(); expect(stream.stop).not.toHaveBeenCalled()
    act(() => {
      stream.config.onAgentEvent({ type: 'agent.delta', call_id: 'call-1', text: '接口' })
      stream.config.onAgentEvent({ type: 'agent.completed', result: reply })
      stream.event({ type: 'closed', intentional: true })
    })
    expect(await screen.findByText(reply.text)).toBeTruthy()
    expect((screen.getByRole('button', { name: '语音' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('blocks duplicate sends and cancels the backend, ignoring a late answer', async () => {
    holdTurn = true; await ready(); await send('等待')
    fireEvent.keyDown(screen.getByLabelText('对话消息'), { key: 'Enter' })
    expect(requests.filter((r) => r.path.endsWith('/turns'))).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '取消回答' }))
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/cancel'))).toBe(true))
    await act(async () => { finishTurn?.(Response.json(reply)) })
    expect(screen.queryByText(reply.text)).toBeNull()
  })
  it('keeps microphone capture and TTS playback active together instead of using half duplex', async () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, agentAutoSpeak: true } })
    vi.stubGlobal('SpeechSynthesisUtterance', class { onstart?: () => void; onend?: () => void; constructor(public text: string) {} })
    const speak = vi.fn((utterance: { onstart?: () => void }) => utterance.onstart?.())
    const cancel = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel })
    await ready(); await send('朗读这句话')
    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    const cancellations = cancel.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '语音' }))
    await waitFor(() => expect(mocks.streams).toHaveLength(1))
    expect(mocks.streams[0].config.echoCancellation).toBe(true)
    expect(mocks.streams[0].stop).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(cancellations)
  })

  it('keeps voice input working when the device cannot confirm AEC and reports that state', async () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, agentAutoSpeak: true } })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: '语音' }))
    await waitFor(() => expect(mocks.streams).toHaveLength(1))
    const stream = mocks.streams[0]
    act(() => stream.config.onCaptureSettings({ mode: 'unavailable' }))
    expect(screen.getByText('录音已开启；当前设备未启用回声消除，自动朗读保持关闭')).toBeTruthy()
    expect(useASRStore.getState().settings.agentAutoSpeak).toBe(false)
    expect(stream.stop).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '结束语音' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not contact Codex before the existing backend confirmation step', () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, backendConfirmed: false, serverUrl: '' } })
    render(<RealtimeAgentPage />)
    expect(screen.getByText('请在设置中确认后端地址')).toBeTruthy(); expect(requests).toHaveLength(0)
  })
})


it('keeps meeting mode across remounts through the meeting URL', async () => {
  window.history.replaceState(null, '', '/#meeting')
  const view = render(<RealtimeAgentPage />)
  expect(await screen.findByRole('button', { name: '开始旁听' })).toBeTruthy()
  expect((screen.getByLabelText('实时对话模式') as HTMLSelectElement).value).toBe('meeting')
  view.unmount()
  render(<RealtimeAgentPage />)
  expect(await screen.findByRole('button', { name: '开始旁听' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('实时对话模式'), { target: { value: 'chat' } })
  expect(window.location.hash).toBe('#realtime')
  fireEvent.change(screen.getByLabelText('实时对话模式'), { target: { value: 'meeting' } })
  expect(window.location.hash).toBe('#meeting')
})
