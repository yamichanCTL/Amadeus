import { RealtimePlayback } from './realtimePlayback'
import type { LiveProvider, LiveVoiceCallbacks, LiveVoiceOptions, LiveTranscriptItem } from './liveVoiceTypes'

type Event = Record<string, unknown> & { type: string }
type MicrophonePacket = { type: string; pcm?: ArrayBuffer; rms?: number; peak?: number }

function base64(bytes: Uint8Array) {
  let text = ''
  for (const value of bytes) text += String.fromCharCode(value)
  return btoa(text)
}

export class WebSocketVoiceSession {
  private socket: WebSocket | null = null
  private stream: MediaStream | null = null
  private capture: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private worklet: AudioWorkletNode | null = null
  private silence: GainNode | null = null
  private playback: RealtimePlayback | null = null
  private alive = false
  private ready = false
  private epoch = 0
  private rejectStart: ((reason: Error) => void) | null = null
  private responseId: string | undefined
  private generating = false
  private thinking = false
  private discardAnonymousOutput = false
  private microphoneReady = false
  private rowNumber = 0
  private fallbackInput: string | undefined
  private fallbackOutput: string | undefined
  private transcripts = new Map<string, LiveTranscriptItem>()
  private modelTextRows = new Set<string>()
  private samples = 0
  private serverSeconds = 0
  private level = -100
  private speechPackets = 0
  private quietPackets = 0
  private speechSeen = false
  private sessionId = crypto.randomUUID()
  private readonly resumeVisibleCapture = () => {
    const capture = this.capture
    const epoch = this.epoch
    if (!document.hidden && this.alive && capture?.state === 'suspended') {
      void capture.resume().catch(() => {
        if (this.current(epoch)) this.callbacks.onError('麦克风处理暂停，请重新连接实时语音')
      })
    }
  }

  constructor(private base: string, private provider: Exclude<LiveProvider, 'openai'>,
    private instructions: string, private callbacks: LiveVoiceCallbacks, private options: LiveVoiceOptions = {}) {}

  async start(deviceId?: string) {
    if (this.alive) throw new Error('实时语音会话已启动')
    this.alive = true
    this.sessionId = crypto.randomUUID()
    this.responseId = this.fallbackInput = this.fallbackOutput = undefined
    this.generating = this.thinking = this.microphoneReady = this.discardAnonymousOutput = false
    this.speechPackets = this.quietPackets = this.samples = this.serverSeconds = 0
    this.speechSeen = false
    this.level = -100
    this.transcripts.clear()
    this.modelTextRows.clear()
    const epoch = ++this.epoch
    this.callbacks.onState('connecting')
    try {
      this.playback = new RealtimePlayback(() => this.updateState(), (error) => {
        if (this.alive) this.callbacks.onError(error instanceof Error ? error.message : '音频播放失败')
      }, this.options.outputDeviceId, this.callbacks.onAvatarAudioFrame)
      const url = new URL(`${this.base.replace(/\/$/, '')}/v1/live-voice/ws`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url)
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.rejectStart = null
          if (error) reject(error)
          else resolve()
        }
        const timer = window.setTimeout(() => settle(new Error('实时语音模型连接超时')), 30000)
        this.rejectStart = (error) => settle(error)
        socket.onopen = () => {
          if (this.current(epoch)) this.send({ type: 'start', model: this.provider,
            voice: this.options.voice, brain: this.options.brain || 'off',
            reasoning: this.options.reasoning, instructions: this.instructions.slice(0, 4000) })
        }
        socket.onmessage = (message) => {
          if (!this.current(epoch)) return
          let event: Event
          try { event = JSON.parse(String(message.data)) as Event } catch { return }
          if (event.type === 'ready') { this.ready = true; settle(); return }
          if (!this.ready && event.type === 'error') {
            settle(new Error(String(event.message || '实时语音连接失败')))
            return
          }
          this.handle(event)
        }
        socket.onerror = () => {
          if (!this.current(epoch)) return
          const error = new Error('无法连接实时语音后端，请检查后端地址和运行状态')
          if (!settled) settle(error)
          else { this.callbacks.onError(error.message); this.stop() }
        }
        socket.onclose = () => {
          if (!this.current(epoch)) return
          const error = new Error('实时语音连接已断开，请重新连接')
          if (!settled) settle(error)
          else { this.callbacks.onError(error.message); this.stop() }
        }
      })
      if (!this.current(epoch)) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}), channelCount: 1,
        echoCancellation: true, noiseSuppression: false, autoGainControl: true,
      } })
      if (!this.current(epoch)) { stream.getTracks().forEach((track) => track.stop()); return }
      this.stream = stream
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (this.current(epoch)) { this.callbacks.onError('麦克风设备已断开，请重新连接'); this.stop() }
        }
      })
      const capture = new AudioContext()
      this.capture = capture
      document.addEventListener('visibilitychange', this.resumeVisibleCapture)
      // Keep this public asset external: Vite inlines small ?url imports into
      // data URLs, which the desktop's script-src 'self' policy correctly blocks.
      const microphoneWorkletUrl = new URL(`${import.meta.env.BASE_URL}realtime-mic-worklet.js`, window.location.href).href
      await capture.audioWorklet.addModule(microphoneWorkletUrl)
      if (!this.current(epoch)) return
      const worklet = new AudioWorkletNode(capture, 'amadeus-microphone', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      })
      this.worklet = worklet
      this.source = capture.createMediaStreamSource(stream)
      this.silence = capture.createGain()
      this.silence.gain.value = 0
      worklet.port.onmessage = (event) => { if (this.current(epoch)) this.sendPacket(event.data as MicrophonePacket) }
      worklet.onprocessorerror = () => {
        if (this.current(epoch)) { this.callbacks.onError('麦克风处理已中断，请重新连接'); this.stop() }
      }
      this.source.connect(worklet)
      worklet.connect(this.silence)
      this.silence.connect(capture.destination)
      await capture.resume()
      if (!this.current(epoch)) return
      this.microphoneReady = true
      this.updateState()
    } catch (error) {
      if (!this.current(epoch)) return
      this.stop()
      throw error
    }
  }

  private current(epoch: number) { return this.alive && this.epoch === epoch }

  private send(event: Record<string, unknown>) {
    if (this.alive && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }

  private sendPacket(packet: MicrophonePacket) {
    if (!this.ready || !this.stream || packet.type !== 'packet' || !packet.pcm) return
    if ((this.socket?.bufferedAmount || 0) > 2_000_000) {
      this.callbacks.onError('语音上传积压，请检查网络后重新连接')
      this.stop()
      return
    }
    const bytes = new Uint8Array(packet.pcm)
    this.send({ type: 'audio', data: base64(bytes) })
    this.samples += bytes.byteLength / 2
    this.level = 20 * Math.log10(Math.max(packet.rms || 0, 0.00001))
    this.captureChanged()
    // Gemini's server remains responsible for interruption. This only marks a
    // sustained quiet period after speech; it NEVER cancels or mutes playback.
    if (this.provider === 'gemini_live' || this.provider === 'gemini_thinking') {
      const peakDb = 20 * Math.log10(Math.max(packet.peak || 0, 0.00001))
      if (this.level > -52 || peakDb > -38) {
        this.speechPackets += 1
        this.quietPackets = 0
        if (this.speechPackets >= 2) this.speechSeen = true
      } else {
        this.speechPackets = 0
        if (this.speechSeen && ++this.quietPackets >= 10) {
          const silence = base64(new Uint8Array(3200))
          for (let i = 0; i < 10; i += 1) this.send({ type: 'audio', data: silence, padding: true })
          this.send({ type: 'audio_end' })
          this.speechSeen = false
          this.quietPackets = 0
        }
      }
    }
  }

  private captureChanged() {
    this.callbacks.onCapture?.({ level: this.level, seconds: this.samples / 16000, serverSeconds: this.serverSeconds })
  }

  private row(role: 'user' | 'assistant', id: string, text: string, cumulative = false, final?: boolean) {
    if (!text) return
    const key = `${this.sessionId}:${role}:${id}`
    const old = this.transcripts.get(key)?.text || ''
    const value = cumulative ? text : old + text
    const item = { role, id: key, text: value, final }
    this.transcripts.set(key, item)
    if (this.transcripts.size > 256) this.transcripts.delete(this.transcripts.keys().next().value!)
    if (this.callbacks.onTranscriptItem) this.callbacks.onTranscriptItem(item)
    else this.callbacks.onTranscript(role, cumulative && value.startsWith(old) ? value.slice(old.length) : text)
  }

  private handle(event: Event) {
    const id = typeof event.response_id === 'string' ? event.response_id : undefined
    switch (event.type) {
      case 'response_started':
        if (this.playback?.isBlocked(id)) break
        this.responseId = id
        this.fallbackOutput = undefined
        this.generating = true
        this.updateState()
        break
      case 'input_transcript': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : undefined
        this.fallbackInput ||= `input-${++this.rowNumber}`
        const gemini = this.provider === 'gemini_live' || this.provider === 'gemini_thinking'
        this.row('user', itemId || this.fallbackInput, String(event.text || ''), !gemini || event.cumulative === true,
          typeof event.final === 'boolean' ? event.final : undefined)
        break
      }
      case 'output_transcript':
      case 'model_text': {
        if (!id && this.discardAnonymousOutput) break
        if (this.playback?.isBlocked(id)) break
        this.fallbackOutput ||= `output-${++this.rowNumber}`
        const rowId = id || this.responseId || this.fallbackOutput
        if (event.type === 'model_text') {
          if (this.transcripts.has(`${this.sessionId}:assistant:${rowId}`) && !this.modelTextRows.has(rowId)) break
          this.modelTextRows.add(rowId)
          this.row('assistant', rowId, String(event.text || ''))
        } else {
          // Gemini may include model text before its spoken-output transcript.
          // Replace that fallback on the first caption instead of duplicating it.
          this.row('assistant', rowId, String(event.text || ''), this.modelTextRows.delete(rowId))
        }
        break
      }
      case 'audio':
        if (!id && this.discardAnonymousOutput) break
        if (this.playback?.isBlocked(id)) break
        if (id) this.responseId = id
        this.generating = true
        void this.playback?.play(String(event.data || ''), id || this.responseId)
        break
      case 'capture_ack':
        this.serverSeconds = Number(event.seconds) || 0
        this.captureChanged()
        break
      case 'speech_started':
        this.fallbackInput = undefined
        // The native server speech event can arrive after generation completed,
        // while PCM is still queued on the device. Stop that queue as well.
        this.cancelOutput(id || this.responseId)
        break
      case 'interrupted':
        // Gemini's native interruption is a boundary: the interrupted turn is
        // discarded upstream and subsequent audio belongs to the next answer.
        if (!id) this.discardAnonymousOutput = false
        this.playback?.block(id)
        if (!id || id === this.responseId) this.cancelOutput(id || this.responseId)
        break
      case 'response_suppressed':
        this.playback?.block(id)
        if (!id || id === this.responseId) this.cancelOutput(id || this.responseId)
        break
      case 'turn_complete':
        if (id && this.responseId && id !== this.responseId) break
        this.discardAnonymousOutput = false
        this.generating = false
        this.fallbackInput = undefined
        this.fallbackOutput = undefined
        this.updateState()
        break
      case 'thinking_status':
        this.thinking = event.status === 'IN_PROGRESS'
        this.updateState()
        break
      case 'tool':
        this.callbacks.onTool?.({ name: String(event.name || ''), result: event.result })
        break
      case 'error':
        this.callbacks.onError(String(event.message || '实时语音模型返回错误'))
        break
    }
  }

  private cancelOutput(id?: string) {
    this.playback?.block(id)
    this.generating = false
    this.thinking = false
    this.fallbackOutput = undefined
    this.playback?.stop()
    this.updateState()
  }

  private updateState() {
    if (!this.alive || !this.ready) return
    this.callbacks.onState(this.playback?.active ? 'speaking' : this.thinking || this.generating ? 'working'
      : this.microphoneReady ? 'listening' : 'connecting')
  }

  sendText(text: string) {
    const value = text.trim()
    if (!value) return
    if (!this.alive || !this.ready) throw new Error('请先连接实时语音模型')
    if (value.length > 2000) throw new Error('单次实时语音文字输入不能超过 2000 字')
    // A text turn replaces the queued response just as native speech does.
    // Upstream may already be finished while its PCM remains on this device.
    this.cancelOutput(this.responseId)
    this.fallbackInput = undefined
    this.send({ type: 'text', text: value })
    this.row('user', `text-${++this.rowNumber}`, value, true, true)
    this.generating = true
    this.updateState()
  }

  interrupt() {
    if (!this.alive || !this.ready) return
    this.send({ type: 'interrupt', response_id: this.responseId })
    // The Gemini adapter supplies no response IDs or verified manual generation
    // cancellation. Keep this utterance muted until its native turn boundary.
    // Microphone upload stays active, so native barge-in can still start a turn.
    if (this.provider === 'gemini_live' || this.provider === 'gemini_thinking') {
      // Once turn_complete arrived, only device PCM remains: no future boundary
      // will arrive for it. Muting until one would swallow the next user's turn.
      this.discardAnonymousOutput ||= this.generating || this.thinking
    }
    this.cancelOutput(this.responseId)
  }

  stop() {
    if (!this.alive) return
    this.alive = false
    this.ready = false
    this.epoch += 1
    this.rejectStart?.(new DOMException('已停止连接', 'AbortError'))
    this.rejectStart = null
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null
      this.socket.close()
      this.socket = null
    }
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop() })
    this.stream = null
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.port.close(); this.worklet.disconnect() }
    this.worklet = null
    this.source?.disconnect()
    this.silence?.disconnect()
    this.source = null
    this.silence = null
    document.removeEventListener('visibilitychange', this.resumeVisibleCapture)
    void this.capture?.close().catch(() => undefined)
    this.capture = null
    this.playback?.close()
    this.playback = null
    this.callbacks.onState('closed')
  }
}
