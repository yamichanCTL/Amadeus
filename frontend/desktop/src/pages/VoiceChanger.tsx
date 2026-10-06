import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, HiggsAudioResult, HiggsTTSRequest, type HiggsVoicePreset } from '@/services/api'
import { AudioRecorder, AudioRelayMixer, Pcm16ChunkPlayer, VoiceTTSStreamingClient, listAudioOutputDevices, playAudioBlob, playAudioBlobToDevice, testAudioOutputDevice } from '@/services/audio'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace, type TelemetryTrace } from '@/services/telemetry'
import { useASRStore } from '@/store/useASRStore'
import { ModelsPage } from '@/pages/Models'
import { useActivityTask } from '@/services/activity'
import './VoiceChanger.css'

type VoiceMode = 'voice' | 'text' | 'realtime'
type WorkStatus = 'idle' | 'recording' | 'processing' | 'streaming' | 'done' | 'error'

type SoundEffectItem = {
  id: string
  name: string
  file: File
}

const modeLabels: Record<VoiceMode, string> = {
  voice: '语音转换',
  text: '文字合成',
  realtime: '实时转换'
}
const modeDescriptions: Record<VoiceMode, string> = {
  text: '输入文字，生成所选音色的语音。',
  voice: '录音或上传文件，识别后用所选音色重新合成。',
  realtime: '持续采集麦克风，逐段识别并发送到输出设备。',
}

function roundSec(value?: number) {
  if (!Number.isFinite(value || 0)) return 0
  return Math.round((value || 0) * 1000) / 1000
}

function formatSec(value: number) {
  return value > 0 ? `${roundSec(value).toFixed(3)}s` : '-'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

export function VoiceChangerPage() {
  const settings = useASRStore((s) => s.settings)
  const updateSettings = useASRStore((s) => s.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const streamClientRef = useRef<VoiceTTSStreamingClient | null>(null)
  const recorderRef = useRef<AudioRecorder | null>(null)
  const playbackRef = useRef<HTMLAudioElement | null>(null)
  const playbackUrlRef = useRef('')
  const inputAudioUrlRef = useRef('')
  const outputAudioUrlRef = useRef('')
  const outputBlobRef = useRef<Blob | null>(null)
  const relayMixerRef = useRef(new AudioRelayMixer())
  const realtimePcmPlayerRef = useRef<Pcm16ChunkPlayer | null>(null)
  const realtimeChunkJobsRef = useRef<Set<string>>(new Set())
  const realtimeTraceRef = useRef<TelemetryTrace | null>(null)
  const statusRef = useRef<WorkStatus>('idle')
  const fileRef = useRef<HTMLInputElement>(null)
  const soundFileRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const operationRef = useRef(0)
  const relayOperationRef = useRef(0)
  const outputOperationRef = useRef(0)
  const relayPendingRef = useRef(false)
  const devicePlaybackRef = useRef<{ stop: () => void } | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)

  const [mode, setMode] = useState<VoiceMode>('text')
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [ttsText, setTtsText] = useState('')
  const [transcript, setTranscript] = useState('')
  const [partialText, setPartialText] = useState('')
  const [inputAudioUrl, setInputAudioUrl] = useState('')
  const [outputAudioUrl, setOutputAudioUrl] = useState('')
  const [status, setStatusState] = useState<WorkStatus>('idle')
  const [statusText, setStatusText] = useState('等待输入')
  const [error, setError] = useState('')
  const [health, setHealth] = useState('')
  const [liveSegments, setLiveSegments] = useState<Array<{ text: string; timing: number; totalTiming?: number; chunks?: number }>>([])
  const [activeVoice, setActiveVoice] = useState(settings.higgsTtsVoice || 'Elysia')
  const [soundEffects, setSoundEffects] = useState<SoundEffectItem[]>([])
  const [relayActive, setRelayActive] = useState(false)
  const [relayStatus, setRelayStatus] = useState('未启用：麦克风不会透传到输出设备')
  const [voicePresets, setVoicePresets] = useState<HiggsVoicePreset[]>([])
  const [outputTest, setOutputTest] = useState('')
  const [testingOutput, setTestingOutput] = useState(false)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [mixingOpen, setMixingOpen] = useState(false)
  const [captureStarting, setCaptureStarting] = useState(false)
  const [relayStarting, setRelayStarting] = useState(false)
  const [sendingOutput, setSendingOutput] = useState(false)

  const updateStatus = useCallback((value: WorkStatus) => {
    statusRef.current = value
    setStatusState(value)
  }, [])
  const isCurrent = useCallback((operation: number) => mountedRef.current && operationRef.current === operation, [])
  const stopPlayback = useCallback(() => {
    outputOperationRef.current += 1
    previewAudioRef.current?.pause()
    playbackRef.current?.pause()
    devicePlaybackRef.current?.stop()
    relayMixerRef.current.stopInjectedAudio()
    devicePlaybackRef.current = null
    if (mountedRef.current) setSendingOutput(false)
  }, [])

  const stopWork = useCallback(() => {
    const hadWork = ['recording', 'processing', 'streaming'].includes(statusRef.current)
    operationRef.current += 1
    const stream = streamClientRef.current
    streamClientRef.current = null
    stream?.stop()
    recorderRef.current?.cancel()
    recorderRef.current = null
    realtimePcmPlayerRef.current?.stop()
    realtimePcmPlayerRef.current = null
    realtimeChunkJobsRef.current.clear()
    stopPlayback()
    if (mountedRef.current) {
      updateStatus('idle')
      setCaptureStarting(false)
      setPartialText('')
      setStatusText('已停止本次任务')
    }
    if (hadWork) void window.electronAPI?.hideStatusOverlay()
  }, [stopPlayback, updateStatus])

  const stopRelay = useCallback(() => {
    relayOperationRef.current += 1
    relayPendingRef.current = false
    relayMixerRef.current.stop()
    if (mountedRef.current) {
      setRelayStarting(false)
      setRelayActive(false)
      setRelayStatus('已停止：麦克风不再透传')
    }
  }, [])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    setActiveVoice(settings.higgsTtsVoice || 'Elysia')
  }, [settings.higgsTtsVoice])

  const commonPayload = useCallback((): Omit<HiggsTTSRequest, 'text'> => ({
    higgs_base_url: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteBaseUrl : settings.higgsTtsBaseUrl,
    provider: settings.higgsTtsProvider,
    api_token: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsApiToken : '',
    model: settings.higgsTtsRemoteModel,
    voice: activeVoice || settings.higgsTtsVoice || 'Elysia',
    response_format: settings.higgsTtsFormat,
    speed: settings.higgsTtsSpeed,
    temperature: settings.higgsTtsTemperature,
    top_p: settings.higgsTtsTopP,
    top_k: settings.higgsTtsTopK,
    seed: settings.higgsTtsSeed,
    max_new_tokens: settings.higgsTtsMaxNewTokens,
    reference_audio: settings.higgsTtsReferenceAudioDataUrl,
    reference_url: settings.higgsTtsReferenceUrl,
    reference_text: settings.higgsTtsReferenceText,
    reference_codes_json: settings.higgsTtsReferenceCodesJson,
    emotion: settings.higgsTtsEmotion,
    style: settings.higgsTtsStyle,
    prosody_speed: settings.higgsTtsProsodySpeed,
    pitch: settings.higgsTtsPitch,
    expressiveness: settings.higgsTtsExpressiveness,
    initial_codec_chunk_frames: settings.higgsTtsInitialCodecChunkFrames,
    stream: false
  }), [
    settings.higgsTtsBaseUrl,
    settings.higgsTtsProvider,
    settings.higgsTtsApiToken,
    settings.higgsTtsRemoteBaseUrl,
    settings.higgsTtsRemoteModel,
    activeVoice,
    settings.higgsTtsVoice,
    settings.higgsTtsFormat,
    settings.higgsTtsSpeed,
    settings.higgsTtsTemperature,
    settings.higgsTtsTopP,
    settings.higgsTtsTopK,
    settings.higgsTtsSeed,
    settings.higgsTtsMaxNewTokens,
    settings.higgsTtsReferenceAudioDataUrl,
    settings.higgsTtsReferenceUrl,
    settings.higgsTtsReferenceText,
    settings.higgsTtsReferenceCodesJson,
    settings.higgsTtsEmotion,
    settings.higgsTtsStyle,
    settings.higgsTtsProsodySpeed,
    settings.higgsTtsPitch,
    settings.higgsTtsExpressiveness,
    settings.higgsTtsInitialCodecChunkFrames
  ])

  const setOutputBlob = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    outputBlobRef.current = blob
    setOutputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const applyResult = useCallback((result: HiggsAudioResult, source: VoiceMode) => {
    setOutputBlob(result.audio)
    if (result.text && source !== 'realtime') setTranscript(result.text)
  }, [setOutputBlob])

  const playResult = useCallback(async (blob?: Blob, trace?: TelemetryTrace) => {
    const outputOperation = ++outputOperationRef.current
    const fromArg = Boolean(blob)
    const fromRef = Boolean(!blob && outputBlobRef.current)
    const targetBlob = blob || outputBlobRef.current || (outputAudioUrl ? await fetch(outputAudioUrl).then((res) => res.blob()).catch(() => null) : null)
    console.log('[playResult] source=%s blobSize=%d blobType=%s relayActive=%s outputDevice=%s',
      fromArg ? 'arg' : fromRef ? 'ref' : targetBlob ? 'fetch' : 'none',
      targetBlob?.size ?? 0, targetBlob?.type ?? 'null',
      relayMixerRef.current.isActive(),
      settings.audioOutputDeviceId || '系统默认')
    if (!targetBlob) {
      if (outputAudioUrl) {
        setError('无法读取输出音频数据，请重新生成 TTS')
      }
      return
    }
    try {
      if (relayMixerRef.current.isActive()) {
        if (trace) recordTelemetryStage(trace, '播放提交', { detail: '共享麦克风混音总线' })
        await relayMixerRef.current.playBlob(targetBlob, () => mountedRef.current && outputOperation === outputOperationRef.current)
        if (trace) recordTelemetryStage(trace, '已注入中转混音')
        console.log('[playResult] relay mixer playBlob 完成')
        return
      }
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      playbackRef.current?.pause()
      if (trace) recordTelemetryStage(trace, '播放提交', { detail: settings.audioOutputDeviceId || '系统默认' })
      const playback = await playAudioBlob(targetBlob, settings.audioOutputDeviceId || undefined)
      if (!mountedRef.current || outputOperation !== outputOperationRef.current) {
        playback.audio.pause()
        URL.revokeObjectURL(playback.url)
        return
      }
      if (trace) recordTelemetryStage(trace, '开始播放')
      console.log('[playResult] playAudioBlob 返回: sinkApplied=%s', playback.sinkApplied)
      playbackRef.current = playback.audio
      playbackUrlRef.current = playback.url
      playback.audio.onended = () => {
        URL.revokeObjectURL(playback.url)
        if (playbackUrlRef.current === playback.url) playbackUrlRef.current = ''
      }
    } catch (playError) {
      const msg = playError instanceof Error ? playError.message : '播放失败'
      console.error('[playResult] 播放异常:', msg, playError)
      setError(msg)
      if (trace) recordTelemetryStage(trace, '播放出错', { detail: msg })
      else console.error('playResult 失败:', msg)
    }
  }, [outputAudioUrl, settings.audioOutputDeviceId])

  const playSoundEffect = useCallback(async (item: SoundEffectItem) => {
    try {
      console.log('[playSoundEffect] file=%s size=%d type=%s relayActive=%s outputDevice=%s',
        item.name, item.file.size, item.file.type,
        relayMixerRef.current.isActive(),
        settings.audioOutputDeviceId || '系统默认')
      if (relayMixerRef.current.isActive()) {
        const outputOperation = outputOperationRef.current
        await relayMixerRef.current.playBlob(item.file, () => mountedRef.current && outputOperation === outputOperationRef.current)
        setStatusText(`已注入音效：${item.name}`)
      } else {
        await playResult(item.file)
        setStatusText(`已播放音效：${item.name}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '音效播放失败')
    }
  }, [playResult, settings.audioOutputDeviceId])

  const toggleRelay = useCallback(async () => {
    if (relayPendingRef.current || relayMixerRef.current.isActive()) {
      stopRelay()
      return
    }
    const relayOperation = ++relayOperationRef.current
    const mixer = new AudioRelayMixer()
    relayMixerRef.current = mixer
    relayPendingRef.current = true
    setRelayStarting(true)
    setError('')
    setRelayStatus('正在接管麦克风并建立混音总线')
    try {
      const result = await mixer.start({
        inputDeviceId: settings.audioInputDeviceId || undefined,
        outputDeviceId: settings.audioOutputDeviceId || undefined,
      })
      if (!mountedRef.current || relayOperation !== relayOperationRef.current) {
        mixer.stop()
        return
      }
      setRelayActive(true)
      setRelayStatus(
        settings.audioOutputDeviceId
          ? `已启用：麦克风 + TTS + 音效混音到指定设备${result.sinkApplied ? '' : '（未确认 sink）'}`
          : '已启用：麦克风 + TTS + 音效混音到系统默认输出'
      )
      setOutputDevices(await listAudioOutputDevices().catch(() => []))
    } catch (relayError) {
      mixer.stop()
      if (!mountedRef.current || relayOperation !== relayOperationRef.current) return
      setRelayActive(false)
      setRelayStatus('启动失败')
      setError(relayError instanceof Error ? relayError.message : '无法启动麦克风中转')
    } finally {
      if (mountedRef.current && relayOperation === relayOperationRef.current) {
        relayPendingRef.current = false
        setRelayStarting(false)
      }
    }
  }, [relayStarting, settings.audioInputDeviceId, settings.audioOutputDeviceId, stopRelay])

  const changeOutputDevice = useCallback(async (deviceId: string) => {
    updateSettings({ audioOutputDeviceId: deviceId })
    if (!relayMixerRef.current.isActive()) return
    try {
      await relayMixerRef.current.setOutputDevice(deviceId)
      setRelayStatus(deviceId
        ? '已启用：麦克风 + TTS + 音效混音到指定设备'
        : '已启用：麦克风 + TTS + 音效混音到系统默认输出')
    } catch (sinkError) {
      setError(sinkError instanceof Error ? sinkError.message : '切换输出设备失败')
    }
  }, [updateSettings])

  const testOutput = useCallback(async () => {
    setTestingOutput(true)
    setOutputTest('正在播放短测试音…')
    try {
      const result = await testAudioOutputDevice(settings.audioOutputDeviceId || undefined)
      setOutputTest(
        settings.audioOutputDeviceId
          ? `指定输出通路已播放 · ${result.sampleRate}Hz${result.sinkApplied ? ' · sink 已应用' : ''}`
          : `系统默认输出通路已播放 · ${result.sampleRate}Hz`
      )
    } catch (testError) {
      setOutputTest(testError instanceof Error ? `输出测试失败：${testError.message}` : '输出测试失败')
    } finally {
      setTestingOutput(false)
    }
  }, [settings.audioOutputDeviceId])

  const importSoundEffects = useCallback((files: FileList | null) => {
    if (!files?.length) return
    const incoming = Array.from(files)
      .filter((file) => file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|opus|aac|m4a)$/i.test(file.name))
      .map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        file,
      }))
    if (!incoming.length) {
      setError('请选择音频文件')
      return
    }
    setError('')
    setSoundEffects((prev) => [...incoming, ...prev].slice(0, 48))
  }, [])

  const refreshRuntime = useCallback(async () => {
    const devices = await listAudioOutputDevices().catch(() => [])
    setOutputDevices(devices)
    if (!backendReady) {
      setHealth('未确认后端地址，Higgs 状态未检查')
      setVoicePresets([])
      return
    }
    const [healthResult, voicesResult, presetsResult] = await Promise.allSettled([
      api.higgsConnection({
        provider: settings.higgsTtsProvider,
        base_url: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteBaseUrl : settings.higgsTtsBaseUrl,
        api_token: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsApiToken : ''
      }),
      settings.higgsTtsProvider === 'local'
        ? api.higgsVoices(settings.higgsTtsBaseUrl)
        : Promise.resolve({ voices: [] }),
      api.higgsVoicePresets()
    ])
    if (healthResult.status === 'fulfilled') {
      const result = healthResult.value
      setHealth(result.connected ? `Higgs 已连接 · ${formatSec(result.elapsed_sec)}` : `Higgs 未连接 · ${result.message || '检查失败'}`)
    } else {
      setHealth(`Higgs 未连接 · ${healthResult.reason instanceof Error ? healthResult.reason.message : '检查失败'}`)
    }
    const remoteVoices: string[] = ['default']
    const presets: HiggsVoicePreset[] = []
    if (voicesResult.status === 'fulfilled') {
      remoteVoices.push(...(voicesResult.value.voices || []))
    }
    if (presetsResult.status === 'fulfilled') {
      presets.push(...presetsResult.value.presets)
      remoteVoices.push(...presetsResult.value.voices)
      presets.forEach((preset) => remoteVoices.push(preset.name))
    }
    const dedupedVoices = Array.from(new Set(remoteVoices.filter(Boolean)))
    updateSettings({ higgsTtsVoices: dedupedVoices })
    setVoicePresets(presets)
    setActiveVoice((current) => dedupedVoices.includes(current) ? current : settings.higgsTtsVoice || 'Elysia')
  }, [api, backendReady, settings.higgsTtsApiToken, settings.higgsTtsBaseUrl, settings.higgsTtsProvider, settings.higgsTtsRemoteBaseUrl, settings.higgsTtsVoice, updateSettings])

  const applyVoicePreset = useCallback((voiceName: string) => {
    const preset = voicePresets.find((p) => p.name === voiceName)
    if (preset) {
      updateSettings({
        higgsTtsVoice: voiceName,
        higgsTtsReferenceAudioDataUrl: preset.reference_audio || '',
        higgsTtsReferenceAudioName: preset.reference_audio ? `${preset.name} · 已保存音频` : '',
        higgsTtsReferenceUrl: preset.reference_url || '',
        higgsTtsReferenceText: preset.reference_text || '',
        higgsTtsReferenceCodesJson: preset.reference_codes_json || ''
      })
    } else {
      updateSettings({
        higgsTtsVoice: voiceName,
        higgsTtsReferenceAudioDataUrl: '',
        higgsTtsReferenceAudioName: '',
        higgsTtsReferenceUrl: '',
        higgsTtsReferenceText: '',
        higgsTtsReferenceCodesJson: ''
      })
    }
  }, [voicePresets, updateSettings])

  useEffect(() => {
    void refreshRuntime()
  }, [refreshRuntime])

  useEffect(() => {
    inputAudioUrlRef.current = inputAudioUrl
  }, [inputAudioUrl])

  useEffect(() => {
    outputAudioUrlRef.current = outputAudioUrl
  }, [outputAudioUrl])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopWork()
      stopRelay()
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      if (inputAudioUrlRef.current) URL.revokeObjectURL(inputAudioUrlRef.current)
      if (outputAudioUrlRef.current) URL.revokeObjectURL(outputAudioUrlRef.current)
    }
  }, [stopRelay, stopWork])

  const runTextTts = useCallback(async (text = ttsText, source: VoiceMode = 'text') => {
    if (['recording', 'processing', 'streaming'].includes(statusRef.current)) return null
    const clean = text.trim()
    if (!clean) {
      setError('请输入要合成的文本')
      updateStatus('error')
      return null
    }
    const operation = ++operationRef.current
    updateStatus('processing')
    setStatusText('Higgs TTS 合成中')
    setError('')
    // 覆盖 Electron 状态浮窗为 thinking 动画，清理之前录音残留的「语音输入中」
    void window.electronAPI?.showStatusOverlay('thinking', 0, 'Higgs TTS 合成中')
    const trace = startTelemetryTrace('tts', '文字 TTS', activeVoice || settings.higgsTtsVoice)
    try {
      recordTelemetryStage(trace, 'TTS 请求发送')
      const result = await api.higgsSpeak({ ...commonPayload(), text: clean })
      if (!isCurrent(operation)) return null
      recordTelemetryStage(trace, 'TTS 音频响应', { backendMs: result.timing.tts_sec * 1000 })
      applyResult(result, source)
      finishTelemetryTrace(trace, `${result.audio.size} bytes`)
      updateStatus('done')
      setStatusText(`${modeLabels[source]} 完成`)
      void window.electronAPI?.hideStatusOverlay()
      return result
    } catch (err) {
      if (!isCurrent(operation)) return null
      finishTelemetryTrace(trace, err instanceof Error ? err.message : 'TTS 合成失败', 'error')
      setError(err instanceof Error ? err.message : 'TTS 合成失败')
      updateStatus('error')
      setStatusText('合成失败')
      void window.electronAPI?.hideStatusOverlay()
      return null
    }
  }, [activeVoice, api, applyResult, commonPayload, isCurrent, settings.higgsTtsVoice, ttsText, updateStatus])

  const runAudioPipeline = useCallback(async (blob: Blob) => {
    const operation = ++operationRef.current
    updateStatus('processing')
    setStatusText('ASR 识别后合成 TTS')
    setError('')
    setTranscript('')
    // 覆盖 Electron 状态浮窗为 thinking 动画
    void window.electronAPI?.showStatusOverlay('thinking', 0, 'ASR 识别后合成 TTS')
    const trace = startTelemetryTrace('tts', '语音 ASR→TTS', settings.offlineEngine)
    try {
      recordTelemetryStage(trace, '语音上传发送', { detail: `${blob.size} bytes` })
      // Split ASR and TTS requests deliberately. The old combined endpoint only
      // exposed the ASR text in response headers after the entire TTS body had
      // completed, so a fast ASR result appeared frozen in the renderer.
      const asrResult = await api.referenceAudioAsr(
        blob,
        settings.offlineEngine,
        settings.defaultLanguage === 'auto' ? '' : settings.defaultLanguage,
      )
      if (!isCurrent(operation)) return
      const text = asrResult.text.trim()
      if (!text) throw new Error('ASR 未识别到有效文本')
      const asrSec = Number(asrResult.elapsed_sec || 0)
      const fillStartedAt = performance.now()
      setTranscript(text)
      setTtsText(text)
      const fillDispatchMs = performance.now() - fillStartedAt
      recordTelemetryStage(trace, 'ASR 结果立即回填', {
        durationMs: fillDispatchMs,
        backendMs: asrSec * 1000,
        detail: `${text.length} 字 · 前端调度 ${fillDispatchMs.toFixed(1)}ms`,
      })
      setStatusText('ASR 已回填，Higgs TTS 合成中')

      const ttsResult = await api.higgsSpeak({ ...commonPayload(), text })
      if (!isCurrent(operation)) return
      const result: HiggsAudioResult = {
        ...ttsResult,
        text,
        asr_engine: asrResult.engine || settings.offlineEngine,
        language: asrResult.language || undefined,
        confidence: asrResult.confidence,
        timing: {
          ...ttsResult.timing,
          asr_sec: asrSec,
          total_sec: asrSec + ttsResult.timing.total_sec,
          client_total_sec: asrSec + (ttsResult.timing.client_total_sec || ttsResult.timing.total_sec),
        },
      }
      recordTelemetryStage(trace, 'TTS 完成并接收音频', { durationMs: result.timing.tts_sec * 1000, backendMs: result.timing.tts_sec * 1000 })
      applyResult(result, 'voice')
      finishTelemetryTrace(trace, `${result.audio.size} bytes`)
      updateStatus('done')
      setStatusText('语音转 TTS 完成')
      void window.electronAPI?.hideStatusOverlay()
    } catch (err) {
      if (!isCurrent(operation)) return
      finishTelemetryTrace(trace, err instanceof Error ? err.message : '语音转 TTS 失败', 'error')
      setError(err instanceof Error ? err.message : '语音转 TTS 失败')
      updateStatus('error')
      setStatusText('处理失败')
      void window.electronAPI?.hideStatusOverlay()
    }
  }, [api, applyResult, commonPayload, isCurrent, settings.offlineEngine, settings.defaultLanguage, updateStatus])

  const streamConfig = useCallback(() => ({
    engine: settings.streamingEngine,
    language: settings.defaultLanguage,
    deviceId: settings.audioInputDeviceId || undefined,
    higgsBaseUrl: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteBaseUrl : settings.higgsTtsBaseUrl,
    provider: settings.higgsTtsProvider,
    apiToken: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsApiToken : '',
    model: settings.higgsTtsRemoteModel,
    voice: activeVoice || settings.higgsTtsVoice || 'Elysia',
    responseFormat: settings.higgsTtsFormat,
    speed: settings.higgsTtsSpeed,
    temperature: settings.higgsTtsTemperature,
    topP: settings.higgsTtsTopP,
    topK: settings.higgsTtsTopK,
    seed: settings.higgsTtsSeed,
    maxNewTokens: settings.higgsTtsMaxNewTokens,
    referenceAudio: settings.higgsTtsReferenceAudioDataUrl,
    referenceUrl: settings.higgsTtsReferenceUrl,
    referenceText: settings.higgsTtsReferenceText,
    referenceCodesJson: settings.higgsTtsReferenceCodesJson,
    emotion: settings.higgsTtsEmotion,
    style: settings.higgsTtsStyle,
    prosodySpeed: settings.higgsTtsProsodySpeed,
    pitch: settings.higgsTtsPitch,
    expressiveness: settings.higgsTtsExpressiveness,
    initialCodecChunkFrames: settings.higgsTtsInitialCodecChunkFrames,
    speculativePartialTts: true,
    archive: settings.allowServerDataCollection
  }), [
    settings.audioInputDeviceId,
    settings.defaultLanguage,
    settings.higgsTtsBaseUrl,
    settings.higgsTtsProvider,
    settings.higgsTtsApiToken,
    settings.higgsTtsRemoteBaseUrl,
    settings.higgsTtsRemoteModel,
    settings.higgsTtsFormat,
    settings.higgsTtsMaxNewTokens,
    settings.higgsTtsSeed,
    settings.higgsTtsSpeed,
    settings.higgsTtsTemperature,
    settings.higgsTtsTopK,
    settings.higgsTtsTopP,
    activeVoice,
    settings.higgsTtsVoice,
    settings.higgsTtsReferenceAudioDataUrl,
    settings.higgsTtsReferenceUrl,
    settings.higgsTtsReferenceText,
    settings.higgsTtsReferenceCodesJson,
    settings.higgsTtsEmotion,
    settings.higgsTtsStyle,
    settings.higgsTtsProsodySpeed,
    settings.higgsTtsPitch,
    settings.higgsTtsExpressiveness,
    settings.higgsTtsInitialCodecChunkFrames,
    settings.allowServerDataCollection,
    settings.streamingEngine
  ])

  const handleRecord = useCallback(async () => {
    if (statusRef.current === 'recording') {
      if (captureStarting) return
      const operation = operationRef.current
      statusRef.current = 'processing'
      updateStatus('processing')
      setStatusText('录音已停止，正在上传识别并合成 TTS')
      setPartialText('')
      void window.electronAPI?.showStatusOverlay('thinking', 0, '录音已停止，正在识别并合成 TTS')
      const recorder = recorderRef.current
      recorderRef.current = null
      if (!recorder) {
        setError('录音器状态异常，请重新录音')
        updateStatus('error')
        setStatusText('录音失败')
        return
      }
      try {
        const { blob } = await recorder.stop()
        if (!isCurrent(operation)) return
        if (!blob.size || blob.size < 800) throw new Error('没有录到有效音频')
        setInputAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
        await runAudioPipeline(blob)
      } catch (err) {
        if (!isCurrent(operation)) return
        setError(err instanceof Error ? err.message : '录音处理失败')
        updateStatus('error')
        setStatusText('录音处理失败')
        void window.electronAPI?.hideStatusOverlay()
      }
      return
    }

    if (['processing', 'streaming'].includes(statusRef.current)) return
    const operation = ++operationRef.current
    setCaptureStarting(true)

    if (streamClientRef.current) {
      streamClientRef.current.stop()
      streamClientRef.current = null
    }
    realtimePcmPlayerRef.current?.stop()
    realtimePcmPlayerRef.current = null
    setMode('voice')
    statusRef.current = 'recording'
    updateStatus('recording')
    setStatusText('录音中，再次点击停止并处理')
    void window.electronAPI?.showStatusOverlay('recording', 0)
    setError('')
    setTranscript('')
    setPartialText('')
    setInputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    const recorder = recorderRef.current || new AudioRecorder({ rejectLoopbackInput: true })
    recorderRef.current = recorder
    try {
      // Recognition owns a direct capture from the selected input device.
      // Relay output may contain TTS/effects and must never be used as ASR input.
      const preparedInput = recorder.takePreparedStream(settings.audioInputDeviceId || undefined)
      // 传入 onLevel 回调以启动 AudioContext 锚定录音流。WSL2 音频桥接
      // 下，如果只有 MediaRecorder 而没有 AudioContext 消费同一个流，音频
      // 子系统可能进入节能/节流模式，导致 MediaRecorder 收到底层交付不稳定
      // 的音频数据而卡顿。与 ASR 录音（speechRecorder）保持一致。
      await withTimeout(
        recorder.start(settings.audioInputDeviceId || undefined, preparedInput, (level) => {
          if (statusRef.current === 'recording') void window.electronAPI?.showStatusOverlay('recording', level)
        }),
        5000,
        '麦克风启动超时，请检查输入设备是否被其他软件独占'
      )
      if (!isCurrent(operation)) { recorder.cancel(); return }
      setCaptureStarting(false)
    } catch (err) {
      recorder.cancel()
      if (!isCurrent(operation)) return
      recorderRef.current = null
      setCaptureStarting(false)
      statusRef.current = 'error'
      setError(err instanceof Error ? err.message : '无法启动麦克风录音')
      updateStatus('error')
      setStatusText('录音启动失败')
      void window.electronAPI?.hideStatusOverlay()
    }
  }, [
    runAudioPipeline,
    captureStarting,
    isCurrent,
    settings.audioInputDeviceId,
    status,
  ])

  const handleFile = useCallback((file: File) => {
    if (['recording', 'processing', 'streaming'].includes(statusRef.current)) return
    setMode('voice')
    setInputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
    void runAudioPipeline(file)
  }, [runAudioPipeline])

  const toggleRealtime = useCallback(async () => {
    if (streamClientRef.current) {
      stopWork()
      return
    }
    if (['recording', 'processing', 'streaming'].includes(statusRef.current)) return

    if (!backendReady) {
      setError('未确认后端地址。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    const operation = ++operationRef.current
    setMode('realtime')
    updateStatus('streaming')
    setStatusText('正在连接实时 ASR + TTS…')
    setError('')
    setTranscript('')
    setLiveSegments([])
    realtimeChunkJobsRef.current.clear()
    const client = new VoiceTTSStreamingClient(settings.serverUrl, (event) => {
      if (!isCurrent(operation) || streamClientRef.current !== client) return
      if (event.type === 'accepted') {
        setStatusText('连接成功，等待模型加载…')
      } else if (event.type === 'loading') {
        setStatusText(event.message)
      } else if (event.type === 'ready') {
        setStatusText('模型已加载，正在预热…')
      } else if (event.type === 'configured') {
        setStatusText('连接成功，实时 ASR 正在监听')
      } else if (event.type === 'partial') {
        setPartialText(event.text)
      } else if (event.type === 'final') {
        setPartialText('')
        setTranscript((prev) => [prev, event.text].filter(Boolean).join('\n'))
      } else if (event.type === 'tts_start') {
        setStatusText('TTS 流式首包生成中')
        const ttsStartTrace = startTelemetryTrace('tts', `实时 ${event.speculative ? 'partial' : 'final'} TTS`, activeVoice || settings.higgsTtsVoice)
        realtimeTraceRef.current = ttsStartTrace
        recordTelemetryStage(ttsStartTrace, 'ASR 稳定增量', { durationMs: roundSec(event.timing.asr_sec) * 1000, detail: settings.streamingEngine })
      } else if (event.type === 'tts_chunk') {
        const jobKey = String(event.jobId ?? event.text)
        realtimeChunkJobsRef.current.add(jobKey)
        const sampleRate = Number(event.sampleRate || 24000) || 24000
        if (relayMixerRef.current.isActive()) {
          void relayMixerRef.current.pushPcm16(event.audio, sampleRate).catch((playError) => {
            setError(playError instanceof Error ? playError.message : '流式混音失败')
          })
        } else {
          if (!realtimePcmPlayerRef.current) {
            realtimePcmPlayerRef.current = new Pcm16ChunkPlayer(sampleRate, settings.audioOutputDeviceId || undefined)
          }
          const player = realtimePcmPlayerRef.current
          void player.start()
            .then(() => { if (isCurrent(operation)) return player.push(event.audio); player.stop() })
            .catch((playError) => {
              setError(playError instanceof Error ? playError.message : '流式播放失败')
            })
        }
        setStatusText(`TTS 流式播放中 · chunk ${event.seq}`)
        if (event.seq === 1 && realtimeTraceRef.current) {
          recordTelemetryStage(realtimeTraceRef.current, 'TTS 首个音频 chunk', {
            durationMs: roundSec(event.timing.tts_first_token_sec || event.timing.tts_first_chunk_sec) * 1000,
            detail: `端到端 ${roundSec(event.timing.e2e_first_audio_sec).toFixed(3)}s · ${event.sourceEvent || 'unknown'}`
          })
        }
      } else if (event.type === 'tts_done') {
        void (async () => {
          const remainingMs = relayMixerRef.current.isActive()
            ? await relayMixerRef.current.getPcmPlaybackRemainingMs()
            : await realtimePcmPlayerRef.current?.getPlaybackRemainingMs() || 0
          if (isCurrent(operation)) client.setOutputPlaybackActive(false, remainingMs + 350)
        })()
        updateStatus('streaming')
        setStatusText('实时 ASR 监听中')
        const doneTrace = realtimeTraceRef.current
        if (doneTrace) {
          recordTelemetryStage(doneTrace, 'TTS 流式完成', {
            durationMs: roundSec(event.timing.tts_sec) * 1000,
            detail: `${event.chunks} chunks · 总 ${roundSec(event.timing.total_sec).toFixed(3)}s`
          })
          finishTelemetryTrace(doneTrace, `总 ${roundSec(event.timing.total_sec).toFixed(3)}s · 端到端首包 ${roundSec(event.timing.e2e_first_audio_sec).toFixed(3)}s`)
          realtimeTraceRef.current = null
        }
        setLiveSegments((prev) => [
          {
            text: event.text,
            timing: roundSec(event.timing.e2e_first_audio_sec || event.timing.total_sec),
            totalTiming: roundSec(event.timing.total_sec),
            chunks: event.chunks,
          },
          ...prev
        ].slice(0, 6))
      } else if (event.type === 'tts') {
        const jobKey = String(event.jobId ?? event.text)
        const alreadyStreamed = realtimeChunkJobsRef.current.has(jobKey)
        const result: HiggsAudioResult = {
          audio: event.audio,
          text: event.text,
          sample_rate: event.sampleRate || undefined,
          asr_engine: settings.streamingEngine,
          language: settings.defaultLanguage,
          timing: {
            asr_sec: event.timing.asr_sec || 0,
            tts_sec: event.timing.tts_sec || 0,
            total_sec: event.timing.total_sec || 0,
            higgs_network_sec: event.timing.higgs_network_sec || 0,
            client_total_sec: event.timing.total_sec || 0
          }
        }
        applyResult(result, 'realtime')
        updateStatus('streaming')
        setStatusText('实时 ASR 监听中')
        // Record telemetry for non-streaming (or final) TTS result
        if (!alreadyStreamed) {
          const ttsTrace = realtimeTraceRef.current || startTelemetryTrace('tts', '实时完整 TTS', activeVoice || settings.higgsTtsVoice)
          recordTelemetryStage(ttsTrace, 'TTS 完整响应', {
            durationMs: roundSec(event.timing.tts_sec) * 1000,
            detail: `Higgs 网络 ${roundSec(event.timing.higgs_network_sec).toFixed(3)}s`
          })
          finishTelemetryTrace(ttsTrace, `总 ${roundSec(event.timing.total_sec).toFixed(3)}s`)
          realtimeTraceRef.current = null

          playResult(event.audio).catch((playError) => {
            setError(playError instanceof Error ? playError.message : '播放失败')
            setStatusText('TTS 播放失败，实时监听仍在继续')
          })
          setLiveSegments((prev) => [
            { text: event.text, timing: roundSec(event.timing.total_sec) },
            ...prev
          ].slice(0, 6))
        }
      } else if (event.type === 'speech_start') {
        setStatusText('检测到语音')
      } else if (event.type === 'speech_end') {
        setStatusText('语音结束，正在识别')
      } else if (event.type === 'echo_suppressed') {
        setStatusText(`已拦截 TTS 回声：${event.text || event.matchedText}`)
      } else if (event.type === 'error') {
        stopWork()
        setError(event.message)
        updateStatus('error')
      } else if (event.type === 'closed') {
        stopWork()
        setStatusText(event.intentional ? '实时流已停止' : '实时流异常断开')
        updateStatus(event.intentional ? 'idle' : 'error')
      }
    })
    streamClientRef.current = client
    try {
      await client.start(streamConfig())
      if (!isCurrent(operation)) client.stop()
    } catch (err) {
      if (!isCurrent(operation)) { client.stop(); return }
      stopWork()
      setError(err instanceof Error ? err.message : '实时模式启动失败')
      updateStatus('error')
    }
  }, [
    applyResult,
    settings.streamingEngine,
    settings.defaultLanguage,
    settings.audioOutputDeviceId,
    settings.serverUrl,
    status,
    playResult,
    streamConfig,
    isCurrent,
    stopWork,
    updateStatus,
    backendReady,
  ])

  const sendToOutput = useCallback(async () => {
    const blob = outputBlobRef.current
    if (!blob) return
    stopPlayback()
    const outputOperation = outputOperationRef.current
    setSendingOutput(true)
    setError('')
    try {
      if (relayMixerRef.current.isActive()) {
        await relayMixerRef.current.playBlob(blob, () => mountedRef.current && outputOperation === outputOperationRef.current)
      } else {
        const playback = await playAudioBlobToDevice(blob, settings.audioOutputDeviceId || undefined)
        if (!mountedRef.current || outputOperation !== outputOperationRef.current) { playback.stop(); return }
        if (settings.audioOutputDeviceId && !playback.sinkApplied) {
          playback.stop()
          throw new Error('无法使用所选输出设备，请重新选择或明确切换为系统默认输出。')
        }
        devicePlaybackRef.current = playback
      }
    } catch (err) {
      if (mountedRef.current && outputOperation === outputOperationRef.current) setError(err instanceof Error ? err.message : '发送到输出设备失败')
    } finally {
      if (mountedRef.current && outputOperation === outputOperationRef.current) setSendingOutput(false)
    }
  }, [settings.audioOutputDeviceId, stopPlayback])

  const working = ['recording', 'processing', 'streaming'].includes(status)
  const outputName = outputDevices.find((device) => device.deviceId === settings.audioOutputDeviceId)?.label || (settings.audioOutputDeviceId ? '已保存的输出设备' : '系统默认输出')
  const workLabel = status === 'recording' ? '语音转换 · 录音中' : status === 'streaming' ? '实时语音转换' : '语音合成处理中'
  useActivityTask('voice-work', working ? { label: workLabel, detail: statusText, page: 'voice', onStop: stopWork } : null)
  useActivityTask('voice-relay', relayActive || relayStarting ? { label: '麦克风中转', detail: relayStatus, page: 'voice', onStop: stopRelay } : null)

  return <div className="page voice-workbench-page">
    <header className="page-heading">
      <div><h1>语音合成</h1><p>把文字或声音变成所选音色，先试听，再决定输出到哪里。</p></div>
      <span className={`soft-badge ${status === 'done' ? 'success' : ''}`}>{statusText}</span>
    </header>

    <nav className="voice-task-tabs" aria-label="语音合成任务">
      {(['text', 'voice', 'realtime'] as VoiceMode[]).map((item, index) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>
        <span className="voice-task-number" aria-hidden="true">0{index + 1}</span><strong>{modeLabels[item]}</strong><small>{modeDescriptions[item]}</small>
      </button>)}
    </nav>

    {(working || relayActive || relayStarting) && <section className="voice-active-tasks" aria-label="语音合成活动任务">
      {working && <div><span><strong>{workLabel}</strong><small>{statusText}{status === 'processing' ? ' · 取消等待后不会播放迟到的结果。' : ''}</small></span><div className="row-actions">
        {status === 'recording' && <button type="button" disabled={captureStarting} onClick={() => void handleRecord()}>停止并处理</button>}
        <button type="button" onClick={stopWork}>{status === 'processing' ? '取消等待' : status === 'recording' ? '取消录音' : '停止实时模式'}</button>
      </div></div>}
      {(relayActive || relayStarting) && <div><span><strong>麦克风中转{relayStarting ? '正在启动' : '运行中'}</strong><small>{relayStatus}</small></span><button type="button" onClick={stopRelay}>停止中转</button></div>}
    </section>}

    <div className="voice-workspace-grid">
      <section className="panel voice-compose-panel" aria-label="语音输入与合成">
        <div className="section-head compact"><div><h2>{modeLabels[mode]}</h2><p>{modeDescriptions[mode]}</p></div></div>
        <div className="voice-choice-row">
          <label htmlFor="voice-preset">本次使用音色<select id="voice-preset" value={activeVoice} disabled={working} onChange={(event) => { setActiveVoice(event.target.value); applyVoicePreset(event.target.value) }}>
            {Array.from(new Set(['default', ...settings.higgsTtsVoices, settings.higgsTtsVoice].filter(Boolean))).map((voice) => <option key={voice} value={voice}>{voice === 'default' ? '服务默认音色' : voice}</option>)}
          </select></label>
          <button type="button" aria-expanded={modelSettingsOpen} aria-controls="voice-task-model-settings" onClick={() => setModelSettingsOpen((open) => !open)}>{modelSettingsOpen ? '收起模型配置' : '模型与音色配置'}</button>
        </div>
        {mode === 'text' && <div className="voice-mode-pane">
          <label htmlFor="voice-tts-input" className="voice-input-label">合成文本</label>
          <textarea id="voice-tts-input" value={ttsText} onChange={(event) => setTtsText(event.target.value)} rows={6} placeholder="输入你想让她说的话…" />
          <div className="voice-compose-footer"><small>{ttsText.trim().length} 字 · 生成后可自行试听或发送</small><button type="button" className="primary voice-run-button" disabled={working || !ttsText.trim()} onClick={() => void runTextTts()}>生成语音</button></div>
        </div>}
        {mode === 'voice' && <div className="voice-mode-pane">
          <div className="voice-record-surface"><span aria-hidden="true" className="voice-record-symbol">●</span><strong>{status === 'recording' ? captureStarting ? '正在打开麦克风…' : '正在录音' : '录下你想转换的声音'}</strong><p>只在你点击录音后打开麦克风。结束后识别文字，再生成新音色。</p></div>
          <div className="row-actions"><button type="button" className="primary" disabled={working} onClick={() => void handleRecord()}>录音</button><button type="button" disabled={working} onClick={() => fileRef.current?.click()}>上传音频</button></div>
          <input ref={fileRef} type="file" aria-label="转换音频文件" accept="audio/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) handleFile(file); event.currentTarget.value = '' }} />
          {inputAudioUrl && <div className="voice-input-preview"><small>原始音频 · 本机试听</small><audio controls src={inputAudioUrl} aria-label="原始音频本机试听" /></div>}
        </div>}
        {mode === 'realtime' && <div className="voice-mode-pane">
          <div className="voice-record-surface"><span aria-hidden="true" className="voice-record-symbol">≋</span><strong>边说边转换</strong><p>每段识别结果会自动合成并发送到 {outputName}。切换本页任务后仍可在上方停止；离开本页会停止采集。</p></div>
          <button type="button" className="primary voice-run-button" disabled={working} onClick={() => void toggleRealtime()}>开始实时转换</button>
          <div className="live-text" aria-live="polite">{partialText || transcript || '识别到的片段会显示在这里。'}</div>
          {liveSegments.length > 0 && <div className="live-segment-list">{liveSegments.map((item, index) => <article key={`${item.text}-${index}`}><span>首包 {formatSec(item.timing)}{item.totalTiming ? ` / 总 ${formatSec(item.totalTiming)}` : ''}</span><p>{item.text}</p></article>)}</div>}
        </div>}
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      <section className="panel voice-output-panel" aria-label="合成结果">
        <div className="section-head compact"><div><h2>合成结果</h2><p>{activeVoice || '默认音色'} · {settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteModel || 'Boson API' : '本地 Higgs TTS'}</p></div></div>
        {outputAudioUrl ? <>
          <div className="voice-local-preview"><h3>本机试听</h3><p>通过本机默认扬声器播放，不发送到虚拟输出设备。</p><audio ref={previewAudioRef} controls src={outputAudioUrl} aria-label="合成语音本机试听" onPlay={() => { outputOperationRef.current += 1; devicePlaybackRef.current?.stop(); devicePlaybackRef.current = null; playbackRef.current?.pause(); relayMixerRef.current.stopInjectedAudio() }} /></div>
          <div className="voice-output-send"><strong>发送到所选输出设备</strong><small>当前：{outputName}{relayActive ? ' · 叠加到麦克风中转' : ''}</small><div className="row-actions"><button type="button" className="primary" disabled={sendingOutput || working} onClick={() => void sendToOutput()}>{sendingOutput ? '正在发送…' : '发送到所选输出设备'}</button><button type="button" onClick={stopPlayback}>停止播放</button></div></div>
        </> : <div className="empty voice-result-empty"><span aria-hidden="true">♪</span><strong>等待第一段语音</strong><p>生成后，在这里试听并选择发送方式。</p></div>}
        {transcript && <div className="voice-transcript"><strong>识别 / 合成文本</strong><p>{transcript}</p></div>}
        <details className="voice-output-settings"><summary>输出设备设置 · {outputName}</summary><label htmlFor="voice-output-device">语音输出设备</label><div className="voice-device-row"><select id="voice-output-device" disabled={working || relayStarting} value={settings.audioOutputDeviceId} onChange={(event) => void changeOutputDevice(event.target.value)}><option value="">系统默认输出</option>{settings.audioOutputDeviceId && !outputDevices.some(device => device.deviceId === settings.audioOutputDeviceId) && <option value={settings.audioOutputDeviceId}>已保存的输出设备</option>}{outputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}</select><button type="button" onClick={() => void refreshRuntime()}>刷新</button><button type="button" disabled={testingOutput} onClick={() => void testOutput()}>{testingOutput ? '测试中' : '测试输出'}</button></div>{outputTest && <small>{outputTest}</small>}</details>
      </section>
    </div>

    {modelSettingsOpen && <section id="voice-task-model-settings" className="panel voice-model-settings" aria-label="TTS 模型设置"><div className="section-head compact"><div><h2>模型与音色配置</h2><p>复用已保存的服务连接、模型和音色，无需在每个模式重新配置。</p></div><button type="button" onClick={() => setModelSettingsOpen(false)}>收起</button></div><div className="voice-runtime-card"><span>{health || '尚未检查服务'}</span><button type="button" onClick={() => void refreshRuntime()}>检查服务</button></div><ModelsPage initialTab="tts" allowedTabs={['tts']} embedded /></section>}

    <section className="panel voice-advanced-panel"><button type="button" className="voice-advanced-toggle" aria-expanded={mixingOpen} aria-controls="voice-mixing-settings" onClick={() => setMixingOpen((open) => !open)}><span><strong>直播混音与音效</strong><small>需要麦克风透传或音效时再展开。</small></span><span aria-hidden="true">{mixingOpen ? '−' : '+'}</span></button>
      {mixingOpen && <div id="voice-mixing-settings" className="voice-mixing-body">
        <div className={`voice-relay-card ${relayActive ? 'active' : ''}`}><div><strong>麦克风音频中转</strong><small>{relayStatus}</small><small>将真实麦克风、TTS 和音效叠加到 {outputName}。请避免将同一虚拟声卡同时作为识别输入和输出。</small></div><button type="button" onClick={() => void toggleRelay()}>{relayActive || relayStarting ? '停止中转' : '启用中转'}</button></div>
        <div className="section-head compact"><div><h3>音效</h3><p>点击音效会直接发送到 {outputName}。</p></div><div className="row-actions"><button type="button" onClick={() => soundFileRef.current?.click()}>导入音效</button><button type="button" disabled={!soundEffects.length} onClick={() => setSoundEffects([])}>清空</button></div></div>
        <input ref={soundFileRef} type="file" accept="audio/*" multiple hidden onChange={(event) => { importSoundEffects(event.target.files); event.currentTarget.value = '' }} />
        {soundEffects.length ? <div className="sfx-grid">{soundEffects.map((item) => <article key={item.id}><button type="button" onClick={() => void playSoundEffect(item)}>{item.name}</button><button type="button" className="ghost tiny" onClick={() => setSoundEffects(prev => prev.filter(effect => effect.id !== item.id))}>移除</button></article>)}</div> : <p className="empty">尚未导入音效，可选择本地音频文件。</p>}
      </div>}
    </section>
  </div>
}
