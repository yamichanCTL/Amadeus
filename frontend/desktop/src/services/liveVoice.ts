import { WebSocketVoiceSession } from './liveVoiceWebSocket'
import { observeAudioElement } from './avatarAudio'
import type { LiveProvider, LiveVoiceCallbacks, LiveVoiceOptions } from './liveVoiceTypes'
export type { LiveProvider, LiveVoiceState, LiveVoiceCallbacks, LiveVoiceOptions, LiveTranscriptItem, LiveCapture, LiveAvatarAudioFrame } from './liveVoiceTypes'

/** One application entry point. Tested PCM providers use the local backend socket;
 * OpenAI retains the existing WebRTC route pending its separate deployment. */
export class LiveVoiceSession {
  private connection: WebSocketVoiceSession | LegacyWebRtcVoiceSession
  constructor(base: string, provider: LiveProvider, instructions: string, callbacks: LiveVoiceCallbacks, options: LiveVoiceOptions = {}) {
    this.connection = provider === 'openai'
      ? new LegacyWebRtcVoiceSession(base, instructions, callbacks)
      : new WebSocketVoiceSession(base, provider, instructions, callbacks, options)
  }
  start(deviceId?: string) { return this.connection.start(deviceId) }
  sendText(text: string) { this.connection.sendText(text) }
  interrupt() { this.connection.interrupt() }
  stop() { this.connection.stop() }
}

type VoiceEvent = Record<string, unknown> & { type: string }

class LegacyWebRtcVoiceSession {
  private peer: RTCPeerConnection | null = null
  private local: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private channel: RTCDataChannel | null = null
  private base: string
  private instructions: string
  private callbacks: LiveVoiceCallbacks
  private transcript: Array<{ role: 'user' | 'assistant'; text: string; id: string }> = []
  private alive = false
  private closingTimer: number | null = null
  private stopObservingAudio: (() => void) | null = null

  constructor(base: string, instructions: string, callbacks: LiveVoiceCallbacks) {
    this.base = base.replace(/\/$/, '')
    this.instructions = instructions.slice(0, 4000)
    this.callbacks = callbacks
  }

  async start(deviceId?: string) {
    if (!this.base) throw new Error('请先在设置中确认本机后端地址')
    this.callbacks.onState('connecting')
    this.alive = true
    try {
      const local = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        echoCancellation: true, noiseSuppression: false, autoGainControl: true,
      } })
      if (!this.alive) { local.getTracks().forEach((track) => track.stop()); return }
      this.local = local
      const peer = new RTCPeerConnection({ iceServers: [] })
      this.peer = peer
      const track = this.local.getAudioTracks()[0]
      peer.addTrack(track, this.local)
      this.audio = document.createElement('audio')
      this.audio.autoplay = true
      this.audio.style.display = 'none'
      document.body.append(this.audio)
      peer.ontrack = (event) => {
        if (this.alive && this.audio) {
          this.stopObservingAudio?.()
          this.audio.srcObject = event.streams[0]
          if (this.callbacks.onAvatarAudioFrame) this.stopObservingAudio = observeAudioElement(this.audio, this.callbacks.onAvatarAudioFrame)
          void this.audio.play().catch(() => {})
        }
      }
      peer.onconnectionstatechange = () => {
        if (!this.alive) return
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          this.callbacks.onError('实时语音连接已断开')
          this.stop()
        }
      }
      const channel = peer.createDataChannel('oai-events')
      this.channel = channel
      channel.onmessage = (event) => this.handleEvent(event.data)
      peer.ondatachannel = (event) => { event.channel.onmessage = (message) => this.handleEvent(message.data) }
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') { resolve(); return }
        const timer = window.setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('WebRTC ICE 收集超时')) }, 12000)
        const check = () => {
          if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve() }
        }
        peer.addEventListener('icegatheringstatechange', check)
      })
      if (!this.alive) return
      const response = await fetch(`${this.base}/v1/live-voice/session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', sdp: peer.localDescription?.sdp, instructions: this.instructions }),
      })
      const payload = await response.json()
      if (!this.alive) return
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : '实时语音会话创建失败')
      const sdp = String(payload.sdp).trim().replace(/\r?\n/g, '\r\n') + '\r\n'
      await peer.setRemoteDescription({ type: 'answer', sdp })
    } catch (error) {
      this.stop()
      throw error
    }
  }

  private send(event: Record<string, unknown>, channel = this.channel) {
    if (this.alive && channel?.readyState === 'open') channel.send(JSON.stringify(event))
  }

  private handleEvent(raw: string) {
    let event: VoiceEvent
    try { event = JSON.parse(raw) as VoiceEvent } catch { return }
    if (event.type === 'session.closed') { this.dispose(); return }
    if (!this.alive) return
    if (event.type === 'session.started' || event.type === 'session.created') {
      this.callbacks.onState('listening')
    }
    if (event.type === 'session.input_transcript.delta') this.addTranscript('user', String(event.delta || ''))
    if (event.type === 'session.output_transcript.delta') { this.callbacks.onState('speaking'); this.addTranscript('assistant', String(event.delta || '')) }
    if (event.type === 'conversation.item.input_audio_transcription.completed') this.addTranscript('user', String(event.transcript || ''))
    if (event.type === 'response.audio_transcript.delta' || event.type === 'response.text.delta') {
      this.callbacks.onState('speaking')
      this.addTranscript('assistant', String(event.delta || ''))
    }
    if (event.type === 'session.delegation.created') {
      const delegation = event.delegation as { id?: string; target?: string } | undefined
      if (delegation?.target === 'client' && delegation.id) void this.runOpenAIDelegation(delegation.id)
    }
    if (event.type === 'error') this.callbacks.onError(String((event.error as { message?: string } | undefined)?.message || event.message || '实时语音模型返回错误'))
  }

  private addTranscript(role: 'user' | 'assistant', delta: string) {
    if (!delta) return
    const last = this.transcript.at(-1)
    if (last?.role === role) last.text += delta
    else this.transcript.push({ role, text: delta, id: crypto.randomUUID() })
    if (this.transcript.length > 40) this.transcript.shift()
    if (this.callbacks.onTranscriptItem) this.callbacks.onTranscriptItem(this.transcript[this.transcript.length - 1])
    else this.callbacks.onTranscript(role, delta)
  }

  private async runOpenAIDelegation(id: string) {
    this.callbacks.onState('working')
    try {
      const history = this.transcript.map((item) => `${item.role === 'user' ? '用户' : '爱弥斯'}：${item.text}`).join('\n').slice(-6000)
      const task = `请根据以下实时语音对话完成用户委派的任务。语音转写可能不完整，必要时先澄清。\n${history}`
      const result = await this.callbacks.onDelegate(task)
      if (!this.alive) return
      for (const chunk of result.match(/[\s\S]{1,300}/g) || []) {
        this.send({ type: 'session.commentary.append', event_id: `codex_${crypto.randomUUID()}`, delegation_id: id, content: chunk })
      }
      this.callbacks.onState('listening')
    } catch (error) {
      if (this.alive) {
        this.send({ type: 'session.commentary.append', event_id: `codex_error_${crypto.randomUUID()}`, delegation_id: id, content: '后台任务未完成，请告知用户稍后重试。' })
        this.callbacks.onError(error instanceof Error ? error.message : 'Codex 任务失败')
      }
    }
  }

  sendText(_text: string) {
    throw new Error('GPT Live 文字输入尚未部署验证，请先使用语音或切换其他实时模型')
  }

  interrupt() {
    // The preserved OpenAI path has no verified manual interruption event yet.
    this.callbacks.onError('GPT Live 手动打断尚未部署验证，请使用原生语音打断')
  }

  stop() {
    if (!this.alive) return
    if (this.channel?.readyState === 'open') {
      this.send({ type: 'session.close', event_id: `close_${crypto.randomUUID()}` })
      this.alive = false
      this.audio?.pause()
      this.stopObservingAudio?.()
      this.stopObservingAudio = null
      this.local?.getTracks().forEach((track) => track.stop())
      this.local = null
      this.callbacks.onState('closed')
      this.closingTimer = window.setTimeout(() => this.dispose(), 15000)
      return
    }
    this.dispose()
  }

  private dispose() {
    this.alive = false
    this.stopObservingAudio?.()
    this.stopObservingAudio = null
    if (this.closingTimer !== null) { clearTimeout(this.closingTimer); this.closingTimer = null }
    this.local?.getTracks().forEach((track) => track.stop())
    this.local = null
    this.channel?.close()
    this.channel = null
    this.peer?.close()
    this.peer = null
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio.remove(); this.audio = null }
    this.callbacks.onState('closed')
  }
}
