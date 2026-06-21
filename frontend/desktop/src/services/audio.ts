import { finishTelemetryTrace, recordTelemetry, recordTelemetryStage, startTelemetryTrace, type TelemetryTrace } from './telemetry'

export class AudioRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private preparedStream: MediaStream | null = null
  private preparedDeviceId = ''
  private chunks: BlobPart[] = []
  private startedAt = 0
  private levelContext: AudioContext | null = null
  private levelSource: MediaStreamAudioSourceNode | null = null
  private levelAnalyser: AnalyserNode | null = null
  private levelFrame = 0
  private prepareRequest = 0

  async prepare(deviceId?: string) {
    const normalizedDeviceId = deviceId || ''
    if (this.recorder) return
    if (this.preparedStream?.active && this.preparedDeviceId === normalizedDeviceId) return
    const request = ++this.prepareRequest
    this.releasePreparedStream()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    if (request !== this.prepareRequest || this.recorder) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.preparedStream = stream
    this.preparedDeviceId = normalizedDeviceId
    // Give the OS driver and browser AEC/noise suppression a short settling
    // window before the user starts speaking. This runs while the page is idle.
    await new Promise((resolve) => window.setTimeout(resolve, 350))
  }

  isPrepared(deviceId?: string) {
    return Boolean(this.preparedStream?.active && this.preparedDeviceId === (deviceId || ''))
  }

  takePreparedStream(deviceId?: string) {
    if (!this.isPrepared(deviceId)) return undefined
    const stream = this.preparedStream || undefined
    this.preparedStream = null
    this.preparedDeviceId = ''
    return stream
  }

  async start(deviceId?: string, inputStream?: MediaStream, onLevel?: (level: number) => void) {
    if (this.recorder) throw new Error('录音已在进行中')
    const normalizedDeviceId = deviceId || ''
    if (inputStream) {
      this.stream = inputStream
    } else if (this.preparedStream?.active && this.preparedDeviceId === normalizedDeviceId) {
      this.stream = this.preparedStream
      this.preparedStream = null
      this.preparedDeviceId = ''
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })
    }
    if (!this.stream?.active) throw new Error('麦克风音频轨道未就绪')

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    this.chunks = []
    this.startedAt = Date.now()
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start(100)
    if (onLevel) await this.startLevelMonitor(this.stream, onLevel)
  }

  async stop() {
    if (!this.recorder) throw new Error('录音尚未开始')
    const recorder = this.recorder
    const mimeType = recorder.mimeType || 'audio/webm'
    const durationSec = (Date.now() - this.startedAt) / 1000

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.stop()
    await stopped
    this.stopLevelMonitor()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    return { blob: new Blob(this.chunks, { type: mimeType }), durationSec, mimeType }
  }

  cancel() {
    this.prepareRequest += 1
    if (this.recorder?.state !== 'inactive') this.recorder?.stop()
    this.stopLevelMonitor()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.releasePreparedStream()
    this.recorder = null
    this.stream = null
    this.chunks = []
  }

  private async startLevelMonitor(stream: MediaStream, onLevel: (level: number) => void) {
    this.stopLevelMonitor()
    this.levelContext = new AudioContext()
    this.levelSource = this.levelContext.createMediaStreamSource(stream)
    this.levelAnalyser = this.levelContext.createAnalyser()
    this.levelAnalyser.fftSize = 1024
    this.levelAnalyser.smoothingTimeConstant = .7
    this.levelSource.connect(this.levelAnalyser)
    await this.levelContext.resume()
    const samples = new Float32Array(this.levelAnalyser.fftSize)
    const update = () => {
      const analyser = this.levelAnalyser
      if (!analyser) return
      analyser.getFloatTimeDomainData(samples)
      let squareSum = 0
      let peak = 0
      for (const sample of samples) {
        squareSum += sample * sample
        peak = Math.max(peak, Math.abs(sample))
      }
      const rms = Math.sqrt(squareSum / samples.length)
      onLevel(Math.min(1, Math.max(peak * .7, rms * 4)))
      this.levelFrame = requestAnimationFrame(update)
    }
    update()
  }

  private stopLevelMonitor() {
    if (this.levelFrame) cancelAnimationFrame(this.levelFrame)
    this.levelFrame = 0
    this.levelSource?.disconnect()
    this.levelSource = null
    this.levelAnalyser = null
    this.levelContext?.close().catch(() => undefined)
    this.levelContext = null
  }

  private releasePreparedStream() {
    this.preparedStream?.getTracks().forEach((track) => track.stop())
    this.preparedStream = null
    this.preparedDeviceId = ''
  }
}

export const speechRecorder = new AudioRecorder()

export async function listAudioInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audioinput')
}

export async function listAudioOutputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audiooutput')
}

export type AudioInputTestResult = {
  label: string
  sampleRate: number
  peak: number
  rms: number
  echoCancellation: boolean | null
}

export async function testAudioInputDevice(deviceId?: string, durationMs = 1200): Promise<AudioInputTestResult> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    video: false,
  })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  await context.resume()
  const samples = new Float32Array(analyser.fftSize)
  let peak = 0
  let squareSum = 0
  let sampleCount = 0
  const started = performance.now()
  try {
    while (performance.now() - started < durationMs) {
      analyser.getFloatTimeDomainData(samples)
      for (const sample of samples) {
        const absolute = Math.abs(sample)
        peak = Math.max(peak, absolute)
        squareSum += sample * sample
        sampleCount += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const track = stream.getAudioTracks()[0]
    const settings = track?.getSettings()
    return {
      label: track?.label || '系统默认输入',
      sampleRate: Number(settings?.sampleRate || context.sampleRate),
      peak,
      rms: sampleCount ? Math.sqrt(squareSum / sampleCount) : 0,
      echoCancellation: typeof settings?.echoCancellation === 'boolean' ? settings.echoCancellation : null,
    }
  } finally {
    try { source.disconnect() } catch { /* ignore */ }
    try { analyser.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((track) => track.stop())
    await context.close().catch(() => undefined)
  }
}

export async function testAudioOutputDevice(outputDeviceId?: string, durationMs = 450) {
  const context = new AudioContext()
  const sinkContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }
  try {
    if (outputDeviceId) {
      if (!sinkContext.setSinkId) throw new Error('当前 Electron/Chromium 不支持指定输出设备')
      await sinkContext.setSinkId(outputDeviceId)
    }
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 660
    gain.gain.value = 0.06
    oscillator.connect(gain)
    gain.connect(context.destination)
    await context.resume()
    oscillator.start()
    gain.gain.setValueAtTime(0.06, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + durationMs / 1000)
    oscillator.stop(context.currentTime + durationMs / 1000)
    await new Promise<void>((resolve) => { oscillator.onended = () => resolve() })
    return { sinkApplied: Boolean(outputDeviceId && sinkContext.setSinkId), sampleRate: context.sampleRate }
  } finally {
    await context.close().catch(() => undefined)
  }
}

export async function playAudioBlob(blob: Blob, outputDeviceId?: string) {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url) as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> }
  try {
    if (outputDeviceId && audio.setSinkId) {
      await audio.setSinkId(outputDeviceId)
    }
    await audio.play()
    return { audio, url, sinkApplied: Boolean(outputDeviceId && audio.setSinkId) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/**
 * One browser-side relay for microphone passthrough and injected audio.
 *
 * The physical microphone is opened once. Callers that also need ASR/recording
 * receive cloned tracks through createInputStream(), while microphone audio,
 * decoded sound effects/TTS and streaming PCM share the same AudioContext
 * destination (including its selected virtual output device).
 */
export class AudioRelayMixer {
  private context: AudioContext | null = null
  private inputStream: MediaStream | null = null
  private microphoneSource: MediaStreamAudioSourceNode | null = null
  private microphoneGain: GainNode | null = null
  private injectionGain: GainNode | null = null
  private injectedSources = new Set<AudioBufferSourceNode>()
  private nextPcmTime = 0
  private pcmPushChain: Promise<void> = Promise.resolve()
  private sinkApplied = false

  isActive() {
    return Boolean(this.context && this.inputStream?.active)
  }

  getSinkApplied() {
    return this.sinkApplied
  }

  async start(options: { inputDeviceId?: string; outputDeviceId?: string } = {}) {
    if (this.isActive()) {
      await this.setOutputDevice(options.outputDeviceId || '')
      return { sinkApplied: this.sinkApplied }
    }

    this.stop()
    try {
      this.inputStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.inputDeviceId ? { exact: options.inputDeviceId } : undefined,
          // ASR clones this track. Keeping browser AEC enabled is essential
          // when injected TTS shares a physical output with the microphone.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
        video: false,
      })
      this.context = new AudioContext()
      await this.setOutputDevice(options.outputDeviceId || '')

      this.microphoneSource = this.context.createMediaStreamSource(this.inputStream)
      this.microphoneGain = this.context.createGain()
      this.injectionGain = this.context.createGain()
      this.microphoneGain.gain.value = 1
      this.injectionGain.gain.value = 1
      this.microphoneSource.connect(this.microphoneGain)
      this.microphoneGain.connect(this.context.destination)
      this.injectionGain.connect(this.context.destination)
      await this.context.resume()
      this.nextPcmTime = this.context.currentTime + 0.02
      return { sinkApplied: this.sinkApplied }
    } catch (error) {
      this.stop()
      throw error
    }
  }

  async setOutputDevice(outputDeviceId: string) {
    if (!this.context) {
      this.sinkApplied = false
      return
    }
    const sinkContext = this.context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }
    if (!sinkContext.setSinkId) {
      this.sinkApplied = false
      if (outputDeviceId) throw new Error('当前 Electron/Chromium 不支持将音频中转到指定输出设备')
      return
    }
    await sinkContext.setSinkId(outputDeviceId)
    this.sinkApplied = Boolean(outputDeviceId)
  }

  createInputStream() {
    if (!this.inputStream?.active) throw new Error('麦克风中转尚未启动')
    return new MediaStream(this.inputStream.getAudioTracks().map((track) => track.clone()))
  }

  async playBlob(blob: Blob) {
    const context = this.context
    const destination = this.injectionGain
    if (!context || !destination) throw new Error('麦克风中转尚未启动')
    const encoded = await blob.arrayBuffer()
    const decoded = await context.decodeAudioData(encoded.slice(0))
    const source = context.createBufferSource()
    source.buffer = decoded
    source.connect(destination)
    this.trackInjectedSource(source)
    source.start(context.currentTime + 0.01)
    return { duration: decoded.duration, sinkApplied: this.sinkApplied }
  }

  async pushPcm16(blob: Blob, sampleRate = 24000) {
    this.pcmPushChain = this.pcmPushChain.catch(() => undefined).then(async () => {
      const buffer = await blob.arrayBuffer()
      this.pushPcm16Buffer(buffer, sampleRate)
    })
    return this.pcmPushChain
  }

  async getPcmPlaybackRemainingMs() {
    await this.pcmPushChain.catch(() => undefined)
    const context = this.context
    if (!context) return 0
    return Math.max(0, (this.nextPcmTime - context.currentTime) * 1000)
  }

  private pushPcm16Buffer(buffer: ArrayBuffer, sampleRate: number) {
    const context = this.context
    const destination = this.injectionGain
    if (!context || !destination || buffer.byteLength < 2) return
    const evenLength = buffer.byteLength - (buffer.byteLength % 2)
    const pcm = new Int16Array(buffer.slice(0, evenLength))
    if (!pcm.length) return
    const audioBuffer = context.createBuffer(1, pcm.length, sampleRate)
    const channel = audioBuffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768))
    }
    const source = context.createBufferSource()
    source.buffer = audioBuffer
    source.connect(destination)
    this.trackInjectedSource(source)
    const startAt = Math.max(context.currentTime + 0.01, this.nextPcmTime)
    source.start(startAt)
    this.nextPcmTime = startAt + audioBuffer.duration
  }

  private trackInjectedSource(source: AudioBufferSourceNode) {
    this.injectedSources.add(source)
    source.onended = () => this.injectedSources.delete(source)
  }

  stopInjectedAudio() {
    for (const source of this.injectedSources) {
      try { source.stop() } catch { /* source may already have ended */ }
    }
    this.injectedSources.clear()
    this.nextPcmTime = this.context?.currentTime || 0
    this.pcmPushChain = Promise.resolve()
  }

  stop() {
    this.stopInjectedAudio()
    try { this.microphoneSource?.disconnect() } catch { /* ignore */ }
    try { this.microphoneGain?.disconnect() } catch { /* ignore */ }
    try { this.injectionGain?.disconnect() } catch { /* ignore */ }
    this.inputStream?.getTracks().forEach((track) => track.stop())
    this.context?.close().catch(() => undefined)
    this.context = null
    this.inputStream = null
    this.microphoneSource = null
    this.microphoneGain = null
    this.injectionGain = null
    this.nextPcmTime = 0
    this.sinkApplied = false
  }
}

export const audioRelayMixer = new AudioRelayMixer()

/** Windows-only isolated hardware verification used by --amadeus-e2e. */
export async function runAudioRelayDeviceE2E() {
  const bootstrap = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    bootstrap.getTracks().forEach((track) => track.stop())
    const inputs = devices.filter((d) => d.kind === 'audioinput')
    const outputs = devices.filter((d) => d.kind === 'audiooutput')
    const dji = inputs.find((d) => /dji\s*mic\s*mini/i.test(d.label))
    const cableInput = outputs.find((d) => /^cable\s*input\b/i.test(d.label))
    const cableOutput = inputs.find((d) => /cable\s*output/i.test(d.label))
    return { passed: Boolean(dji && cableInput && cableOutput), dji: dji?.label || '', cableInput: cableInput?.label || '', cableOutput: cableOutput?.label || '' }
  } finally {
    bootstrap.getTracks().forEach((track) => track.stop())
  }
}

export class Pcm16ChunkPlayer {
  private context: AudioContext | null = null
  private nextTime = 0
  private pushChain: Promise<void> = Promise.resolve()
  private readonly sampleRate: number
  private readonly outputDeviceId?: string

  constructor(sampleRate = 24000, outputDeviceId?: string) {
    this.sampleRate = sampleRate
    this.outputDeviceId = outputDeviceId
  }

  async start() {
    if (this.context) return
    this.context = new AudioContext({ sampleRate: this.sampleRate })
    const sinkContext = this.context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }
    if (this.outputDeviceId && sinkContext.setSinkId) {
      await sinkContext.setSinkId(this.outputDeviceId)
    }
    this.nextTime = this.context.currentTime + 0.02
  }

  async push(blob: Blob) {
    this.pushChain = this.pushChain.catch(() => undefined).then(async () => {
      const buffer = await blob.arrayBuffer()
      this.pushBuffer(buffer)
    })
    return this.pushChain
  }

  async getPlaybackRemainingMs() {
    await this.pushChain.catch(() => undefined)
    if (!this.context) return 0
    return Math.max(0, (this.nextTime - this.context.currentTime) * 1000)
  }

  pushBuffer(buffer: ArrayBuffer) {
    if (!this.context || buffer.byteLength < 2) return
    const evenLength = buffer.byteLength - (buffer.byteLength % 2)
    const pcm = new Int16Array(buffer.slice(0, evenLength))
    if (!pcm.length) return
    const audioBuffer = this.context.createBuffer(1, pcm.length, this.sampleRate)
    const channel = audioBuffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768))
    }
    const source = this.context.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.context.destination)
    const startAt = Math.max(this.context.currentTime + 0.01, this.nextTime)
    source.start(startAt)
    this.nextTime = startAt + audioBuffer.duration
  }

  stop() {
    this.context?.close().catch(() => undefined)
    this.context = null
    this.nextTime = 0
    this.pushChain = Promise.resolve()
  }
}

export async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

// ── WebSocket URL builder ───────────────────────────────────────────────────

function buildWsUrl(serverUrl: string, path: string): string {
  const trimmed = (serverUrl || '').trim()
  // Empty → same-origin (e.g. through Vite proxy)
  if (!trimmed || trimmed === '/') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.host}${path}`
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '').replace(/^http/i, 'ws') + path
}

function buildWsUrlCandidates(serverUrl: string, path: string): string[] {
  const candidates: string[] = []
  const add = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }
  add(buildWsUrl(serverUrl, path))
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    add(`${wsProtocol}//${window.location.host}${path}`)
  }
  return candidates
}

function describeWsFailure(attempted: string[]) {
  const mixedContent = window.location.protocol === 'https:' && attempted.some((url) => url.startsWith('ws://'))
  const tried = attempted.join('，')
  if (mixedContent) {
    return `WebSocket 连接失败，当前页面是 HTTPS，浏览器会拦截 ws:// 明文连接。已尝试：${tried}。请改用 wss:// 后端地址，或用 http:// 页面打开前端。`
  }
  // Build specific suggestions based on the URLs attempted
  const suggestions: string[] = []
  const hasRemote = attempted.some((url) => !url.includes('localhost') && !url.includes('127.0.0.1'))
  const hasLocal = attempted.some((url) => url.includes('localhost') || url.includes('127.0.0.1'))
  if (hasRemote) {
    suggestions.push('远程服务器需要配置反向代理（Nginx/Caddy）支持 WebSocket Upgrade 头')
    suggestions.push('Nginx 示例：proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";')
  }
  if (hasLocal) {
    suggestions.push('请确认后端服务已启动：cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000')
    suggestions.push('请确认 Vite 开发服务器已启动：cd frontend/desktop && npm run dev')
  }
  if (!hasRemote && !hasLocal) {
    suggestions.push('请确认后端服务地址配置正确，且服务已启动')
  }
  const extra = suggestions.length > 0 ? `\n诊断建议：\n${suggestions.map((s) => `  • ${s}`).join('\n')}` : ''
  return `WebSocket 连接失败。已尝试：${tried}。${extra}`
}

/** Pre-flight HTTP health check to verify server reachability before WS attempt. */
async function preflightHealthCheck(wsUrl: string, timeoutMs: number = 5000): Promise<{ ok: boolean; message: string }> {
  const httpUrl = wsUrl.replace(/^ws/i, 'http')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const resp = await fetch(httpUrl.replace(/\/v1\/stream.*$/, '/v1/health'), {
      method: 'GET',
      signal: controller.signal,
      // Simple mode to avoid CORS preflight issues
      mode: 'cors',
    })
    clearTimeout(timer)
    if (resp.ok) {
      return { ok: true, message: `HTTP 健康检查通过 (${resp.status})` }
    }
    return { ok: false, message: `HTTP 健康检查返回 ${resp.status}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `HTTP 健康检查失败: ${msg}` }
  }
}

// ── PCM Streamer for WebSocket ASR ──────────────────────────────────────────

type PcmCallback = (pcm: Int16Array, sampleRate: number) => void

function isLikelyLoopbackInput(label: string) {
  return /monitor|stereo\s*mix|what\s*u\s*hear|loopback|立体声混音|输出监听/i.test(label)
}

export class PcmStreamer {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private readonly onPcm: PcmCallback
  private readonly rejectLoopbackInput: boolean
  private targetSampleRate = 16000
  private outputPlaybackActive = false
  private echoCancellationEnabled: boolean | null = null

  constructor(onPcm: PcmCallback, options: { rejectLoopbackInput?: boolean } = {}) {
    this.onPcm = onPcm
    this.rejectLoopbackInput = Boolean(options.rejectLoopbackInput)
  }

  async start(deviceId?: string, inputStream?: MediaStream) {
    if (this.stream) throw new Error('PCM stream already active')
    this.stream = inputStream || await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    const inputLabel = this.stream.getAudioTracks()[0]?.label || ''
    if (this.rejectLoopbackInput && isLikelyLoopbackInput(inputLabel)) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
      throw new Error(`实时 ASR + TTS 不能使用回环输入设备：${inputLabel}`)
    }
    const echoCancellation = this.stream.getAudioTracks()[0]?.getSettings().echoCancellation
    this.echoCancellationEnabled = typeof echoCancellation === 'boolean' ? echoCancellation : null

    this.audioContext = new AudioContext({ sampleRate: 16000 })
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    // Use ScriptProcessorNode for broad compatibility; AudioWorklet would be ideal
    this.processor = this.audioContext.createScriptProcessor(512, 1, 1)
    this.processor.onaudioprocess = (event) => {
      // If the runtime explicitly reports that AEC is unavailable, use a
      // half-duplex fallback during TTS playback. AEC-capable devices remain
      // full duplex and the backend text guard catches residual echoes.
      if (this.outputPlaybackActive && this.echoCancellationEnabled === false) return
      const input = event.inputBuffer.getChannelData(0)
      // Convert Float32 [-1,1] → Int16
      const int16 = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
      }
      this.onPcm(int16, this.audioContext?.sampleRate || 16000)
    }
    this.source.connect(this.processor)
    // Connect through a silent gain node — ScriptProcessorNode needs to be
    // connected to fire onaudioprocess, but we must NOT feed mic to speakers.
    const silenceGain = this.audioContext.createGain()
    silenceGain.gain.value = 0
    this.processor.connect(silenceGain)
    silenceGain.connect(this.audioContext.destination)
  }

  setOutputPlaybackActive(active: boolean) {
    this.outputPlaybackActive = active
  }

  stop() {
    try { this.processor?.disconnect() } catch { /* ignore */ }
    try { this.source?.disconnect() } catch { /* ignore */ }
    this.audioContext?.close().catch(() => {})
    this.stream?.getTracks().forEach((track) => track.stop())
    this.processor = null
    this.source = null
    this.audioContext = null
    this.stream = null
    this.outputPlaybackActive = false
    this.echoCancellationEnabled = null
  }
}

// ── WebSocket Streaming ASR Client ──────────────────────────────────────────

type StreamEvent =
  | { type: 'accepted' | 'ready' | 'configured' }
  | { type: 'loading'; message: string }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; language: string | null }
  | { type: 'speech_start' }
  | { type: 'speech_end' }
  | { type: 'error'; message: string }
  | { type: 'closed'; intentional: boolean }

export class StreamingASRClient {
  private ws: WebSocket | null = null
  private readonly urls: string[]
  private readonly onEvent: (event: StreamEvent) => void
  private pcmStreamer: PcmStreamer | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private speechStartedAt = 0
  private firstPartialSeen = false
  private sessionTrace: TelemetryTrace | null = null
  private utteranceTrace: TelemetryTrace | null = null
  private stoppedByUser = false
  private closedEmitted = false

  constructor(serverUrl: string, onEvent: (event: StreamEvent) => void) {
    this.urls = buildWsUrlCandidates(serverUrl, '/v1/stream')
    this.onEvent = onEvent
  }

  async start(config: {
    engine?: string
    language?: string
    deviceId?: string
    inputStream?: MediaStream
    userId?: string
  }) {
    this.startedAt = performance.now()
    this.stoppedByUser = false
    this.closedEmitted = false
    this.sessionTrace = startTelemetryTrace('websocket', '实时 ASR 会话', config.engine || 'x-asr')
    this.firstPartialSeen = false
    const attempted: string[] = []

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string)
        if (data.type === 'accepted') {
          // Backend confirmed WebSocket handshake; model loading may still be in progress.
          if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, 'WebSocket 已接受', { detail: '等待模型加载…' })
          this.onEvent({ type: 'accepted' })
        } else if (data.type === 'loading') {
          // Backend is still loading models; show progress.
          if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, '模型加载中', { detail: data.message || `已等待 ${data.elapsed_s || 0}s` })
          this.onEvent({ type: 'loading', message: data.message || `模型加载中，已等待 ${data.elapsed_s || 0}s` })
        } else if (data.type === 'ready' || data.type === 'configured') {
          if (data.type === 'configured') {
            if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, 'ASR 预热完成')
            startPcmCapture()
          }
          this.onEvent({ type: data.type })
        } else if (data.type === 'partial') {
          if (!this.firstPartialSeen) {
            this.firstPartialSeen = true
            recordTelemetry({ category: 'asr', operation: '首个局部结果', durationMs: performance.now() - (this.speechStartedAt || this.startedAt), status: 'ok', detail: data.engine || 'stream' })
            if (this.utteranceTrace) recordTelemetryStage(this.utteranceTrace, 'ASR 首 token', { detail: data.text || '' })
          }
          this.onEvent({ type: 'partial', text: data.text || '' })
        } else if (data.type === 'final') {
          recordTelemetry({ category: 'asr', operation: '流式最终结果', durationMs: performance.now() - (this.speechStartedAt || this.startedAt), status: 'ok', detail: data.engine || 'stream' })
          this.onEvent({ type: 'final', text: data.text || '', language: data.language || null })
          if (this.utteranceTrace) finishTelemetryTrace(this.utteranceTrace, `最终文本 ${String(data.text || '').length} 字`)
          this.utteranceTrace = null
        } else if (data.type === 'speech_start') {
          this.speechStartedAt = performance.now()
          this.firstPartialSeen = false
          this.utteranceTrace = startTelemetryTrace('asr', '实时 ASR 话语', data.engine || 'stream')
          recordTelemetryStage(this.utteranceTrace, 'VAD 检测到说话')
          this.onEvent({ type: 'speech_start' })
        } else if (data.type === 'speech_end') {
          if (this.utteranceTrace) recordTelemetryStage(this.utteranceTrace, 'VAD 语音结束')
          this.onEvent({ type: 'speech_end' })
        } else if (data.type === 'error') {
          recordTelemetry({ category: 'asr', operation: '流式识别', status: 'error', detail: data.message || 'Stream error' })
          this.onEvent({ type: 'error', message: data.message || 'Stream error' })
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    let captureStarted = false
    const startPcmCapture = () => {
      if (captureStarted || this.stoppedByUser) return
      captureStarted = true
      this.pcmStreamer = new PcmStreamer((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      })
      this.pcmStreamer.start(config.deviceId, config.inputStream).catch((error) => {
        this.onEvent({ type: 'error', message: error instanceof Error ? error.message : '无法启动麦克风实时音频流' })
        this.ws?.close()
      })
    }
    const emitClosed = () => {
      if (this.closedEmitted) return
      this.closedEmitted = true
      this.onEvent({ type: 'closed', intentional: this.stoppedByUser })
    }
    const attachConnectedHandlers = (ws: WebSocket, wsUrl: string) => {
      ws.onmessage = handleMessage
      ws.onclose = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        this.pcmStreamer?.stop()
        this.pcmStreamer = null
        emitClosed()
      }
      ws.onerror = () => {
        recordTelemetry({ category: 'websocket', operation: 'ASR WebSocket 连接', status: 'error', detail: wsUrl })
        this.onEvent({ type: 'error', message: `WebSocket 已连接后发生错误：${wsUrl}。请检查后端实时识别日志。` })
      }
    }

    const connect = (index: number) => {
      const wsUrl = this.urls[index]
      try {
        new URL(wsUrl)
      } catch {
        if (index + 1 < this.urls.length) {
          connect(index + 1)
        } else {
          this.onEvent({ type: 'error', message: `无效 WebSocket 地址: ${wsUrl}` })
        }
        return
      }

      attempted.push(wsUrl)
      let opened = false
      let handledFailure = false
      let ws: WebSocket
      const failBeforeOpen = (detail?: string) => {
        if (handledFailure || opened) return
        handledFailure = true
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        if (this.stoppedByUser) {
          this.ws = null
          return
        }
        if (index + 1 < this.urls.length) {
          connect(index + 1)
          return
        }
        this.ws = null
        recordTelemetry({ category: 'websocket', operation: 'ASR WebSocket 连接', status: 'error', detail: attempted.join(', ') })
        this.onEvent({
          type: 'error',
          message: detail
            ? `${detail}。${describeWsFailure(attempted)}`
            : describeWsFailure(attempted),
        })
      }

      try {
        ws = new WebSocket(wsUrl)
      } catch (error) {
        failBeforeOpen(`无法创建 WebSocket 连接: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      this.ws = ws
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.connectTimer = setTimeout(() => {
        if (!opened && ws.readyState === WebSocket.CONNECTING) {
          ws.close()
          failBeforeOpen('WebSocket 连接超时 (15s)')
        }
      }, 15000)

      ws.onopen = () => {
        opened = true
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        attachConnectedHandlers(ws, wsUrl)
        recordTelemetry({ category: 'websocket', operation: 'ASR WebSocket 连接', durationMs: performance.now() - this.startedAt, status: 'ok', detail: wsUrl })
        if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, 'WebSocket 已连接', { detail: wsUrl })
        ws.send(JSON.stringify({
          type: 'config',
          engine: config.engine || 'x-asr',
          language: config.language || 'zh',
          user_id: config.userId || '',
        }))
      }
      ws.onmessage = handleMessage
      ws.onclose = () => failBeforeOpen()
      ws.onerror = () => {
        ws.close()
        failBeforeOpen()
      }
    }
    connect(0)
  }

  stop() {
    this.stoppedByUser = true
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    const ws = this.ws
    this.ws = null
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'end' })) } catch { /* closing */ }
    }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000, 'client stop')
    if (!this.closedEmitted) {
      this.closedEmitted = true
      this.onEvent({ type: 'closed', intentional: true })
    }
  }
}

export type VoiceTTSStreamTiming = {
  asr_sec?: number
  tts_sec?: number
  higgs_network_sec?: number
  total_sec?: number
  tts_elapsed_sec?: number
  tts_first_chunk_sec?: number
  tts_first_token_sec?: number
  e2e_first_audio_sec?: number
}

export type VoiceTTSStreamEvent =
  | { type: 'accepted' | 'ready' | 'configured' | 'speech_start' | 'speech_end' }
  | { type: 'loading'; message: string }
  | { type: 'closed'; intentional: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; language: string | null }
  | { type: 'tts_start'; text: string; jobId?: string | number | null; segmentIndex?: number; timing: VoiceTTSStreamTiming; sourceEvent?: string; speculative?: boolean }
  | { type: 'tts_chunk'; text: string; jobId?: string | number | null; segmentIndex?: number; audio: Blob; mediaType: string; seq: number; timing: VoiceTTSStreamTiming; sampleRate?: string | null; sourceEvent?: string; speculative?: boolean }
  | { type: 'tts_done'; text: string; jobId?: string | number | null; segmentIndex?: number; timing: VoiceTTSStreamTiming; chunks: number; audioBytes: number; trimmedSilenceMs?: number; tailSilenceAborted?: boolean; sampleRate?: string | null; mediaType?: string; sourceEvent?: string; speculative?: boolean }
  | { type: 'tts'; text: string; jobId?: string | number | null; audio: Blob; mediaType: string; timing: VoiceTTSStreamTiming; sampleRate?: string | null; sourceEvent?: string; speculative?: boolean }
  | { type: 'echo_suppressed'; text: string; matchedText: string; windowSec: number }
  | { type: 'error'; message: string }

function parseStreamTiming(data: any): VoiceTTSStreamTiming {
  return {
    asr_sec: Number(data.timing?.asr_sec || 0),
    tts_sec: Number(data.timing?.tts_sec || 0),
    higgs_network_sec: Number(data.timing?.higgs_network_sec || 0),
    total_sec: Number(data.timing?.total_sec || 0),
    tts_elapsed_sec: Number(data.timing?.tts_elapsed_sec || 0),
    tts_first_chunk_sec: Number(data.timing?.tts_first_chunk_sec || 0),
    tts_first_token_sec: Number(data.timing?.tts_first_token_sec || data.timing?.tts_first_chunk_sec || 0),
    e2e_first_audio_sec: Number(data.timing?.e2e_first_audio_sec || 0),
  }
}

export class VoiceTTSStreamingClient {
  private ws: WebSocket | null = null
  private readonly urls: string[]
  private readonly onEvent: (event: VoiceTTSStreamEvent) => void
  private pcmStreamer: PcmStreamer | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private stoppedByUser = false
  private sessionTrace: TelemetryTrace | null = null
  private utteranceTrace: TelemetryTrace | null = null
  private firstPartialSeen = false
  private firstAudioSeen = false
  private echoGuardReleaseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(serverUrl: string, onEvent: (event: VoiceTTSStreamEvent) => void) {
    this.urls = buildWsUrlCandidates(serverUrl, '/v1/tts/higgs/stream')
    this.onEvent = onEvent
  }

  async start(config: {
    engine?: string
    language?: string
    deviceId?: string
    inputStreamFactory?: () => MediaStream
    higgsBaseUrl: string
    provider?: 'local' | 'boson'
    apiToken?: string
    model?: string
    voice?: string
    responseFormat?: string
    speed?: number
    temperature?: number
    topP?: number
    topK?: number
    seed?: number
    maxNewTokens?: number
    referenceAudio?: string
    referenceUrl?: string
    referenceText?: string
    referenceCodesJson?: string
    emotion?: string
    style?: string
    prosodySpeed?: string
    pitch?: string
    expressiveness?: string
    initialCodecChunkFrames?: number
    stream?: boolean
    speculativePartialTts?: boolean
  }) {
    this.stoppedByUser = false
    this.sessionTrace = startTelemetryTrace('websocket', '实时变声会话', config.engine || 'x-asr')
    const attempted: string[] = []
    let captureStarted = false
    const startPcmCapture = () => {
      if (captureStarted) return
      captureStarted = true
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.pcmStreamer = new PcmStreamer((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      }, { rejectLoopbackInput: true })
      this.pcmStreamer.start(config.deviceId, config.inputStreamFactory?.()).catch((error) => {
        this.onEvent({ type: 'error', message: error instanceof Error ? error.message : 'Cannot start microphone stream' })
      })
    }
    const sendConfig = () => {
      this.ws?.send(JSON.stringify({
        type: 'config',
        engine: config.engine || 'x-asr',
        language: config.language || 'zh',
        higgs_base_url: config.higgsBaseUrl || 'http://localhost:8002',
        provider: config.provider || 'local',
        api_token: config.apiToken || '',
        model: config.model || 'higgs-audio-v3-tts',
        voice: config.voice || 'Elysia',
        response_format: config.responseFormat || 'wav',
        speed: config.speed ?? 1,
        temperature: config.temperature ?? 0.7,
        top_p: config.topP ?? 0.95,
        top_k: config.topK ?? 50,
        seed: config.seed ?? -1,
        max_new_tokens: config.maxNewTokens ?? 2048,
        reference_audio: config.referenceAudio || '',
        reference_url: config.referenceUrl || '',
        reference_text: config.referenceText || '',
        reference_codes_json: config.referenceCodesJson || '',
        emotion: config.emotion || '',
        style: config.style || '',
        prosody_speed: config.prosodySpeed || '',
        pitch: config.pitch || '',
        expressiveness: config.expressiveness || '',
        initial_codec_chunk_frames: config.initialCodecChunkFrames ?? 1,
        stream: config.stream ?? true,
        speculative_partial_tts: config.speculativePartialTts ?? true,
      }))
    }

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string)
        if (data.type === 'accepted') {
          if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, 'WebSocket 已接受', { detail: '等待模型加载…' })
          this.onEvent({ type: 'accepted' })
        } else if (data.type === 'loading') {
          if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, '模型加载中', { detail: data.message || `已等待 ${data.elapsed_s || 0}s` })
          this.onEvent({ type: 'loading', message: data.message || `模型加载中，已等待 ${data.elapsed_s || 0}s` })
        } else if (data.type === 'ready' || data.type === 'configured' || data.type === 'speech_start' || data.type === 'speech_end') {
          if (data.type === 'configured') {
            if (this.sessionTrace) recordTelemetryStage(this.sessionTrace, 'ASR/TTS 预热完成')
            startPcmCapture()
          }
          if (data.type === 'speech_start') {
            this.utteranceTrace = startTelemetryTrace('tts', '实时 VAD→ASR→TTS', config.engine || 'x-asr')
            this.firstPartialSeen = false
            this.firstAudioSeen = false
            recordTelemetryStage(this.utteranceTrace, 'VAD 检测到说话')
          }
          if (data.type === 'speech_end' && this.utteranceTrace) recordTelemetryStage(this.utteranceTrace, 'VAD 语音结束')
          this.onEvent({ type: data.type })
        } else if (data.type === 'partial') {
          if (!this.firstPartialSeen && this.utteranceTrace) {
            this.firstPartialSeen = true
            recordTelemetryStage(this.utteranceTrace, 'ASR 首 token', { detail: data.text || '' })
          }
          this.onEvent({ type: 'partial', text: data.text || '' })
        } else if (data.type === 'final') {
          if (this.utteranceTrace) recordTelemetryStage(this.utteranceTrace, 'ASR 最终结果', { detail: data.text || '' })
          this.onEvent({ type: 'final', text: data.text || '', language: data.language || null })
        } else if (data.type === 'tts_start') {
          if (this.utteranceTrace) recordTelemetryStage(this.utteranceTrace, 'TTS 请求开始', { backendMs: Number(data.timing?.asr_sec || 0) * 1000, detail: data.source_event || 'final' })
          this.onEvent({
            type: 'tts_start',
            text: data.text || '',
            jobId: data.job_id ?? null,
            segmentIndex: Number(data.segment_index || 0) || undefined,
            sourceEvent: data.source_event || undefined,
            speculative: Boolean(data.speculative),
            timing: parseStreamTiming(data),
          })
        } else if (data.type === 'tts_chunk') {
          this.setOutputPlaybackActive(true)
          if (Number(data.seq || 0) === 1) {
            recordTelemetry({ category: 'tts', operation: '流式 TTS 首包音频', durationMs: Number(data.timing?.e2e_first_audio_sec || data.timing?.tts_first_chunk_sec || 0) * 1000, status: 'ok', detail: data.media_type || 'audio/pcm' })
            if (this.utteranceTrace && !this.firstAudioSeen) {
              this.firstAudioSeen = true
              recordTelemetryStage(this.utteranceTrace, 'TTS 首 token / 首音频接收', {
                backendMs: Number(data.timing?.tts_first_token_sec || data.timing?.tts_first_chunk_sec || 0) * 1000,
                detail: data.media_type || 'audio/pcm',
              })
            }
          }
          this.onEvent({
            type: 'tts_chunk',
            text: data.text || '',
            jobId: data.job_id ?? null,
            segmentIndex: Number(data.segment_index || 0) || undefined,
            audio: base64ToBlob(data.audio_b64 || '', data.media_type || 'audio/pcm'),
            mediaType: data.media_type || 'audio/pcm',
            sampleRate: data.sample_rate || null,
            seq: Number(data.seq || 0),
            sourceEvent: data.source_event || undefined,
            speculative: Boolean(data.speculative),
            timing: parseStreamTiming(data),
          })
        } else if (data.type === 'tts_done') {
          recordTelemetry({ category: 'tts', operation: '流式 TTS 完成', durationMs: Number(data.timing?.total_sec || data.timing?.tts_sec || 0) * 1000, status: 'ok', detail: `${Number(data.audio_bytes || 0)} bytes · 边界静音裁剪 ${Number(data.trimmed_silence_ms || 0).toFixed(0)}ms${data.tail_silence_aborted ? ' · 尾静音提前结束' : ''}` })
          if (this.utteranceTrace) finishTelemetryTrace(this.utteranceTrace, `${Number(data.audio_bytes || 0)} bytes`)
          this.utteranceTrace = null
          this.onEvent({
            type: 'tts_done',
            text: data.text || '',
            jobId: data.job_id ?? null,
            segmentIndex: Number(data.segment_index || 0) || undefined,
            chunks: Number(data.chunks || 0),
            audioBytes: Number(data.audio_bytes || 0),
            trimmedSilenceMs: Number(data.trimmed_silence_ms || 0),
            tailSilenceAborted: Boolean(data.tail_silence_aborted),
            sampleRate: data.sample_rate || null,
            mediaType: data.media_type || undefined,
            sourceEvent: data.source_event || undefined,
            speculative: Boolean(data.speculative),
            timing: parseStreamTiming(data),
          })
        } else if (data.type === 'tts') {
          this.onEvent({
            type: 'tts',
            text: data.text || '',
            jobId: data.job_id ?? null,
            audio: base64ToBlob(data.audio_b64 || '', data.media_type || 'audio/wav'),
            mediaType: data.media_type || 'audio/wav',
            sampleRate: data.sample_rate || null,
            sourceEvent: data.source_event || undefined,
            speculative: Boolean(data.speculative),
            timing: parseStreamTiming(data),
          })
        } else if (data.type === 'echo_suppressed') {
          this.onEvent({
            type: 'echo_suppressed',
            text: data.text || '',
            matchedText: data.matched_tts_text || '',
            windowSec: Number(data.window_sec || 0),
          })
        } else if (data.type === 'error') {
          this.onEvent({ type: 'error', message: data.message || 'Stream error' })
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    const attachConnectedHandlers = (ws: WebSocket) => {
      ws.onmessage = handleMessage
      ws.onclose = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        this.pcmStreamer?.stop()
        this.onEvent({ type: 'closed', intentional: this.stoppedByUser })
      }
      ws.onerror = () => {
        this.onEvent({ type: 'error', message: 'WebSocket 已连接后发生错误，请检查后端日志。' })
      }
    }

    const connect = (index: number) => {
      const wsUrl = this.urls[index]
      try {
        new URL(wsUrl)
      } catch {
        this.onEvent({ type: 'error', message: `无效 WebSocket 地址: ${wsUrl}` })
        return
      }
      attempted.push(wsUrl)
      let opened = false
      let handledFailure = false
      let ws: WebSocket
      const failBeforeOpen = (message?: string) => {
        if (handledFailure || opened) return
        handledFailure = true
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        if (index + 1 < this.urls.length) {
          connect(index + 1)
        } else {
          this.ws = null
          this.onEvent({ type: 'error', message: message || describeWsFailure(attempted) })
        }
      }
      try {
        ws = new WebSocket(wsUrl)
      } catch (err) {
        failBeforeOpen(`无法创建 WebSocket 连接: ${err instanceof Error ? err.message : String(err)} (${wsUrl})`)
        return
      }
      this.ws = ws
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.connectTimer = setTimeout(() => {
        if (!opened && ws.readyState === WebSocket.CONNECTING) {
          ws.close()
          failBeforeOpen(`WebSocket 连接超时 (15s)。${describeWsFailure(attempted)}`)
        }
      }, 15000)

      ws.onopen = () => {
        opened = true
        attachConnectedHandlers(ws)
        sendConfig()
      }
      ws.onmessage = handleMessage
      ws.onclose = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
        if (opened) {
          this.pcmStreamer?.stop()
          this.onEvent({ type: 'closed', intentional: this.stoppedByUser })
          return
        }
        if (index + 1 < this.urls.length) {
          failBeforeOpen()
        } else {
          failBeforeOpen()
        }
      }
      ws.onerror = () => {
        ws.close()
        failBeforeOpen()
      }
    }
    connect(0)
  }

  stop() {
    this.stoppedByUser = true
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }))
    }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
    if (this.echoGuardReleaseTimer) clearTimeout(this.echoGuardReleaseTimer)
    this.echoGuardReleaseTimer = null
    setTimeout(() => {
      this.ws?.close()
      this.ws = null
    }, 200)
  }

  finishInput() {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }))
    }
  }

  close() {
    this.stoppedByUser = true
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
    if (this.echoGuardReleaseTimer) clearTimeout(this.echoGuardReleaseTimer)
    this.echoGuardReleaseTimer = null
    this.ws?.close()
    this.ws = null
  }

  setOutputPlaybackActive(active: boolean, releaseDelayMs = 0) {
    if (this.echoGuardReleaseTimer) clearTimeout(this.echoGuardReleaseTimer)
    this.echoGuardReleaseTimer = null
    if (active || releaseDelayMs <= 0) {
      this.pcmStreamer?.setOutputPlaybackActive(active)
      return
    }
    this.echoGuardReleaseTimer = setTimeout(() => {
      this.pcmStreamer?.setOutputPlaybackActive(false)
      this.echoGuardReleaseTimer = null
    }, releaseDelayMs)
  }
}
