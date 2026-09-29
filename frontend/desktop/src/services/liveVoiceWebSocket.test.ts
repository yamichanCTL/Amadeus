// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketVoiceSession } from './liveVoiceWebSocket'
import { RealtimePlayback } from './realtimePlayback'
import type { LiveVoiceCallbacks } from './liveVoiceTypes'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static moduleWait: Promise<void> | null = null
  state = 'running'
  sampleRate = 48000
  currentTime = 0
  destination = {}
  sources: FakeSource[] = []
  resume = vi.fn(async () => { this.state = 'running' })
  close = vi.fn(async () => { this.state = 'closed' })
  audioWorklet = { addModule: vi.fn(async () => { await FakeAudioContext.moduleWait }) }
  constructor() { FakeAudioContext.instances.push(this) }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() } }
  createBuffer(_channels: number, frames: number, rate: number) {
    return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source }
}
class FakeWorklet {
  static instances: FakeWorklet[] = []
  port = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
  onprocessorerror: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() { FakeWorklet.instances.push(this) }
  packet(rms = 0.1, peak = 0.3) {
    this.port.onmessage?.({ data: { type: 'packet', pcm: new Int16Array(1600).buffer, rms, peak } })
  }
}
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => { this.readyState = 3 })
  constructor(public url: URL) { FakeSocket.instances.push(this) }
  send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>) }
  open() { this.readyState = 1; this.onopen?.() }
  event(value: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

const pcm = btoa('\x01\x00\x02\x00')
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }
let stream: MediaStream
let getUserMedia: ReturnType<typeof vi.fn>
let callbacks: LiveVoiceCallbacks
const sessions: WebSocketVoiceSession[] = []

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeAudioContext.moduleWait = null
  FakeWorklet.instances = []
  FakeSocket.instances = []
  track = { stop: vi.fn(), onended: null }
  stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  getUserMedia = vi.fn(async () => stream)
  callbacks = { onState: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(), onDelegate: vi.fn(async () => ''),
    onTranscriptItem: vi.fn(), onCapture: vi.fn(), onTool: vi.fn(), onAvatarAudioFrame: vi.fn() }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorklet)
  vi.stubGlobal('WebSocket', FakeSocket)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
})
afterEach(() => { sessions.splice(0).forEach((session) => session.stop()); vi.unstubAllGlobals() })

function make(provider: 'qwen' | 'gemini_live' | 'higgs' = 'qwen') {
  const session = new WebSocketVoiceSession('http://127.0.0.1:8000', provider, '请遵循用户要求', callbacks,
    { voice: 'Cherry', brain: 'off' })
  sessions.push(session)
  return session
}
async function connect(provider: 'qwen' | 'gemini_live' | 'higgs' = 'qwen') {
  const session = make(provider)
  const started = session.start('microphone-2')
  const socket = FakeSocket.instances[0]
  socket.open()
  socket.event({ type: 'ready' })
  await started
  return { session, socket, worklet: FakeWorklet.instances[0], playback: FakeAudioContext.instances[0] }
}

describe('realtime voice lifecycle', () => {
  it('connects directly to the application backend, waits for provider readiness, and captures continuously', async () => {
    const session = make()
    const started = session.start('microphone-2')
    expect(getUserMedia).not.toHaveBeenCalled()
    const socket = FakeSocket.instances[0]
    expect(socket.url.href).toBe('ws://127.0.0.1:8000/v1/live-voice/ws')
    socket.open()
    expect(socket.sent[0]).toMatchObject({ type: 'start', model: 'qwen', voice: 'Cherry', brain: 'off' })
    expect(getUserMedia).not.toHaveBeenCalled()
    socket.event({ type: 'ready' })
    await started
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { ideal: 'microphone-2' }, channelCount: 1,
      echoCancellation: true, noiseSuppression: false, autoGainControl: true } })
    const worklet = FakeWorklet.instances[0]
    socket.event({ type: 'thinking_status', status: 'IN_PROGRESS' })
    worklet.packet()
    socket.event({ type: 'audio', data: pcm, response_id: 'answer-1' })
    worklet.packet()
    expect(socket.sent.filter((item) => item.type === 'audio')).toHaveLength(2)
    expect(track.stop).not.toHaveBeenCalled()
    expect(callbacks.onCapture).toHaveBeenLastCalledWith({ level: -20, seconds: 0.2, serverSeconds: 0 })
  })

  it('does not acquire a microphone if backend policy rejects the session', async () => {
    const session = make()
    const started = session.start()
    const socket = FakeSocket.instances[0]
    socket.open()
    socket.event({ type: 'error', message: '当前没有免费额度' })
    await expect(started).rejects.toThrow('当前没有免费额度')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalled()
  })

  it('releases late microphone permission results after the user disconnected', async () => {
    const permission = deferred<MediaStream>()
    getUserMedia.mockReturnValue(permission.promise)
    const session = make()
    const started = session.start()
    const socket = FakeSocket.instances[0]
    socket.open()
    socket.event({ type: 'ready' })
    await Promise.resolve()
    expect(getUserMedia).toHaveBeenCalledOnce()
    session.stop()
    permission.resolve(stream)
    await started
    expect(track.stop).toHaveBeenCalledOnce()
    expect(FakeWorklet.instances).toHaveLength(0)
    expect(callbacks.onState).toHaveBeenLastCalledWith('closed')
  })

  it('does not reconnect capture when a pending worklet load finishes after stop', async () => {
    const module = deferred<void>()
    FakeAudioContext.moduleWait = module.promise
    const session = make()
    const started = session.start()
    const socket = FakeSocket.instances[0]
    socket.open()
    socket.event({ type: 'ready' })
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeAudioContext.instances).toHaveLength(2)
    session.stop()
    module.resolve()
    await started
    expect(FakeWorklet.instances).toHaveLength(0)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(FakeAudioContext.instances[1].close).toHaveBeenCalledOnce()
  })

  it('keeps stable cumulative transcript rows when final ASR arrives after assistant text', async () => {
    const { socket } = await connect('higgs')
    socket.event({ type: 'input_transcript', text: '上海', item_id: 'user-1' })
    socket.event({ type: 'response_started', response_id: 'answer-1' })
    socket.event({ type: 'output_transcript', text: '明天', response_id: 'answer-1' })
    socket.event({ type: 'input_transcript', text: '上海明天天气', item_id: 'user-1', final: true })
    socket.event({ type: 'output_transcript', text: '请查天气预报', response_id: 'answer-1' })
    const rows = vi.mocked(callbacks.onTranscriptItem!).mock.calls.map(([item]) => item)
    expect(rows[0].id).toBe(rows[2].id)
    expect(rows[1].id).toBe(rows[3].id)
    expect(rows[2].text).toBe('上海明天天气')
    expect(rows[3].text).toBe('明天请查天气预报')
    expect(callbacks.onTranscript).not.toHaveBeenCalled()
  })

  it('stops queued audio on native speech even after generation is complete and rejects late cancelled chunks', async () => {
    const { socket, playback, worklet } = await connect()
    socket.event({ type: 'response_started', response_id: 'old' })
    socket.event({ type: 'audio', data: pcm, response_id: 'old' })
    socket.event({ type: 'turn_complete', response_id: 'old' })
    expect(callbacks.onState).toHaveBeenLastCalledWith('speaking')
    socket.event({ type: 'speech_started', item_id: 'user-2', response_id: 'old' })
    expect(playback.sources[0].stop).toHaveBeenCalledOnce()
    expect(callbacks.onAvatarAudioFrame).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0, active: false }))
    socket.event({ type: 'audio', data: pcm, response_id: 'old' })
    socket.event({ type: 'output_transcript', text: '过时输出', response_id: 'old' })
    expect(playback.sources).toHaveLength(1)
    expect(callbacks.onTranscriptItem).not.toHaveBeenCalled()
    worklet.packet()
    expect(track.stop).not.toHaveBeenCalled()
    expect(socket.sent.filter((item) => item.type === 'interrupt')).toHaveLength(0)
    socket.event({ type: 'response_started', response_id: 'new' })
    socket.event({ type: 'audio', data: pcm, response_id: 'new' })
    expect(playback.sources).toHaveLength(2)
  })

  it('does not interrupt on amplitude pulses; Gemini silence assistance only finalizes input', async () => {
    const { socket, worklet, playback } = await connect('gemini_live')
    socket.event({ type: 'audio', data: pcm })
    worklet.packet(0.5, 0.9)
    worklet.packet(0.5, 0.9)
    for (let i = 0; i < 10; i += 1) worklet.packet(0, 0)
    expect(socket.sent.filter((item) => item.type === 'audio_end')).toHaveLength(1)
    expect(socket.sent.filter((item) => item.padding === true)).toHaveLength(10)
    expect(socket.sent.filter((item) => item.type === 'interrupt')).toHaveLength(0)
    expect(playback.sources[0].stop).not.toHaveBeenCalled()
    expect(callbacks.onCapture).toHaveBeenLastCalledWith({ level: -100, seconds: 1.2, serverSeconds: 0 })
  })

  it('sends explicit manual cancellation while preserving the microphone and current session', async () => {
    const { session, socket, worklet, playback } = await connect()
    socket.event({ type: 'response_started', response_id: 'answer' })
    socket.event({ type: 'audio', data: pcm, response_id: 'answer' })
    session.interrupt()
    expect(socket.sent.at(-1)).toEqual({ type: 'interrupt', response_id: 'answer' })
    expect(playback.sources[0].stop).toHaveBeenCalledOnce()
    worklet.packet()
    expect(socket.sent.at(-1)?.type).toBe('audio')
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('reports upload backpressure instead of silently losing microphone frames', async () => {
    const { socket, worklet } = await connect()
    socket.bufferedAmount = 2_000_001
    worklet.packet()
    expect(callbacks.onError).toHaveBeenCalledWith('语音上传积压，请检查网络后重新连接')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it('resumes suspended capture on returning to the app, and removes that handler after stop', async () => {
    const { session } = await connect()
    const capture = FakeAudioContext.instances[1]
    const before = capture.resume.mock.calls.length
    capture.state = 'suspended'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(capture.resume).toHaveBeenCalledTimes(before + 1)
    session.stop()
    capture.state = 'suspended'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(capture.resume).toHaveBeenCalledTimes(before + 1)
  })

  it('keeps anonymous Gemini chunks muted after manual stop until a native turn boundary', async () => {
    const { session, socket, worklet, playback } = await connect('gemini_live')
    socket.event({ type: 'audio', data: pcm })
    session.interrupt()
    socket.event({ type: 'audio', data: pcm })
    socket.event({ type: 'output_transcript', text: '旧的回答' })
    expect(playback.sources).toHaveLength(1)
    expect(callbacks.onTranscriptItem).not.toHaveBeenCalled()
    worklet.packet()
    expect(track.stop).not.toHaveBeenCalled()
    socket.event({ type: 'turn_complete' })
    socket.event({ type: 'audio', data: pcm })
    expect(playback.sources).toHaveLength(2)
    session.interrupt()
    socket.event({ type: 'interrupted' })
    socket.event({ type: 'audio', data: pcm })
    expect(playback.sources).toHaveLength(3)
  })

  it('does not mute the next Gemini answer when stop is clicked while idle or after generation finished', async () => {
    const { session, socket, playback } = await connect('gemini_live')
    session.interrupt()
    socket.event({ type: 'audio', data: pcm })
    expect(playback.sources).toHaveLength(1)
    socket.event({ type: 'turn_complete' })
    session.interrupt()
    expect(playback.sources[0].stop).toHaveBeenCalledOnce()
    socket.event({ type: 'audio', data: pcm })
    expect(playback.sources).toHaveLength(2)
  })

  it('adds one typed user turn without reconnecting capture', async () => {
    const { session, socket } = await connect()
    session.sendText(' 请深度思考这个问题 ')
    expect(socket.sent.at(-1)).toEqual({ type: 'text', text: '请深度思考这个问题' })
    expect(callbacks.onTranscriptItem).toHaveBeenCalledOnce()
    expect(callbacks.onTranscriptItem).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', text: '请深度思考这个问题', final: true }))
    expect(getUserMedia).toHaveBeenCalledOnce()
  })

  it('replaces already generated but still queued audio when a new text turn is sent', async () => {
    const { session, socket, playback } = await connect()
    socket.event({ type: 'response_started', response_id: 'old' })
    socket.event({ type: 'audio', data: pcm, response_id: 'old' })
    socket.event({ type: 'turn_complete', response_id: 'old' })
    session.sendText('换个问题')
    expect(playback.sources[0].stop).toHaveBeenCalledOnce()
    socket.event({ type: 'audio', data: pcm, response_id: 'old' })
    expect(playback.sources).toHaveLength(1)
    socket.event({ type: 'response_started', response_id: 'new' })
    socket.event({ type: 'audio', data: pcm, response_id: 'new' })
    expect(playback.sources).toHaveLength(2)
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('replaces Gemini model-text fallback with spoken captions instead of doubling the answer', async () => {
    const { socket } = await connect('gemini_live')
    socket.event({ type: 'model_text', text: '你好，' })
    socket.event({ type: 'model_text', text: '我在这里。' })
    socket.event({ type: 'output_transcript', text: '你好，' })
    socket.event({ type: 'output_transcript', text: '我在这里。' })
    socket.event({ type: 'model_text', text: '你好，我在这里。' })
    const items = vi.mocked(callbacks.onTranscriptItem!).mock.calls.map(([item]) => item)
    expect(new Set(items.map((item) => item.id)).size).toBe(1)
    expect(items.at(-1)?.text).toBe('你好，我在这里。')
    expect(items).toHaveLength(4)
  })
})

describe('PCM playback races', () => {
  it('keeps playback active after source end until the physical speaker tail has drained', async () => {
    vi.useFakeTimers()
    let playback!: RealtimePlayback
    const states: boolean[] = []
    const frames = vi.fn()
    playback = new RealtimePlayback(() => states.push(playback.active), vi.fn(), undefined, frames)
    try {
      const context = FakeAudioContext.instances[0]
      let audible = 0
      Object.assign(context, { getOutputTimestamp: () => ({ contextTime: audible }) })
      const samples = Int16Array.from({ length: 2400 }, (_, index) => Math.round(12000 * Math.sin(index * Math.PI / 12)))
      let bytes = ''
      for (const value of new Uint8Array(samples.buffer)) bytes += String.fromCharCode(value)
      await playback.play(btoa(bytes), 'tail')
      // Scheduling is 0.18..0.28s. Rendering completed while the speaker is at 0.23s.
      context.currentTime = 0.3
      audible = 0.23
      context.sources[0].onended?.()
      expect(playback.active).toBe(true)
      vi.advanceTimersByTime(40)
      expect(frames.mock.lastCall?.[0].active).toBe(true)
      expect(context.close).not.toHaveBeenCalled()
      audible = 0.30
      vi.advanceTimersByTime(40)
      expect(playback.active).toBe(false)
      expect(states.at(-1)).toBe(false)
      expect(frames.mock.lastCall?.[0].active).toBe(false)
    } finally { playback.close(); vi.useRealTimers() }
  })

  it('never plays a chunk whose resume promise completed after interruption', async () => {
    const playback = new RealtimePlayback(vi.fn(), vi.fn())
    const context = FakeAudioContext.instances[0]
    const resume = deferred<void>()
    context.state = 'suspended'
    context.resume.mockImplementation(() => resume.promise)
    const pending = playback.play(pcm, 'old')
    expect(playback.active).toBe(true)
    playback.block('old')
    playback.stop()
    resume.resolve()
    await pending
    expect(context.sources).toHaveLength(0)
    expect(playback.active).toBe(false)
    playback.close()
  })

  it('never creates audio after the entire session was closed during resume', async () => {
    const playback = new RealtimePlayback(vi.fn(), vi.fn())
    const context = FakeAudioContext.instances[0]
    const resume = deferred<void>()
    context.state = 'suspended'
    context.resume.mockImplementation(() => resume.promise)
    const pending = playback.play(pcm, 'old')
    playback.close()
    resume.resolve()
    await pending
    expect(context.sources).toHaveLength(0)
    expect(context.close).toHaveBeenCalledOnce()
  })
})
