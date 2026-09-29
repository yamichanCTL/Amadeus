import { ScheduledAudioMouth, type AvatarAudioListener } from './avatarAudio'

/** PCM playback with cancellation covering both queued sources and pending resume(). */
export class RealtimePlayback {
  private context: AudioContext
  private epoch = 0
  private closed = false
  private sources = new Set<AudioBufferSourceNode>()
  private pending = new Set<object>()
  private blocked = new Set<string>()
  private playAt = 0
  private started = false
  private mouth: ScheduledAudioMouth | null = null

  constructor(private changed: () => void, private failed: (error: unknown) => void, outputDeviceId?: string,
    onAvatarAudioFrame?: AvatarAudioListener) {
    this.context = new AudioContext({ sampleRate: 24000 })
    if (onAvatarAudioFrame) this.mouth = new ScheduledAudioMouth(this.context, onAvatarAudioFrame, () => this.changed())
    // Construct while handling the user's Connect gesture; playback resumes below.
    void this.context.resume().catch(() => undefined)
    const sink = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (outputDeviceId && outputDeviceId !== 'default' && sink.setSinkId) {
      void sink.setSinkId(outputDeviceId).catch((error) => { if (!this.closed) this.failed(error) })
    }
  }

  // Sources end on the rendering clock; the speaker may still be playing its
  // device buffer. Keep preview/session ownership until that audio tail drains.
  get active() { return this.sources.size > 0 || this.pending.size > 0 || Boolean(this.mouth?.active) }
  isBlocked(id?: string) { return Boolean(id && this.blocked.has(id)) }

  block(id?: string) {
    if (!id) return
    this.blocked.add(id)
    // Session histories are bounded while keeping recent cancelled responses.
    if (this.blocked.size > 2048) this.blocked.delete(this.blocked.values().next().value!)
  }

  async play(encoded: string, responseId?: string) {
    if (this.closed || this.isBlocked(responseId)) return
    const epoch = this.epoch
    const pending = {}
    this.pending.add(pending)
    this.changed()
    try {
      if (this.context.state === 'suspended') await this.context.resume()
      if (this.closed || epoch !== this.epoch || this.isBlocked(responseId)) return
      const raw = atob(encoded)
      const frames = Math.floor(raw.length / 2)
      if (!frames) return
      const buffer = this.context.createBuffer(1, frames, 24000)
      const samples = buffer.getChannelData(0)
      for (let i = 0; i < frames; i += 1) {
        const value = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8
        samples[i] = (value >= 32768 ? value - 65536 : value) / 32768
      }
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.context.destination)
      const now = this.context.currentTime
      if (!this.started) {
        this.playAt = Math.max(now + 0.18, this.playAt)
        this.started = true
      } else if (this.playAt < now) this.playAt = now + 0.02
      this.sources.add(source)
      source.onended = () => {
        this.sources.delete(source)
        source.disconnect()
        this.changed()
      }
      source.start(this.playAt)
      this.mouth?.enqueue(samples, 24000, this.playAt)
      this.playAt += buffer.duration
    } catch (error) {
      if (!this.closed && epoch === this.epoch) this.failed(error)
    } finally {
      this.pending.delete(pending)
      this.changed()
    }
  }

  stop() {
    this.epoch += 1
    this.mouth?.stop()
    this.pending.clear()
    const sources = [...this.sources]
    this.sources.clear()
    for (const source of sources) {
      source.onended = null
      try { source.stop() } catch { /* Already ended. */ }
      source.disconnect()
    }
    this.playAt = this.context.currentTime
    this.started = false
    this.changed()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.stop()
    this.mouth?.close()
    void this.context.close().catch(() => undefined)
  }
}
