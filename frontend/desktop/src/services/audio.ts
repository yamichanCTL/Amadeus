import { finishTelemetryTrace, recordTelemetry, recordTelemetryStage, startTelemetryTrace, type TelemetryTrace } from './telemetry'

/** Tracks all AudioRecorder instances currently in 'recording' state.
 *  Prevents two instances (e.g. VoiceChanger and recordingService hotkey)
 *  from fighting over the microphone simultaneously. */
const _activeRecorders = new Set<AudioRecorder>()

export class AudioRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private preparedStream: MediaStream | null = null
  private preparedDeviceId = ''
  private chunks: BlobPart[] = []
  private startedAt = 0
  private stopTimer: number | null = null
  private levelContext: AudioContext | null = null
  private levelSource: MediaStreamAudioSourceNode | null = null
  private levelAnalyser: AnalyserNode | null = null
  private levelFrame = 0
  private prepareRequest = 0
  private startRequest = 0
  private pcmContext: AudioContext | null = null
  private pcmSource: MediaStreamAudioSourceNode | null = null
  private pcmWorkletNode: AudioWorkletNode | null = null
  private pcmProcessor: ScriptProcessorNode | null = null
  private pcmSilenceGain: GainNode | null = null
  private pcmChunks: Int16Array[] = []
  private pcmSampleRate = 0
  private pcmExpectedFrameStart: number | null = null
  private pcmGapSamples = 0
  private pcmOverlapSamples = 0
  private captureTrackSettings: MediaTrackSettings | null = null
  private readonly rejectLoopbackInput: boolean

  constructor(options: { rejectLoopbackInput?: boolean } = {}) {
    this.rejectLoopbackInput = Boolean(options.rejectLoopbackInput)
  }

  private audioConstraints(deviceId?: string): MediaTrackConstraints {
    return {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: { ideal: 1 },
      // Offline/TTS recording promises the selected physical microphone's
      // original waveform. Browser voice DSP can gate quiet phonemes and
      // create pumping/dropout artifacts, so keep this path unprocessed.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
  }

  async prepare(deviceId?: string) {
    const normalizedDeviceId = deviceId || ''
    if (this.recorder) return
    if (this.preparedStream?.active && this.preparedDeviceId === normalizedDeviceId) return
    const request = ++this.prepareRequest
    this.releasePreparedStream()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.audioConstraints(deviceId),
      video: false,
    })
    this.assertDirectMicrophone(stream)
    if (request !== this.prepareRequest || this.recorder) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.preparedStream = stream
    this.preparedDeviceId = normalizedDeviceId
    // Give the OS driver and raw capture track a short settling window before
    // the user starts speaking. This runs while the page is idle.
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
    // Cross-instance guard: another AudioRecorder instance is already
    // capturing the microphone. This prevents VoiceChanger and the
    // global hotkey recorder from opening the mic simultaneously.
    // First, clean up any stale entries (recorders that crashed without
    // calling stop/cancel — their .recorder is null but they're still in the set).
    for (const r of _activeRecorders) {
      if (!r['recorder']) _activeRecorders.delete(r)
    }
    if (_activeRecorders.size > 0 && !_activeRecorders.has(this)) {
      throw new Error('另一个录音正在进行中，请先停止当前录音')
    }
    const request = ++this.startRequest
    const normalizedDeviceId = deviceId || ''
    if (inputStream) {
      this.stream = inputStream
    } else if (this.preparedStream?.active && this.preparedDeviceId === normalizedDeviceId) {
      this.stream = this.preparedStream
      this.preparedStream = null
      this.preparedDeviceId = ''
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.audioConstraints(deviceId),
        video: false,
      })
    }
    if (request !== this.startRequest) {
      this.stream?.getTracks().forEach((track) => track.stop())
      this.stream = null
      throw new Error('录音启动已取消')
    }
    if (!this.stream?.active) throw new Error('麦克风音频轨道未就绪')
    if (!inputStream) this.assertDirectMicrophone(this.stream)
    this.captureTrackSettings = this.stream.getAudioTracks()[0]?.getSettings() || null

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    this.chunks = []
    this.startedAt = Date.now()
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onerror = (event) => {
      console.error('[AudioRecorder] MediaRecorder 错误:', event)
    }
    // 1s chunks reduce Opus container fragmentation and driver jitter while
    // still giving stop() partial data if a device is slow to finalize.
    this.recorder.start(1000)
    _activeRecorders.add(this)
    await this.startPcmRecorder(this.stream, onLevel)
  }

  async stop() {
    if (!this.recorder) throw new Error('录音尚未开始')
    const recorder = this.recorder
    const mimeType = recorder.mimeType || 'audio/webm'
    const durationSec = (Date.now() - this.startedAt) / 1000

    let finishStop: () => void = () => undefined
    const stopped = new Promise<void>((resolve) => {
      let done = false
      finishStop = () => {
        if (done) return
        done = true
        if (this.stopTimer) window.clearTimeout(this.stopTimer)
        this.stopTimer = null
        resolve()
      }
      recorder.onstop = finishStop
      recorder.onerror = (event) => {
        console.error('[AudioRecorder] MediaRecorder 停止错误:', event)
        finishStop()
      }
      this.stopTimer = window.setTimeout(finishStop, 1800)
    })
    if (recorder.state === 'recording') {
      try { recorder.requestData() } catch { /* best effort */ }
      recorder.stop()
    } else {
      finishStop()
    }
    await stopped
    _activeRecorders.delete(this)
    const pcmSamples = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const capture = {
      sampleRate: this.pcmSampleRate,
      samples: pcmSamples,
      durationSec: this.pcmSampleRate ? pcmSamples / this.pcmSampleRate : 0,
      gapSamples: this.pcmGapSamples,
      overlapSamples: this.pcmOverlapSamples,
      echoCancellation: this.captureTrackSettings?.echoCancellation ?? null,
      noiseSuppression: this.captureTrackSettings?.noiseSuppression ?? null,
      autoGainControl: this.captureTrackSettings?.autoGainControl ?? null,
    }
    const pcmBlob = this.buildPcmWavBlob()
    this.stopPcmRecorder()
    this.stopLevelMonitor()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    if (pcmBlob) return { blob: pcmBlob, durationSec, mimeType: 'audio/wav', capture }
    return { blob: new Blob(this.chunks, { type: mimeType }), durationSec, mimeType, capture }
  }

  cancel() {
    this.prepareRequest += 1
    this.startRequest += 1
    if (this.stopTimer) window.clearTimeout(this.stopTimer)
    this.stopTimer = null
    if (this.recorder?.state !== 'inactive') this.recorder?.stop()
    _activeRecorders.delete(this)
    this.stopPcmRecorder()
    this.stopLevelMonitor()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.releasePreparedStream()
    this.recorder = null
    this.stream = null
    this.chunks = []
    this.pcmChunks = []
    this.pcmExpectedFrameStart = null
    this.pcmGapSamples = 0
    this.pcmOverlapSamples = 0
    this.captureTrackSettings = null
  }

  private async startPcmRecorder(stream: MediaStream, onLevel?: (level: number) => void) {
    this.stopPcmRecorder()
    this.pcmChunks = []
    this.pcmExpectedFrameStart = null
    this.pcmGapSamples = 0
    this.pcmOverlapSamples = 0
    this.pcmContext = new AudioContext()
    this.pcmSampleRate = this.pcmContext.sampleRate
    this.pcmSource = this.pcmContext.createMediaStreamSource(stream)
    try {
      if (!this.pcmContext.audioWorklet) throw new Error('AudioWorklet is not supported')
      await this.pcmContext.audioWorklet.addModule(getPcmCaptureWorkletUrl())
      this.pcmWorkletNode = new AudioWorkletNode(this.pcmContext, 'amadeus-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      this.pcmWorkletNode.port.onmessage = (event) => {
        const buffer = event.data?.buffer as ArrayBuffer | undefined
        if (!buffer) return
        const pcm = new Int16Array(buffer)
        this.appendPcmChunk(pcm, Number(event.data?.frameStart))
        if (onLevel) onLevel(levelFromPcm16(pcm))
      }
      this.pcmSource.connect(this.pcmWorkletNode)
      this.pcmSilenceGain = this.pcmContext.createGain()
      this.pcmSilenceGain.gain.value = 0
      this.pcmWorkletNode.connect(this.pcmSilenceGain)
      this.pcmSilenceGain.connect(this.pcmContext.destination)
    } catch {
      try { this.pcmWorkletNode?.disconnect() } catch { /* ignore */ }
      this.pcmWorkletNode = null
      this.pcmProcessor = this.pcmContext.createScriptProcessor(2048, 1, 1)
      this.pcmProcessor.onaudioprocess = (event) => {
        const pcm = floatToPcm16(event.inputBuffer.getChannelData(0))
        this.appendPcmChunk(pcm)
        if (onLevel) onLevel(levelFromPcm16(pcm))
      }
      this.pcmSource.connect(this.pcmProcessor)
      this.pcmSilenceGain = this.pcmContext.createGain()
      this.pcmSilenceGain.gain.value = 0
      this.pcmProcessor.connect(this.pcmSilenceGain)
      this.pcmSilenceGain.connect(this.pcmContext.destination)
    }
    await this.pcmContext.resume()
  }

  private stopPcmRecorder() {
    try { this.pcmWorkletNode?.disconnect() } catch { /* ignore */ }
    try { this.pcmProcessor?.disconnect() } catch { /* ignore */ }
    try { this.pcmSilenceGain?.disconnect() } catch { /* ignore */ }
    try { this.pcmSource?.disconnect() } catch { /* ignore */ }
    this.pcmWorkletNode?.port.close()
    this.pcmContext?.close().catch(() => undefined)
    this.pcmContext = null
    this.pcmSource = null
    this.pcmWorkletNode = null
    this.pcmProcessor = null
    this.pcmSilenceGain = null
  }

  private appendPcmChunk(input: Int16Array, frameStart?: number) {
    if (!input.length) return
    const pcm = new Int16Array(input)
    if (!Number.isFinite(frameStart)) {
      this.pcmChunks.push(pcm)
      return
    }

    const start = Math.max(0, Math.round(frameStart!))
    if (this.pcmExpectedFrameStart === null) {
      this.pcmExpectedFrameStart = start + pcm.length
      this.pcmChunks.push(pcm)
      return
    }

    const expected = this.pcmExpectedFrameStart
    if (start > expected) {
      const gap = start - expected
      this.pcmChunks.push(new Int16Array(gap))
      this.pcmGapSamples += gap
      this.pcmChunks.push(pcm)
      this.pcmExpectedFrameStart = start + pcm.length
      return
    }

    if (start < expected) {
      const overlap = expected - start
      this.pcmOverlapSamples += Math.min(overlap, pcm.length)
      if (overlap >= pcm.length) return
      this.pcmChunks.push(pcm.slice(overlap))
      this.pcmExpectedFrameStart = start + pcm.length
      return
    }

    this.pcmChunks.push(pcm)
    this.pcmExpectedFrameStart = start + pcm.length
  }

  private buildPcmWavBlob() {
    const sampleRate = this.pcmSampleRate || 0
    const totalSamples = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (!sampleRate || totalSamples < Math.floor(sampleRate * 0.08)) return null
    const pcm = new Int16Array(totalSamples)
    let offset = 0
    for (const chunk of this.pcmChunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    if (this.pcmGapSamples > 0 || this.pcmOverlapSamples > 0) {
      console.warn(
        `[AudioRecorder] PCM 时间轴已修复：补齐 ${this.pcmGapSamples} 样本，忽略 ${this.pcmOverlapSamples} 重叠样本`,
      )
    }
    return new Blob([encodePcm16Wav(pcm, sampleRate)], { type: 'audio/wav' })
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
    }
    // Use setInterval instead of requestAnimationFrame. RAF is throttled or
    // suspended entirely when the renderer window is minimized, in the
    // background, or when the page is unmounted — which froze the status
    // overlay waveform mid-recording ("波形卡死不动"). setInterval keeps
    // sampling regardless of window visibility, so the overlay keeps
    // animating even when the main UI is closed or focus is elsewhere.
    update()
    this.levelFrame = window.setInterval(update, 60) as unknown as number
  }

  private stopLevelMonitor() {
    if (this.levelFrame) window.clearInterval(this.levelFrame)
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

  private assertDirectMicrophone(stream: MediaStream) {
    if (!this.rejectLoopbackInput) return
    const label = stream.getAudioTracks()[0]?.label || ''
    if (!isLikelyLoopbackInput(label)) return
    stream.getTracks().forEach((track) => track.stop())
    throw new Error(`录音必须使用实体麦克风，当前选择的是回环/虚拟输出设备：${label}`)
  }
}

function floatToPcm16(input: Float32Array) {
  const pcm = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
  }
  return pcm
}

function levelFromPcm16(pcm: Int16Array) {
  if (!pcm.length) return 0
  let squareSum = 0
  let peak = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] / 32768
    const abs = Math.abs(sample)
    squareSum += sample * sample
    if (abs > peak) peak = abs
  }
  const rms = Math.sqrt(squareSum / pcm.length)
  return Math.min(1, Math.max(peak * 0.7, rms * 4))
}

function encodePcm16Wav(pcm: Int16Array, sampleRate: number) {
  const headerBytes = 44
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(headerBytes + dataBytes)
  const view = new DataView(buffer)
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = headerBytes
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(offset, pcm[i], true)
    offset += 2
  }
  return buffer
}

export const speechRecorder = new AudioRecorder({ rejectLoopbackInput: true })

/** Capture system audio output (speaker loopback) for offline ASR.
 *  Uses getDisplayMedia with the Electron display media request handler
 *  configured in main.ts to bypass the source-picker UI. */
export async function captureSpeakerAudio(): Promise<MediaStream> {
  // Request display media with system audio — the Electron main process
  // handler auto-selects the first screen and enables audio loopback.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: 1, height: 1, frameRate: 1 } as MediaTrackConstraints,
    audio: true,
  })
  // Stop the video track immediately — we only need the audio
  stream.getVideoTracks().forEach((track) => track.stop())
  const audioTracks = stream.getAudioTracks()
  if (!audioTracks.length) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('扬声器采集失败：系统未返回音频轨道，请确认 Windows 正在播放声音')
  }
  return stream
}

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

export async function testAudioInputDevice(
  deviceId?: string,
  durationMs = 1200,
  inputStream?: MediaStream,
): Promise<AudioInputTestResult> {
  const stream = inputStream || await navigator.mediaDevices.getUserMedia({
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
 * 使用 Web Audio API 将音频路由到指定输出设备。
 * AudioContext.setSinkId 比 HTMLAudioElement.setSinkId 对虚拟设备支持更好。
 * 注意：本函数创建独立 AudioContext，请勿在音频中转（relay）激活时调用，
 * 以免新 context 的 setSinkId 干扰 relay 的音频路由。
 */
export async function playAudioBlobToDevice(blob: Blob, outputDeviceId?: string) {
  const context = new AudioContext()
  let sinkApplied = false
  try {
    const sinkContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }
    if (outputDeviceId && sinkContext.setSinkId) {
      try {
        await sinkContext.setSinkId(outputDeviceId)
        sinkApplied = true
        console.log('[playAudioBlobToDevice] setSinkId 成功: %s', outputDeviceId)
      } catch (sinkError) {
        console.warn('[playAudioBlobToDevice] setSinkId 失败，降级到系统默认输出设备:', sinkError instanceof Error ? sinkError.message : sinkError)
      }
    } else if (outputDeviceId) {
      console.warn('[playAudioBlobToDevice] setSinkId API 不可用，将使用系统默认输出')
    }
    await context.resume()
    console.log('[playAudioBlobToDevice] AudioContext.state=%s sampleRate=%d blobSize=%d blobType=%s',
      context.state, context.sampleRate, blob.size, blob.type)
    const encoded = await blob.arrayBuffer()
    const decoded = await context.decodeAudioData(encoded)
    console.log('[playAudioBlobToDevice] decodeAudioData 完成: duration=%.3fs channels=%d length=%d sampleRate=%d',
      decoded.duration, decoded.numberOfChannels, decoded.length, decoded.sampleRate)
    if (decoded.length === 0 || decoded.duration === 0) {
      throw new Error('解码后的音频缓冲区为空')
    }
    const source = context.createBufferSource()
    source.buffer = decoded
    source.connect(context.destination)
    source.onended = () => {
      console.log('[playAudioBlobToDevice] 播放结束，关闭 AudioContext')
      context.close().catch(() => undefined)
    }
    source.start(context.currentTime + 0.01)
    console.log('[playAudioBlobToDevice] 开始播放: scheduledAt=%.3fs context.state=%s',
      context.currentTime, context.state)
    return {
      stop: () => {
        try { source.stop() } catch { /* 已停止 */ }
        context.close().catch(() => undefined)
      },
      sinkApplied,
      sampleRate: context.sampleRate,
    }
  } catch (error) {
    console.error('[playAudioBlobToDevice] 播放异常:', error instanceof Error ? error.message : error)
    context.close().catch(() => undefined)
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
  private micAnalyser: AnalyserNode | null = null
  private injectedSources = new Set<AudioBufferSourceNode>()
  private nextPcmTime = 0
  private pcmPushChain: Promise<void> = Promise.resolve()
  private sinkApplied = false
  // 监听上下文：临时把真实麦克风引到系统默认扬声器用于通路调试，
  // 与主 context（已 setSinkId 到虚拟线缆）完全独立，不影响虚拟麦克风输出。
  private monitorContext: AudioContext | null = null
  private monitorSource: MediaStreamAudioSourceNode | null = null
  private monitorGain: GainNode | null = null
  private monitorAnalyser: AnalyserNode | null = null
  private monitorStream: MediaStream | null = null
  private monitorTimer: ReturnType<typeof setTimeout> | null = null
  private monitorResolve: (() => void) | null = null

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
          // 纯透传：ASR 通过 createInputStream() clone 同一轨道，任何浏览器
          // DSP（AEC/NS/AGC）都会同时扭曲虚拟麦克风输出与 ASR 输入。回声/反馈
          // 由结构保证——TTS 走独立虚拟 sink，且下面的回环保护拒绝线缆反馈。
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      })
      // 回环保护：输入若落到虚拟线缆的输出端（如 CABLE Output）再写入
      // CABLE Input 会形成反馈，必须拒绝。real mic（如 DJI）不受影响。
      const inputLabel = this.inputStream.getAudioTracks()[0]?.label || ''
      const outputLabel = options.outputDeviceId
        ? await resolveOutputLabel(options.outputDeviceId)
        : ''
      if (isLoopbackPair(inputLabel, outputLabel)) {
        this.inputStream.getTracks().forEach((track) => track.stop())
        this.inputStream = null
        throw new Error(
          `虚拟麦克风中转检测到回环：输入「${inputLabel || '系统默认'}」与输出「${outputLabel || '系统默认'}」属于同一条虚拟线缆，会形成反馈。请把输入选为真实麦克风（如 DJI Mic），或在 Windows 声音设置里把默认录音设备改为真实麦克风。`,
        )
      }

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
      // 输入电平探针：仅作电平读取，不继续连接，不影响虚拟输出或 ASR。
      this.micAnalyser = this.context.createAnalyser()
      this.micAnalyser.fftSize = 1024
      this.micAnalyser.smoothingTimeConstant = 0.7
      this.microphoneSource.connect(this.micAnalyser)
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

  /** 真实麦克风输入电平 0..1（仅采样一次）；未运行返回 null。 */
  getInputLevel(): number | null {
    const analyser = this.micAnalyser
    if (!analyser) return null
    return readAnalyserLevel(analyser)
  }

  /** 是否正在通路监听中。 */
  isMonitoring(): boolean {
    return this.monitorContext !== null
  }

  /** 监听通路电平 0..1（仅采样一次）；未在监听返回 null。 */
  getMonitorLevel(): number | null {
    const analyser = this.monitorAnalyser
    if (!analyser) return null
    return readAnalyserLevel(analyser)
  }

  /**
   * 临时把真实麦克风引到系统默认扬声器，用于通路调试（真实麦克风 in → 默认扬声器 out）。
   * 不触碰主 context 的虚拟 sink，虚拟麦克风输出与 TTS 叠加均不受影响。
   * relay 必须处于活动状态。durationMs 为 0 时不自动停止，需手动调用 stopMonitor()。
   */
  startMonitor(durationMs: number): Promise<void> {
    if (!this.inputStream?.active) return Promise.reject(new Error('麦克风中转尚未启动'))
    const stream = this.inputStream
    if (this.monitorContext) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.monitorResolve = resolve
      try {
        // clone 一份输入轨道，停止监听时不影响 relay 的输入。
        this.monitorStream = new MediaStream(stream.getAudioTracks().map((track) => track.clone()))
        // 不调用 setSinkId → 走系统默认扬声器。
        this.monitorContext = new AudioContext()
        this.monitorSource = this.monitorContext.createMediaStreamSource(this.monitorStream)
        this.monitorGain = this.monitorContext.createGain()
        this.monitorGain.gain.value = 1
        this.monitorAnalyser = this.monitorContext.createAnalyser()
        this.monitorAnalyser.fftSize = 1024
        this.monitorAnalyser.smoothingTimeConstant = 0.7
        this.monitorSource.connect(this.monitorGain)
        this.monitorGain.connect(this.monitorAnalyser)
        this.monitorAnalyser.connect(this.monitorContext.destination)
        void this.monitorContext.resume().catch(() => undefined)
        if (durationMs > 0) {
          this.monitorTimer = setTimeout(() => this.stopMonitor(), Math.max(200, durationMs))
        }
      } catch (error) {
        this.stopMonitor()
        resolve()
      }
    })
  }

  /** 提前停止监听。 */
  stopMonitor() {
    if (this.monitorTimer) { clearTimeout(this.monitorTimer); this.monitorTimer = null }
    try { this.monitorSource?.disconnect() } catch { /* ignore */ }
    try { this.monitorGain?.disconnect() } catch { /* ignore */ }
    try { this.monitorAnalyser?.disconnect() } catch { /* ignore */ }
    this.monitorStream?.getTracks().forEach((track) => track.stop())
    this.monitorContext?.close().catch(() => undefined)
    this.monitorContext = null
    this.monitorSource = null
    this.monitorGain = null
    this.monitorAnalyser = null
    this.monitorStream = null
    if (this.monitorResolve) {
      const resolve = this.monitorResolve
      this.monitorResolve = null
      resolve()
    }
  }

  stop() {
    this.stopMonitor()
    this.stopInjectedAudio()
    try { this.micAnalyser?.disconnect() } catch { /* ignore */ }
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
    this.micAnalyser = null
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
    let microphoneCapture: Record<string, unknown> | null = null
    if (dji) {
      const recorder = new AudioRecorder({ rejectLoopbackInput: true })
      try {
        await recorder.start(dji.deviceId)
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        const result = await recorder.stop()
        microphoneCapture = {
          mimeType: result.mimeType,
          blobBytes: result.blob.size,
          ...result.capture,
        }
      } finally {
        recorder.cancel()
      }
    }
    const capturePassed = Boolean(
      microphoneCapture
      && microphoneCapture.mimeType === 'audio/wav'
      && Number(microphoneCapture.samples) > 0
      && Number(microphoneCapture.gapSamples) === 0
      && microphoneCapture.echoCancellation !== true
      && microphoneCapture.noiseSuppression !== true
      && microphoneCapture.autoGainControl !== true
    )
    return {
      passed: Boolean(dji && cableInput && cableOutput && capturePassed),
      dji: dji?.label || '',
      cableInput: cableInput?.label || '',
      cableOutput: cableOutput?.label || '',
      microphoneCapture,
    }
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
  // Empty → same-origin only in a browser (http/https) served via the Vite
  // proxy. In Electron (file:// / app://) there is no origin to fall back
  // to, so we return '' — callers must refuse to connect when no backend
  // address has been configured and confirmed (Req: 未设置不通信). We no
  // longer fall back to ws://localhost:8000.
  if (!trimmed || trimmed === '/') {
    const protocol = window.location.protocol
    if (protocol === 'file:' || protocol === 'app:') {
      return ''
    }
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
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
  // Only add same-origin as a fallback candidate in browser dev (where the
  // Vite proxy can forward WS). In Electron there is no host to use.
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
const MAX_WS_AUDIO_BUFFER_BYTES = 64 * 1024

const pcmCaptureWorkletSource = `
class AmadeusPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sequence = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) return true
    const pcm = new Int16Array(channel.length)
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
    }
    this.port.postMessage({ buffer: pcm.buffer, sampleRate, sequence: this.sequence++, frameStart: currentFrame }, [pcm.buffer])
    return true
  }
}
registerProcessor('amadeus-pcm-capture', AmadeusPcmCaptureProcessor)
`

let pcmCaptureWorkletUrl = ''

function getPcmCaptureWorkletUrl() {
  if (!pcmCaptureWorkletUrl) {
    pcmCaptureWorkletUrl = URL.createObjectURL(new Blob([pcmCaptureWorkletSource], { type: 'application/javascript' }))
  }
  return pcmCaptureWorkletUrl
}

function isLikelyLoopbackInput(label: string) {
  return /monitor|stereo\s*mix|what\s*u\s*hear|loopback|立体声混音|输出监听|cable\s+output|virtual(?:\s+audio)?\s+cable.*output/i.test(label)
}

/**
 * 判断输入端点与输出端点是否属于同一条虚拟线缆（如输入 CABLE Output、输出 CABLE Input），
 * 或输入本身就是回环设备。命中则禁止建立中转，否则会形成反馈。
 */
export function isLoopbackPair(inputLabel: string, outputLabel: string): boolean {
  if (!inputLabel) return false
  if (isLikelyLoopbackInput(inputLabel)) return true
  if (!outputLabel) return false
  const inputNorm = normalizeCableLabel(inputLabel)
  const outputNorm = normalizeCableLabel(outputLabel)
  // 两端都识别为线缆、前缀相同、且一端 input 一端 output → 同一条线缆。
  if (inputNorm && outputNorm && inputNorm.prefix === outputNorm.prefix && inputNorm.end !== outputNorm.end) {
    return true
  }
  return false
}

function normalizeCableLabel(label: string): { prefix: string; end: 'input' | 'output' } | null {
  const match = label.match(/^(.+?)\s*(input|output)\s*$/i)
  if (!match) return null
  return { prefix: match[1].trim().toLowerCase(), end: match[2].toLowerCase() as 'input' | 'output' }
}

/** 用 deviceId 在 enumerateDevices 结果中查输出设备 label。 */
async function resolveOutputLabel(outputDeviceId: string): Promise<string> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const device = devices.find((item) => item.kind === 'audiooutput' && item.deviceId === outputDeviceId)
    return device?.label || ''
  } catch {
    return ''
  }
}

/** 复用 AudioRecorder.startLevelMonitor 的电平公式，保持视觉一致。 */
function readAnalyserLevel(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(samples)
  let squareSum = 0
  let peak = 0
  for (const sample of samples) {
    squareSum += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  const rms = Math.sqrt(squareSum / samples.length)
  return Math.min(1, Math.max(peak * 0.7, rms * 4))
}

export class PcmStreamer {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private silenceGain: GainNode | null = null
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

    this.audioContext = new AudioContext({ sampleRate: this.targetSampleRate })
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    await this.audioContext.resume()
    try {
      await this.startWorkletCapture()
    } catch (workletError) {
      console.warn('[PcmStreamer] AudioWorklet unavailable, falling back to ScriptProcessor:', workletError)
      this.startScriptProcessorCapture()
    }
  }

  private shouldDropInputFrame() {
    return this.outputPlaybackActive && this.echoCancellationEnabled === false
  }

  private emitPcm(pcm: Int16Array, sampleRate: number) {
    if (this.shouldDropInputFrame()) return
    this.onPcm(pcm, sampleRate)
  }

  private async startWorkletCapture() {
    const context = this.audioContext
    const source = this.source
    if (!context || !source) throw new Error('AudioContext is not ready')
    if (!context.audioWorklet) throw new Error('AudioWorklet is not supported')
    await context.audioWorklet.addModule(getPcmCaptureWorkletUrl())
    this.workletNode = new AudioWorkletNode(context, 'amadeus-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    this.workletNode.port.onmessage = (event) => {
      const buffer = event.data?.buffer as ArrayBuffer | undefined
      if (!buffer) return
      this.emitPcm(new Int16Array(buffer), Number(event.data?.sampleRate || context.sampleRate || this.targetSampleRate))
    }
    source.connect(this.workletNode)
    this.silenceGain = context.createGain()
    this.silenceGain.gain.value = 0
    this.workletNode.connect(this.silenceGain)
    this.silenceGain.connect(context.destination)
  }

  private startScriptProcessorCapture() {
    const context = this.audioContext
    const source = this.source
    if (!context || !source) throw new Error('AudioContext is not ready')
    this.processor = context.createScriptProcessor(1024, 1, 1)
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const int16 = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
      }
      this.emitPcm(int16, context.sampleRate || this.targetSampleRate)
    }
    source.connect(this.processor)
    this.silenceGain = context.createGain()
    this.silenceGain.gain.value = 0
    this.processor.connect(this.silenceGain)
    this.silenceGain.connect(context.destination)
  }

  setOutputPlaybackActive(active: boolean) {
    this.outputPlaybackActive = active
  }

  stop() {
    try { this.processor?.disconnect() } catch { /* ignore */ }
    try { this.workletNode?.disconnect() } catch { /* ignore */ }
    try { this.silenceGain?.disconnect() } catch { /* ignore */ }
    try { this.source?.disconnect() } catch { /* ignore */ }
    this.workletNode?.port.close()
    this.audioContext?.close().catch(() => {})
    this.stream?.getTracks().forEach((track) => track.stop())
    this.processor = null
    this.workletNode = null
    this.silenceGain = null
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
  private pendingInputStream: MediaStream | null = null
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
    this.releasePendingInput()
    this.pendingInputStream = config.inputStream || null
    this.sessionTrace = startTelemetryTrace('websocket', '实时 ASR 会话', config.engine || 'x-asr')
    this.firstPartialSeen = false
    const attempted: string[] = []

    // Req: 未设置后端地址时不进行任何通信。在 Electron 环境下若用户尚未确认
    // 后端地址，候选列表为空，这里直接报错而不是连本机回退。
    if (this.urls.length === 0) {
      this.releasePendingInput()
      this.onEvent({
        type: 'error',
        message: '未配置后端地址。请在「设置 → 后端地址」填写并点击「确认」后再开始实时识别。',
      })
      return
    }

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
        if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < MAX_WS_AUDIO_BUFFER_BYTES) {
          this.ws.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        }
      })
      const inputStream = this.pendingInputStream || undefined
      this.pendingInputStream = null
      this.pcmStreamer.start(config.deviceId, inputStream).catch((error) => {
        this.pcmStreamer?.stop()
        this.pcmStreamer = null
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
        this.releasePendingInput()
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
          this.releasePendingInput()
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
        this.releasePendingInput()
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
    this.releasePendingInput()
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000, 'client stop')
    if (!this.closedEmitted) {
      this.closedEmitted = true
      this.onEvent({ type: 'closed', intentional: true })
    }
  }

  private releasePendingInput() {
    this.pendingInputStream?.getTracks().forEach((track) => track.stop())
    this.pendingInputStream = null
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
    // Req: 未设置后端地址时不进行任何通信。
    if (this.urls.length === 0) {
      this.onEvent({
        type: 'error',
        message: '未配置后端地址。请在「设置 → 后端地址」填写并点击「确认」后再开始。',
      })
      return
    }
    let captureStarted = false
    const startPcmCapture = () => {
      if (captureStarted) return
      captureStarted = true
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null }
      this.pcmStreamer = new PcmStreamer((pcm) => {
        if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < MAX_WS_AUDIO_BUFFER_BYTES) {
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
        this.pcmStreamer = null
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
          this.pcmStreamer = null
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
