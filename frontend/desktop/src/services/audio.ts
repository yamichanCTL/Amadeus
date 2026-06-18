export class AudioRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: BlobPart[] = []
  private startedAt = 0

  async start(deviceId?: string) {
    if (this.recorder) throw new Error('录音已在进行中')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    })

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    this.chunks = []
    this.startedAt = Date.now()
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start()
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
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    return { blob: new Blob(this.chunks, { type: mimeType }), durationSec, mimeType }
  }

  cancel() {
    this.recorder?.stop()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    this.chunks = []
  }
}

export class AudioSegmentStreamer {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private timer: number | null = null
  private readonly onSegment: (blob: Blob) => void

  constructor(onSegment: (blob: Blob) => void) {
    this.onSegment = onSegment
  }

  async start(source: 'speaker' | 'microphone', chunkSec: number, deviceId?: string) {
    if (this.recorder) throw new Error('实时字幕已在运行')
    this.stream =
      source === 'speaker'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined }, video: false })

    this.stream.getVideoTracks().forEach((track) => track.stop())
    this.startRecorder()
    this.timer = window.setInterval(() => this.rotateRecorder(), Math.max(2, chunkSec) * 1000)
  }

  stop() {
    if (this.timer) window.clearInterval(this.timer)
    this.timer = null
    this.recorder?.stop()
    this.recorder = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  private startRecorder() {
    if (!this.stream) return
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      if (chunks.length > 0) this.onSegment(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
    }
    this.recorder = recorder
    recorder.start()
  }

  private rotateRecorder() {
    if (!this.recorder || this.recorder.state === 'inactive') return
    this.recorder.stop()
    this.startRecorder()
  }
}

export async function listAudioInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audioinput')
}

export async function listAudioOutputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audiooutput')
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

// ── PCM Streamer for WebSocket ASR ──────────────────────────────────────────

type PcmCallback = (pcm: Int16Array, sampleRate: number) => void

export class PcmStreamer {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private readonly onPcm: PcmCallback
  private targetSampleRate = 16000

  constructor(onPcm: PcmCallback) {
    this.onPcm = onPcm
  }

  async start(deviceId?: string) {
    if (this.stream) throw new Error('PCM stream already active')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })

    this.audioContext = new AudioContext({ sampleRate: 16000 })
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    // Use ScriptProcessorNode for broad compatibility; AudioWorklet would be ideal
    this.processor = this.audioContext.createScriptProcessor(1024, 1, 1)
    this.processor.onaudioprocess = (event) => {
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

  stop() {
    try { this.processor?.disconnect() } catch { /* ignore */ }
    try { this.source?.disconnect() } catch { /* ignore */ }
    this.audioContext?.close().catch(() => {})
    this.stream?.getTracks().forEach((track) => track.stop())
    this.processor = null
    this.source = null
    this.audioContext = null
    this.stream = null
  }
}

// ── WebSocket Streaming ASR Client ──────────────────────────────────────────

type StreamEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; language: string | null }
  | { type: 'speech_start' }
  | { type: 'speech_end' }
  | { type: 'error'; message: string }
  | { type: 'closed' }

export class StreamingASRClient {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly onEvent: (event: StreamEvent) => void
  private pcmStreamer: PcmStreamer | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(serverUrl: string, onEvent: (event: StreamEvent) => void) {
    this.url = buildWsUrl(serverUrl, '/v1/stream')
    this.onEvent = onEvent
  }

  async start(config: {
    engine?: string
    finalEngine?: string
    language?: string
    deviceId?: string
  }) {
    // Validate URL before attempting connection
    let wsUrl: string
    try {
      wsUrl = this.url
      new URL(wsUrl)
    } catch {
      this.onEvent({ type: 'error', message: `无效 WebSocket 地址: ${this.url}` })
      return
    }

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (err) {
      this.onEvent({ type: 'error', message: `无法创建 WebSocket 连接: ${err instanceof Error ? err.message : String(err)} (${wsUrl})` })
      return
    }

    // Connection timeout (5s)
    this.connectTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws?.close()
        this.ws = null
        this.onEvent({ type: 'error', message: `WebSocket 连接超时 (5s): ${wsUrl}` })
      }
    }, 5000)

    this.ws.onopen = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.ws?.send(JSON.stringify({
        type: 'config',
        engine: config.engine || 'sensevoice',
        final_engine: config.finalEngine || 'sensevoice',
        language: config.language || 'zh',
      }))
      this.pcmStreamer = new PcmStreamer((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      })
      this.pcmStreamer.start(config.deviceId)
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string)
        if (data.type === 'partial') {
          this.onEvent({ type: 'partial', text: data.text || '' })
        } else if (data.type === 'final') {
          this.onEvent({ type: 'final', text: data.text || '', language: data.language || null })
        } else if (data.type === 'speech_start') {
          this.onEvent({ type: 'speech_start' })
        } else if (data.type === 'speech_end') {
          this.onEvent({ type: 'speech_end' })
        } else if (data.type === 'error') {
          this.onEvent({ type: 'error', message: data.message || 'Stream error' })
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    this.ws.onclose = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.pcmStreamer?.stop()
      this.onEvent({ type: 'closed' })
    }

    this.ws.onerror = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.onEvent({ type: 'error', message: `WebSocket 连接失败 (${wsUrl}) — 请确认后台服务已启动` })
    }
  }

  stop() {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }))
    }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
    setTimeout(() => {
      this.ws?.close()
      this.ws = null
    }, 200)
  }
}

export type VoiceTTSStreamTiming = {
  asr_sec: number
  tts_sec: number
  higgs_network_sec: number
  total_sec: number
}

export type VoiceTTSStreamEvent =
  | { type: 'ready' | 'configured' | 'speech_start' | 'speech_end' }
  | { type: 'closed'; intentional: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; language: string | null }
  | { type: 'tts'; text: string; audio: Blob; mediaType: string; timing: VoiceTTSStreamTiming; sampleRate?: string | null }
  | { type: 'error'; message: string }

export class VoiceTTSStreamingClient {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly onEvent: (event: VoiceTTSStreamEvent) => void
  private pcmStreamer: PcmStreamer | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private stoppedByUser = false

  constructor(serverUrl: string, onEvent: (event: VoiceTTSStreamEvent) => void) {
    this.url = buildWsUrl(serverUrl, '/v1/tts/higgs/stream')
    this.onEvent = onEvent
  }

  async start(config: {
    engine?: string
    finalEngine?: string
    language?: string
    deviceId?: string
    higgsBaseUrl: string
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
  }) {
    this.stoppedByUser = false
    // Validate URL before attempting connection
    let wsUrl: string
    try {
      wsUrl = this.url
      new URL(wsUrl) // throws if invalid
    } catch {
      this.onEvent({ type: 'error', message: `无效 WebSocket 地址: ${this.url}` })
      return
    }

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (err) {
      this.onEvent({ type: 'error', message: `无法创建 WebSocket 连接: ${err instanceof Error ? err.message : String(err)} (${wsUrl})` })
      return
    }

    // Connection timeout (5s)
    this.connectTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws?.close()
        this.ws = null
        this.onEvent({ type: 'error', message: `WebSocket 连接超时 (5s): ${wsUrl}` })
      }
    }, 5000)

    this.ws.onopen = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.ws?.send(JSON.stringify({
        type: 'config',
        engine: config.engine || 'sensevoice',
        final_engine: config.finalEngine || 'sensevoice',
        language: config.language || 'zh',
        higgs_base_url: config.higgsBaseUrl || 'http://localhost:8002',
        voice: config.voice || 'default',
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
      }))
      this.pcmStreamer = new PcmStreamer((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      })
      this.pcmStreamer.start(config.deviceId).catch((error) => {
        this.onEvent({ type: 'error', message: error instanceof Error ? error.message : 'Cannot start microphone stream' })
      })
    }

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string)
        if (data.type === 'ready' || data.type === 'configured' || data.type === 'speech_start' || data.type === 'speech_end') {
          this.onEvent({ type: data.type })
        } else if (data.type === 'partial') {
          this.onEvent({ type: 'partial', text: data.text || '' })
        } else if (data.type === 'final') {
          this.onEvent({ type: 'final', text: data.text || '', language: data.language || null })
        } else if (data.type === 'tts') {
          this.onEvent({
            type: 'tts',
            text: data.text || '',
            audio: base64ToBlob(data.audio_b64 || '', data.media_type || 'audio/wav'),
            mediaType: data.media_type || 'audio/wav',
            sampleRate: data.sample_rate || null,
            timing: {
              asr_sec: Number(data.timing?.asr_sec || 0),
              tts_sec: Number(data.timing?.tts_sec || 0),
              higgs_network_sec: Number(data.timing?.higgs_network_sec || 0),
              total_sec: Number(data.timing?.total_sec || 0),
            }
          })
        } else if (data.type === 'error') {
          this.onEvent({ type: 'error', message: data.message || 'Stream error' })
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    this.ws.onclose = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.pcmStreamer?.stop()
      this.onEvent({ type: 'closed', intentional: this.stoppedByUser })
    }

    this.ws.onerror = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.onEvent({ type: 'error', message: `WebSocket 连接失败 (${wsUrl}) — 请确认后台服务已启动` })
    }
  }

  stop() {
    this.stoppedByUser = true
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }))
    }
    this.pcmStreamer?.stop()
    this.pcmStreamer = null
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
    this.ws?.close()
    this.ws = null
  }
}
