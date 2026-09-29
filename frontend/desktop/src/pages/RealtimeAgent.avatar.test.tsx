// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAvatarAudioFrame } from '@/services/liveVoiceTypes'

const mocks = vi.hoisted(() => ({ sessions: [] as any[], playback: [] as any[], observers: [] as any[],
  audio: [] as any[], avatarRef: null as any, publish: vi.fn() }))
vi.mock('@/components/Aemeath3D', () => ({ Aemeath3D: (props: any) => {
  mocks.avatarRef = props.audioFrameRef
  return <div aria-label="爱弥斯 3D 模型" />
} }))
vi.mock('@/services/api', async (original) => ({ ...await original<typeof import('@/services/api')>(),
  ASRApi: class {
    listSkills = async () => ({ skills: [] })
    synthesizeSpeech = async () => new Blob(['audio'])
    agentChatStream = async (_request: unknown, onEvent: (event: unknown) => void) => onEvent({ type: 'delta', text: '你好。' })
  },
}))
vi.mock('@/services/audio', () => ({
  speechRecorder: { prepare: vi.fn(async () => undefined), cancel: vi.fn() }, audioRelayMixer: { isActive: () => false },
  captureSpeakerAudio: vi.fn(), StreamingASRClient: class {},
}))
vi.mock('@/services/avatarAudio', async (original) => ({ ...await original<typeof import('@/services/avatarAudio')>(),
  observeAudioElement: vi.fn((audio, callback) => {
    const observer = { audio, callback, dispose: vi.fn() }
    mocks.observers.push(observer)
    return observer.dispose
  }),
}))
vi.mock('@/services/liveVoice', () => ({
  LiveVoiceSession: class {
    epoch = 0
    constructor(public base: string, public provider: string, public instructions: string, public callbacks: any) { mocks.sessions.push(this) }
    start = vi.fn(async () => this.callbacks.onState('listening'))
    stop = vi.fn(() => this.callbacks.onState('closed'))
    interrupt = vi.fn(() => {
      this.callbacks.onAvatarAudioFrame({ timestamp: Date.now(), epoch: ++this.epoch, audioTime: 0,
        level: 0, vowels: { a: 0, i: 0, u: 0, e: 0, o: 0 }, active: false })
      this.callbacks.onState('listening')
    })
  },
}))
vi.mock('@/services/realtimePlayback', () => ({
  RealtimePlayback: class {
    active = false
    constructor(public changed: () => void, public failed: (cause: unknown) => void, public device: string,
      public onFrame: (frame: LiveAvatarAudioFrame) => void) { mocks.playback.push(this) }
    play = vi.fn(async () => { this.active = true; this.changed() })
    close = vi.fn(() => { this.active = false; this.changed() })
  },
}))
import { RealtimeAgentPage } from './RealtimeAgent'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const catalog = { providers: [{ id: 'qwen', label: '千问', model: 'qwen-audio', configured: true, available: true,
  default_voice: 'Cherry', supports_brain: false, voices: [{ id: 'Cherry', name: '芊悦', gender: 'female' }] }],
  config: {}, credential_status: {}, brain_available: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let previewFetch: ReturnType<typeof deferred<Response>>
function talking(epoch = 0): LiveAvatarAudioFrame {
  return { timestamp: Date.now(), epoch, audioTime: 0.4, level: 0.7,
    vowels: { a: 0.3, i: 0.1, u: 0, e: 0.1, o: 0 }, active: true }
}
beforeEach(() => {
  window.history.replaceState(null, '', '/')
  mocks.sessions.length = mocks.playback.length = mocks.observers.length = mocks.audio.length = 0
  mocks.publish.mockReset()
  previewFetch = deferred<Response>()
  useASRStore.setState({ settings: { ...DEFAULT_SETTINGS, serverUrl: 'http://backend.test', backendConfirmed: true,
    agentBackend: 'legacy', agentRealtimeProvider: 'qwen', agentAutoSpeak: true,
    agentVoiceMode: 'server', llmModel: 'local', llmBaseUrl: 'http://local.test', llmApiToken: 'test-only',
    agentRealtimeOptions: { qwen: { voice: 'Cherry', brain: 'off' } } } })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    publishPetAudioFrame: mocks.publish, publishPetState: vi.fn(),
  } })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const path = new URL(url).pathname
    if (path.endsWith('/speech-preview.pcm')) return previewFetch.promise
    if (path.endsWith('/live-voice/catalog')) return Response.json(catalog)
    if (path.endsWith('/usage')) return Response.json({ total_tokens: 0, calls: 0, complete: true })
    return Response.json({ reset: true, cancelled: true })
  }))
  vi.stubGlobal('Audio', class {
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    play = vi.fn(async () => undefined)
    pause = vi.fn()
    constructor(public src: string) { mocks.audio.push(this) }
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${mocks.audio.length}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); delete (window as any).electronAPI; vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function startCurrentPage() {
  await waitFor(() => expect((screen.getByRole('button', { name: '开始全双工' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '开始全双工' }))
  await screen.findByRole('button', { name: '结束全双工' })
  return mocks.sessions.at(-1)
}
async function sayLegacy(text: string) {
  fireEvent.change(screen.getByLabelText('对话消息'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(mocks.audio.at(-1)?.play).toHaveBeenCalled())
}

describe('avatar output ownership in the real conversation page', () => {
  it('publishes the actual audio frame to the panel ref and pet IPC, and rejects pre-interruption epochs', async () => {
    render(<RealtimeAgentPage />)
    const session = await startCurrentPage()
    act(() => session.callbacks.onAvatarAudioFrame(talking()))
    expect(mocks.avatarRef.current).toBe(mocks.publish.mock.lastCall?.[0])
    expect(mocks.avatarRef.current).toMatchObject({ level: 0.7, vowels: talking().vowels })
    const oldEpoch = mocks.avatarRef.current.epoch
    fireEvent.click(screen.getByRole('button', { name: '停止朗读' }))
    expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({ active: false, level: 0 })
    const count = mocks.publish.mock.calls.length
    act(() => session.callbacks.onAvatarAudioFrame(talking(0)))
    expect(mocks.publish).toHaveBeenCalledTimes(count)
    act(() => session.callbacks.onAvatarAudioFrame(talking(1)))
    expect(mocks.avatarRef.current.active).toBe(true)
    expect(mocks.avatarRef.current.epoch).toBeGreaterThan(oldEpoch)
    expect(session.stop).not.toHaveBeenCalled()
  })

  it('restarting a session accepts its reset epoch but never accepts the previous session again', async () => {
    render(<RealtimeAgentPage />)
    const old = await startCurrentPage()
    act(() => old.callbacks.onAvatarAudioFrame(talking(10)))
    const oldWireEpoch = mocks.avatarRef.current.epoch
    fireEvent.click(screen.getByRole('button', { name: '结束全双工' }))
    const current = await startCurrentPage()
    act(() => current.callbacks.onAvatarAudioFrame(talking(0)))
    expect(mocks.avatarRef.current.epoch).toBeGreaterThan(oldWireEpoch)
    const count = mocks.publish.mock.calls.length
    act(() => { old.callbacks.onAvatarAudioFrame(talking(11)); old.callbacks.onState('closed') })
    expect(mocks.publish).toHaveBeenCalledTimes(count)
    expect(screen.getByRole('button', { name: '结束全双工' })).toBeTruthy()
  })

  it('closes on unmount and discards callbacks from the disposed live session', async () => {
    const view = render(<RealtimeAgentPage />)
    const session = await startCurrentPage()
    act(() => session.callbacks.onAvatarAudioFrame(talking()))
    view.unmount()
    expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({ active: false, level: 0 })
    const count = mocks.publish.mock.calls.length
    act(() => session.callbacks.onAvatarAudioFrame(talking(1)))
    expect(mocks.publish).toHaveBeenCalledTimes(count)
  })

  it('late preview fetch completion cannot clear live output started after preview cancellation', async () => {
    render(<RealtimeAgentPage />)
    fireEvent.click(screen.getByRole('button', { name: '试听口型' }))
    const preview = mocks.playback[0]
    const session = await startCurrentPage()
    act(() => session.callbacks.onAvatarAudioFrame(talking()))
    const count = mocks.publish.mock.calls.length
    await act(async () => { previewFetch.resolve(new Response(new Uint8Array(4800))); await previewFetch.promise })
    expect(preview.close).toHaveBeenCalled()
    expect(preview.play).not.toHaveBeenCalled()
    expect(mocks.publish).toHaveBeenCalledTimes(count)
    expect(mocks.avatarRef.current.active).toBe(true)
  })

  it('a preview from an unmounted page cannot close the new page output when its fetch finally settles', async () => {
    const firstPage = render(<RealtimeAgentPage />)
    fireEvent.click(screen.getByRole('button', { name: '试听口型' }))
    firstPage.unmount()
    render(<RealtimeAgentPage />)
    const session = await startCurrentPage()
    act(() => session.callbacks.onAvatarAudioFrame(talking()))
    const count = mocks.publish.mock.calls.length
    await act(async () => { previewFetch.resolve(new Response(new Uint8Array(4800))); await previewFetch.promise })
    expect(mocks.publish).toHaveBeenCalledTimes(count)
    expect(mocks.publish.mock.lastCall?.[0].active).toBe(true)
  })

  it('a queued ended event from old TTS cannot dispose the new speech observer or clear its frame', async () => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, agentRealtimeProvider: 'off' } })
    render(<RealtimeAgentPage />)
    await sayLegacy('第一句话')
    const old = mocks.audio[0]
    const oldEnded = old.onended
    fireEvent.click(screen.getByRole('button', { name: '停止朗读' }))
    await sayLegacy('第二句话')
    await waitFor(() => expect(mocks.observers).toHaveLength(2))
    const current = mocks.observers[1]
    act(() => current.callback(talking()))
    const count = mocks.publish.mock.calls.length
    act(() => oldEnded())
    expect(current.dispose).not.toHaveBeenCalled()
    expect(mocks.publish).toHaveBeenCalledTimes(count)
    expect(mocks.avatarRef.current.active).toBe(true)
    cleanup()
    expect(mocks.audio[1].pause).toHaveBeenCalled()
    const finalCount = mocks.publish.mock.calls.length
    act(() => current.callback(talking(1)))
    expect(mocks.publish).toHaveBeenCalledTimes(finalCount)
  })
})
