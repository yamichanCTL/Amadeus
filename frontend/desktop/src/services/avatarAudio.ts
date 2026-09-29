import type { LiveAvatarAudioFrame } from './liveVoiceTypes'

export type AvatarAudioListener = (frame: LiveAvatarAudioFrame) => void
type Mouth = Pick<LiveAvatarAudioFrame, 'level' | 'vowels' | 'active'>

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const closedMouth = (): Mouth => ({ level: 0, vowels: { a: 0, i: 0, u: 0, e: 0, o: 0 }, active: false })

export function silentAvatarAudioFrame(epoch: number, audioTime = 0): LiveAvatarAudioFrame {
  return { timestamp: Date.now(), epoch, audioTime, ...closedMouth() }
}

/** A quiet gate and coarse frequency balance give a useful speaking silhouette.
 * These are deliberately mixed mouth shapes, not inferred Chinese phonemes. */
export function analyseSpeechWindow(samples: Float32Array, sampleRate: number): Mouth {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return closedMouth()
  let mean = 0
  for (const value of samples) mean += Number.isFinite(value) ? value : 0
  mean /= samples.length
  let energy = 0
  for (const sample of samples) { const value = Number.isFinite(sample) ? sample - mean : 0; energy += value * value }
  const rms = Math.sqrt(energy / samples.length)
  if (rms < 0.006) return closedMouth()
  const level = clamp((20 * Math.log10(rms) + 48) / 34)
  const power = (frequency: number) => {
    const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate)
    let first = 0, second = 0
    for (let index = 0; index < samples.length; index += 1) {
      const value = (Number.isFinite(samples[index]) ? samples[index] - mean : 0)
        * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, samples.length - 1)))
      const next = value + coefficient * first - second
      second = first; first = next
    }
    return Math.max(0, first * first + second * second - coefficient * first * second)
  }
  const low = power(250) + power(450)
  const middle = power(750) + power(1100)
  const high = power(1800) + power(2600)
  const total = low + middle + high + 1e-12
  const rounded = low / total, wide = high / total, open = middle / total
  const weights = { a: 0.42 + open * 0.46, i: wide * 0.27, u: rounded * 0.20,
    e: 0.08 + wide * 0.27, o: rounded * 0.38 }
  const sum = Object.values(weights).reduce((result, value) => result + value, 0)
  for (const key of Object.keys(weights) as Array<keyof typeof weights>) weights[key] = weights[key] / sum * level * 0.9
  return { level, vowels: weights, active: level > 0 }
}

/** AudioContext rendering can run ahead of the physical speaker. */
export function audibleContextTime(context: AudioContext) {
  const stamp = context.getOutputTimestamp?.()
  if (stamp && Number.isFinite(stamp.contextTime) && stamp.contextTime! >= 0) return stamp.contextTime!
  return Math.max(0, context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0))
}

type ScheduledPcm = { start: number; end: number; samples: Float32Array; rate: number }

/** Samples only the PCM window scheduled at the current speaker clock. Queued
 * audio never moves the mouth early, including the initial 180 ms prebuffer. */
export class ScheduledAudioMouth {
  private queue: ScheduledPcm[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private epoch = 0
  private closed = false

  constructor(private context: AudioContext, private listener: AvatarAudioListener, private drained?: () => void) {}

  get active() { return this.queue.length > 0 }

  enqueue(samples: Float32Array, rate: number, start: number) {
    if (this.closed) return
    this.queue.push({ start, end: start + samples.length / rate, samples, rate })
    if (this.timer === null) this.tick(this.epoch)
  }

  private tick(epoch: number) {
    if (this.closed || epoch !== this.epoch) return
    this.timer = null
    const time = audibleContextTime(this.context)
    while (this.queue.length && this.queue[0].end <= time) this.queue.shift()
    const current = this.queue.find((chunk) => chunk.start <= time && time < chunk.end)
    let mouth = closedMouth()
    if (current && this.context.state === 'running') {
      const centre = Math.floor((time - current.start) * current.rate)
      const half = Math.round(current.rate * 0.01)
      mouth = analyseSpeechWindow(current.samples.subarray(Math.max(0, centre - half), Math.min(current.samples.length, centre + half)), current.rate)
    }
    this.listener({ timestamp: Date.now(), epoch, audioTime: time, ...mouth })
    if (this.queue.length) this.timer = setTimeout(() => this.tick(epoch), 33)
    else this.drained?.()
  }

  stop() {
    this.epoch += 1
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
    this.listener(silentAvatarAudioFrame(this.epoch, audibleContextTime(this.context)))
  }

  close() { if (!this.closed) { this.stop(); this.closed = true } }
}

/** Observe TTS/preview audio or an existing WebRTC audio element. A media file
 * uses one Web Audio output route; srcObject streams keep their native output
 * and attach only a muted analysis branch. Dispose after playback is stopped. */
export function observeAudioElement(audio: HTMLAudioElement, listener: AvatarAudioListener): () => void {
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0
  const stream = audio.srcObject as MediaStream | null
  const source = stream && typeof stream.getAudioTracks === 'function'
    ? context.createMediaStreamSource(stream) : context.createMediaElementSource(audio)
  const output = context.createGain()
  output.gain.value = stream ? 0 : 1
  // A file now renders through this single context, so retain an explicitly
  // selected speaker from the element when the browser supports sink routing.
  const sinkId = (audio as HTMLAudioElement & { sinkId?: string }).sinkId
  const sinkContext = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
  if (!stream && sinkId && sinkContext.setSinkId) void sinkContext.setSinkId(sinkId).catch(() => undefined)
  source.connect(analyser)
  analyser.connect(output)
  output.connect(context.destination)
  const samples = new Float32Array(analyser.fftSize)
  let timer: ReturnType<typeof setTimeout> | null = null
  let epoch = 0
  let disposed = false
  let playing = !audio.paused && !audio.ended && audio.readyState >= 3
  const clear = () => {
    epoch += 1
    if (timer !== null) clearTimeout(timer)
    timer = null
    listener(silentAvatarAudioFrame(epoch, Number.isFinite(audio.currentTime) ? audio.currentTime : 0))
  }
  const tick = (generation: number) => {
    if (disposed || generation !== epoch) return
    timer = null
    if (!playing || audio.paused || audio.ended) { clear(); return }
    analyser.getFloatTimeDomainData(samples)
    const mouth = context.state === 'running' ? analyseSpeechWindow(samples, context.sampleRate) : closedMouth()
    listener({ timestamp: Date.now(), epoch, audioTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0, ...mouth })
    timer = setTimeout(() => tick(generation), 33)
  }
  const onPlaying = () => {
    if (disposed) return
    playing = true
    void context.resume().catch(() => clear())
    if (timer === null) tick(epoch)
  }
  const onStopped = () => { playing = false; clear() }
  audio.addEventListener('playing', onPlaying)
  for (const event of ['pause', 'ended', 'emptied', 'waiting']) audio.addEventListener(event, onStopped)
  if (playing) onPlaying()
  else listener(silentAvatarAudioFrame(epoch))
  return () => {
    if (disposed) return
    disposed = true
    audio.removeEventListener('playing', onPlaying)
    for (const event of ['pause', 'ended', 'emptied', 'waiting']) audio.removeEventListener(event, onStopped)
    clear()
    source.disconnect(); analyser.disconnect(); output.disconnect()
    void context.close().catch(() => undefined)
  }
}
