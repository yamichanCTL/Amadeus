// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ sessions: [] as any[] }))
vi.mock('@/components/Aemeath3D', () => ({ Aemeath3D: () => <div aria-label="爱弥斯 3D 模型" /> }))
vi.mock('@/services/api', async (original) => ({ ...await original<typeof import('@/services/api')>(),
  ASRApi: class { listSkills = async () => ({ skills: [] }) },
}))
vi.mock('@/services/audio', () => ({
  speechRecorder: { prepare: vi.fn(async () => undefined), cancel: vi.fn() }, audioRelayMixer: { isActive: () => false },
  captureSpeakerAudio: vi.fn(), StreamingASRClient: class {},
}))
vi.mock('@/services/liveVoice', () => ({
  LiveVoiceSession: class {
    constructor(public base: string, public provider: string, public instructions: string, public callbacks: any, public options: any) { mocks.sessions.push(this) }
    start = vi.fn(async () => { this.callbacks.onState('connecting'); this.callbacks.onState('listening') })
    stop = vi.fn(() => this.callbacks.onState('closed'))
    interrupt = vi.fn(() => this.callbacks.onState('listening'))
    sendText = vi.fn((text: string) => this.callbacks.onTranscriptItem({ role: 'user', text, id: 'typed-1', final: true }))
  },
}))
import { RealtimeAgentPage } from './RealtimeAgent'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { speechRecorder } from '@/services/audio'
import { useActivityStore } from '@/services/activity'

const catalog = {
  providers: [
    { id: 'qwen', label: '千问 Audio 3.1', model: 'qwen-audio-3.1-realtime-plus', configured: true, available: true,
      default_voice: 'Cherry', supports_brain: true, voices: [{ id: 'Cherry', name: '芊悦', gender: 'female' }, { id: 'Ethan', name: '晨煦', gender: 'male' }] },
    { id: 'gemini_live', label: 'Gemini 3.8 Live', model: 'gemini-3.8-live', configured: true, available: true,
      default_voice: 'Aoede', supports_brain: false, voices: [{ id: 'Aoede', name: 'Aoede', gender: 'female' }] },
    { id: 'grok', label: 'Grok', model: 'grok-voice-think-fast-2.0', configured: false, available: false,
      unavailable_reason: '无免费额度，付费测试未启用', default_voice: 'eve', voices: [], supports_brain: false },
  ], config: { dashscope_workspace_id: '', dashscope_region: 'cn-beijing' }, credential_status: {}, brain_available: true,
}
let requests: string[]
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  requests = []; mocks.sessions.length = 0
  vi.mocked(speechRecorder.cancel).mockClear()
  vi.mocked(speechRecorder.prepare).mockClear()
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: 'http://backend.test', backendConfirmed: true,
    agentBackend: 'codex', agentRealtimeProvider: 'qwen', agentPrompt: '用户角色设定', agentMemory: '用户偏好简短回复',
    audioInputDeviceId: 'mic-a', audioOutputDeviceId: 'speaker-a',
    agentRealtimeOptions: { qwen: { voice: 'Ethan', brain: 'qwen3.7-plus' } } } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname; requests.push(path)
    if (path.endsWith('/live-voice/catalog')) return Response.json(catalog)
    if (path.endsWith('/usage')) return Response.json({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0, missing_usage: 0, complete: true })
    if (path.endsWith('/models')) return Response.json({ detail: { code: 'codex_auth', message: 'Codex 尚未登录' } }, { status: 503 })
    return Response.json({ reset: true, cancelled: true })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const start = async () => {
  render(<RealtimeAgentPage />)
  await waitFor(() => expect((screen.getByRole('button', { name: '开始全双工' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '开始全双工' }))
  await screen.findByRole('button', { name: '结束全双工' })
  return mocks.sessions[0]
}

describe('Realtime API models in the existing 3D application', () => {
  it('globally stops live voice once and rejects callbacks from the cancelled session', async () => {
    const session = await start()
    const stop = useActivityStore.getState().tasks['realtime-session'].onStop!
    await act(async () => { await Promise.all([stop(), stop()]) })
    act(() => {
      session.callbacks.onState('speaking')
      session.callbacks.onTranscriptItem({ role: 'assistant', text: '已取消会话的迟到内容', id: 'late' })
      session.callbacks.onCapture({ level: -18, seconds: 5 })
    })
    expect(session.stop).toHaveBeenCalledOnce()
    expect(mocks.sessions).toHaveLength(1)
    expect(screen.queryByText('已取消会话的迟到内容')).toBeNull()
    expect(screen.getByRole('status', { name: '麦克风状态' }).textContent).toBe('未开启')
    expect(useActivityStore.getState().tasks['realtime-session']).toBeUndefined()
  })

  it('keeps configuration out of the conversation and preserves persona edits across drawer navigation', async () => {
    render(<RealtimeAgentPage />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '角色设定' })).toBeNull()
    const shortcut = screen.getByRole('button', { name: '配置模型与音色' })
    shortcut.focus()
    fireEvent.click(shortcut)
    expect(screen.getByRole('dialog', { name: '对话配置' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '角色与记忆' }))
    fireEvent.change(screen.getByRole('textbox', { name: '角色设定' }), { target: { value: '编辑中的角色设定' } })
    fireEvent.click(screen.getByRole('tab', { name: '工具与任务' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭对话配置' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(shortcut)
    fireEvent.click(shortcut)
    fireEvent.keyDown(screen.getByRole('tab', { name: '引擎与音色' }), { key: 'ArrowRight' })
    expect((screen.getByRole('textbox', { name: '角色设定' }) as HTMLTextAreaElement).value).toBe('编辑中的角色设定')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.sessions).toHaveLength(0)
  })

  it('shows capture, audio playback and background work independently during full duplex', async () => {
    const session = await start()
    act(() => {
      session.callbacks.onCapture({ level: -24, seconds: 2 })
      session.callbacks.onState('working')
      session.callbacks.onAvatarAudioFrame({ timestamp: Date.now(), epoch: 1, audioTime: .1, level: .6, vowels: { a: .2, i: 0, u: 0, e: 0, o: 0 }, active: true })
    })
    expect(screen.getByRole('status', { name: '麦克风状态' }).textContent).toBe('正在采集')
    expect(screen.getByRole('status', { name: '语音输出状态' }).textContent).toBe('正在播放')
    expect(screen.getByRole('status', { name: '后台任务状态' }).textContent).toBe('正在处理')
    fireEvent.click(screen.getByRole('button', { name: '收起角色' }))
    expect(screen.queryByLabelText('爱弥斯 3D 模型')).toBeNull()
    expect(screen.getByRole('button', { name: '结束全双工' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止朗读' })).toBeTruthy()
    expect(session.stop).not.toHaveBeenCalled()
  })

  it('starts independently of Codex login, with selected voice, brain, persona and memory', async () => {
    const session = await start()
    expect(screen.getByLabelText('爱弥斯 3D 模型')).toBeTruthy()
    expect(session.provider).toBe('qwen')
    expect(session.options).toMatchObject({ voice: 'Ethan', brain: 'qwen3.7-plus', outputDeviceId: 'speaker-a' })
    expect(session.start).toHaveBeenCalledWith('mic-a')
    expect(session.instructions).toContain('用户角色设定')
    expect(session.instructions).toContain('用户偏好简短回复')
    expect(requests.some((path) => path.endsWith('/turns/stream'))).toBe(false)
    expect(screen.queryByLabelText('Codex 模型')).toBeNull()
    expect(screen.queryByText('TTS 模型')).toBeNull()
    expect(screen.getByText('实时语音设定')).toBeTruthy()
  })

  it('replaces cumulative captions by stable ID and displays microphone progress', async () => {
    const session = await start()
    act(() => {
      session.callbacks.onTranscriptItem({ role: 'user', id: 'u1', text: '我在北', final: false })
      session.callbacks.onTranscriptItem({ role: 'user', id: 'u1', text: '我在北京', final: true })
      session.callbacks.onTranscriptItem({ role: 'assistant', id: 'a1', text: '好' })
      session.callbacks.onTranscriptItem({ role: 'assistant', id: 'a1', text: '好的，已记住。', final: true })
      session.callbacks.onCapture({ level: -24, seconds: 3.2, serverSeconds: 3 })
    })
    expect(document.querySelectorAll('.agent-message.user')).toHaveLength(1)
    expect(screen.queryByText('我在北')).toBeNull()
    expect(screen.getByText('我在北京')).toBeTruthy()
    expect(screen.getByText('好的，已记住。')).toBeTruthy()
    expect(screen.getByLabelText('实时麦克风采集').textContent).toContain('后端收到 3.0 秒')
  })

  it('sends text and interrupts playback while leaving the microphone session open', async () => {
    const session = await start()
    act(() => session.callbacks.onState('speaking'))
    fireEvent.change(screen.getByLabelText('对话消息'), { target: { value: '请换个话题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(session.sendText).toHaveBeenCalledWith('请换个话题')
    expect(document.querySelectorAll('.agent-message.user')).toHaveLength(1)
    expect((screen.getByLabelText('对话消息') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '停止朗读' }))
    expect(session.interrupt).toHaveBeenCalledOnce()
    expect(session.stop).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '结束全双工' })).toBeTruthy()
    expect(requests.some((path) => path.endsWith('/turns/stream'))).toBe(false)
  })

  it('clears sessions and ignores late callbacks without requiring Codex reset', async () => {
    const session = await start()
    fireEvent.click(screen.getAllByRole('button', { name: '清空' })[0])
    await screen.findByText('上下文已清空。我们重新开始。')
    expect(session.stop).toHaveBeenCalledOnce()
    act(() => {
      session.callbacks.onTranscriptItem({ role: 'assistant', text: '迟到回复', id: 'late' })
      session.callbacks.onState('speaking')
    })
    expect(screen.queryByText('迟到回复')).toBeNull()
    expect(screen.getByRole('button', { name: '开始全双工' })).toBeTruthy()
    expect(requests.some((path) => /\/sessions\//.test(path))).toBe(false)
  })

  it('shows unavailable Grok without creating a session or allowing paid enablement', async () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, agentRealtimeProvider: 'grok' } })
    render(<RealtimeAgentPage />)
    await waitFor(() => expect(screen.getByLabelText('实时模型状态').textContent).toContain('付费测试未启用'))
    expect((screen.getByRole('button', { name: '开始全双工' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.sessions).toHaveLength(0)
  })

  it('cancels legacy microphone preparation before live capture and never reopens it on unmount', async () => {
    const session = await start()
    expect(speechRecorder.cancel).toHaveBeenCalled()
    const cancelled = vi.mocked(speechRecorder.cancel).mock.invocationCallOrder.at(-1)!
    expect(cancelled).toBeLessThan(session.start.mock.invocationCallOrder[0])
    cleanup()
    expect(session.stop).toHaveBeenCalledOnce()
    expect(speechRecorder.prepare).not.toHaveBeenCalled()
  })

  it('closes the previous live microphone when backend address changes', async () => {
    const session = await start()
    act(() => useASRStore.getState().updateSettings({ serverUrl: 'http://new-backend.test' }))
    await waitFor(() => expect(session.stop).toHaveBeenCalledOnce())
    act(() => session.callbacks.onTranscriptItem({ role: 'assistant', text: '旧后端迟到回复', id: 'old-backend' }))
    expect(screen.queryByText('旧后端迟到回复')).toBeNull()
    expect(screen.getByRole('button', { name: '开始全双工' })).toBeTruthy()
  })
})
