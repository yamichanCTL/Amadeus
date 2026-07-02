import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, HiggsAudioResult, HiggsTTSRequest, type HiggsVoicePreset } from '@/services/api'
import { AudioRecorder, AudioRelayMixer, Pcm16ChunkPlayer, VoiceTTSStreamingClient, listAudioOutputDevices, playAudioBlob, playAudioBlobToDevice, testAudioOutputDevice } from '@/services/audio'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace, type TelemetryTrace } from '@/services/telemetry'
import { useASRStore } from '@/store/useASRStore'

type VoiceMode = 'voice' | 'text' | 'realtime'
type WorkStatus = 'idle' | 'recording' | 'processing' | 'streaming' | 'done' | 'error'

type SoundEffectItem = {
  id: string
  name: string
  file: File
}

const modeLabels: Record<VoiceMode, string> = {
  voice: '语音转 TTS',
  text: '文字转 TTS',
  realtime: '实时 ASR + TTS'
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

  const [mode, setMode] = useState<VoiceMode>('voice')
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [ttsText, setTtsText] = useState('你好，这是 Higgs Audio v3 的桌面端 TTS 测试。')
  const [transcript, setTranscript] = useState('')
  const [partialText, setPartialText] = useState('')
  const [inputAudioUrl, setInputAudioUrl] = useState('')
  const [outputAudioUrl, setOutputAudioUrl] = useState('')
  const [status, setStatus] = useState<WorkStatus>('idle')
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
        await relayMixerRef.current.playBlob(targetBlob)
        if (trace) recordTelemetryStage(trace, '已注入中转混音')
        console.log('[playResult] relay mixer playBlob 完成')
        return
      }
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      playbackRef.current?.pause()
      if (trace) recordTelemetryStage(trace, '播放提交', { detail: settings.audioOutputDeviceId || '系统默认' })
      const playback = await playAudioBlob(targetBlob, settings.audioOutputDeviceId || undefined)
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
        await relayMixerRef.current.playBlob(item.file)
        setStatusText(`已注入音效：${item.name}`)
      } else {
        await playAudioBlob(item.file, settings.audioOutputDeviceId || undefined)
        setStatusText(`已播放音效：${item.name}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '音效播放失败')
      setStatus('error')
    }
  }, [settings.audioOutputDeviceId])

  const toggleRelay = useCallback(async () => {
    if (relayMixerRef.current.isActive()) {
      relayMixerRef.current.stop()
      setRelayActive(false)
      setRelayStatus('已停止：麦克风不再透传')
      return
    }
    setError('')
    setRelayStatus('正在接管麦克风并建立混音总线')
    try {
      const result = await relayMixerRef.current.start({
        inputDeviceId: settings.audioInputDeviceId || undefined,
        outputDeviceId: settings.audioOutputDeviceId || undefined,
      })
      setRelayActive(true)
      setRelayStatus(
        settings.audioOutputDeviceId
          ? `已启用：麦克风 + TTS + 音效混音到指定设备${result.sinkApplied ? '' : '（未确认 sink）'}`
          : '已启用：麦克风 + TTS + 音效混音到系统默认输出'
      )
      setOutputDevices(await listAudioOutputDevices().catch(() => []))
    } catch (relayError) {
      relayMixerRef.current.stop()
      setRelayActive(false)
      setRelayStatus('启动失败')
      setError(relayError instanceof Error ? relayError.message : '无法启动麦克风中转')
    }
  }, [settings.audioInputDeviceId, settings.audioOutputDeviceId])

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

  useEffect(() => () => {
    streamClientRef.current?.stop()
    relayMixerRef.current.stop()
    realtimePcmPlayerRef.current?.stop()
    recorderRef.current?.cancel()
    playbackRef.current?.pause()
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
    if (inputAudioUrlRef.current) URL.revokeObjectURL(inputAudioUrlRef.current)
    if (outputAudioUrlRef.current) URL.revokeObjectURL(outputAudioUrlRef.current)
  }, [])

  useEffect(() => {
    if (mode !== 'voice' || status !== 'idle') return
    const recorder = recorderRef.current || new AudioRecorder({ rejectLoopbackInput: true })
    recorderRef.current = recorder
    void recorder.prepare(settings.audioInputDeviceId || undefined).catch(() => {
      if (recorderRef.current === recorder && statusRef.current === 'idle') {
        recorder.cancel()
        recorderRef.current = null
      }
    })
    return () => {
      if (recorderRef.current === recorder && statusRef.current === 'idle') {
        recorder.cancel()
        recorderRef.current = null
      }
    }
  }, [mode, settings.audioInputDeviceId, status])

  const runTextTts = useCallback(async (text = ttsText, source: VoiceMode = 'text') => {
    const clean = text.trim()
    if (!clean) {
      setError('请输入要合成的文本')
      setStatus('error')
      return null
    }
    setStatus('processing')
    setStatusText('Higgs TTS 合成中')
    setError('')
    // 覆盖 Electron 状态浮窗为 thinking 动画，清理之前录音残留的「语音输入中」
    void window.electronAPI?.showStatusOverlay('thinking', 0, 'Higgs TTS 合成中')
    const trace = startTelemetryTrace('tts', '文字 TTS', activeVoice || settings.higgsTtsVoice)
    try {
      recordTelemetryStage(trace, 'TTS 请求发送')
      const result = await api.higgsSpeak({ ...commonPayload(), text: clean })
      recordTelemetryStage(trace, 'TTS 音频响应', { backendMs: result.timing.tts_sec * 1000 })
      applyResult(result, source)
      await playResult(result.audio, trace)
      finishTelemetryTrace(trace, `${result.audio.size} bytes`)
      setStatus('done')
      setStatusText(`${modeLabels[source]} 完成`)
      void window.electronAPI?.hideStatusOverlay()
      return result
    } catch (err) {
      finishTelemetryTrace(trace, err instanceof Error ? err.message : 'TTS 合成失败', 'error')
      setError(err instanceof Error ? err.message : 'TTS 合成失败')
      setStatus('error')
      setStatusText('合成失败')
      void window.electronAPI?.hideStatusOverlay()
      return null
    }
  }, [activeVoice, api, applyResult, commonPayload, playResult, settings.higgsTtsVoice, ttsText])

  const runAudioPipeline = useCallback(async (blob: Blob) => {
    setStatus('processing')
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
      await playResult(result.audio, trace)
      finishTelemetryTrace(trace, `${result.audio.size} bytes`)
      setStatus('done')
      setStatusText('语音转 TTS 完成')
      void window.electronAPI?.hideStatusOverlay()
    } catch (err) {
      finishTelemetryTrace(trace, err instanceof Error ? err.message : '语音转 TTS 失败', 'error')
      setError(err instanceof Error ? err.message : '语音转 TTS 失败')
      setStatus('error')
      setStatusText('处理失败')
      void window.electronAPI?.hideStatusOverlay()
    }
  }, [api, applyResult, commonPayload, playResult, settings.offlineEngine, settings.defaultLanguage])

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
    if (status === 'recording') {
      statusRef.current = 'processing'
      setStatus('processing')
      setStatusText('录音已停止，正在上传识别并合成 TTS')
      setPartialText('')
      void window.electronAPI?.showStatusOverlay('thinking', 0, '录音已停止，正在识别并合成 TTS')
      const recorder = recorderRef.current
      recorderRef.current = null
      if (!recorder) {
        setError('录音器状态异常，请重新录音')
        setStatus('error')
        setStatusText('录音失败')
        return
      }
      try {
        const { blob } = await recorder.stop()
        if (!blob.size || blob.size < 800) throw new Error('没有录到有效音频')
        setInputAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
        await runAudioPipeline(blob)
      } catch (err) {
        setError(err instanceof Error ? err.message : '录音处理失败')
        setStatus('error')
        setStatusText('录音处理失败')
        void window.electronAPI?.hideStatusOverlay()
      }
      return
    }

    if (streamClientRef.current) {
      streamClientRef.current.stop()
      streamClientRef.current = null
    }
    realtimePcmPlayerRef.current?.stop()
    realtimePcmPlayerRef.current = null
    setMode('voice')
    statusRef.current = 'recording'
    setStatus('recording')
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
    } catch (err) {
      recorder.cancel()
      recorderRef.current = null
      statusRef.current = 'error'
      setError(err instanceof Error ? err.message : '无法启动麦克风录音')
      setStatus('error')
      setStatusText('录音启动失败')
      void window.electronAPI?.hideStatusOverlay()
    }
  }, [
    runAudioPipeline,
    settings.audioInputDeviceId,
    status,
  ])

  const handleFile = useCallback((file: File) => {
    setMode('voice')
    setInputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
    void runAudioPipeline(file)
  }, [runAudioPipeline])

  const toggleRealtime = useCallback(async () => {
    if (streamClientRef.current) {
      streamClientRef.current?.stop()
      streamClientRef.current = null
      realtimePcmPlayerRef.current?.stop()
      realtimePcmPlayerRef.current = null
      realtimeChunkJobsRef.current.clear()
      setStatus('idle')
      setStatusText('实时流已停止')
      setPartialText('')
      return
    }

    if (!backendReady) {
      setError('未确认后端地址。请先在设置中输入后端 IP/地址并点击确认。')
      return
    }
    setMode('realtime')
    setStatus('streaming')
    setStatusText('正在连接实时 ASR + TTS…')
    setError('')
    setTranscript('')
    setLiveSegments([])
    realtimeChunkJobsRef.current.clear()
    const client = new VoiceTTSStreamingClient(settings.serverUrl, (event) => {
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
            .then(() => player.push(event.audio))
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
          client.setOutputPlaybackActive(false, remainingMs + 350)
        })()
        setStatus('streaming')
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
        setStatus('streaming')
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
        client.setOutputPlaybackActive(false, 300)
        setError(event.message)
        setStatus('error')
      } else if (event.type === 'closed') {
        if (streamClientRef.current === client) streamClientRef.current = null
        setStatus((current) => {
          if (current !== 'streaming') return current
          if (event.intentional) {
            setStatusText('实时流已停止')
            return 'idle'
          }
          setStatusText('实时流异常断开')
          return 'error'
        })
      }
    })
    streamClientRef.current = client
    await client.start(streamConfig())
  }, [
    applyResult,
    settings.streamingEngine,
    settings.defaultLanguage,
    settings.audioOutputDeviceId,
    settings.serverUrl,
    status,
    playResult,
    streamConfig
  ])

  const busy = status === 'processing'

  return (
    <div className="page voice-workbench-page">
      <div className="page-heading">
        <div>
          <h1>变声器 / TTS</h1>
          <p>支持语音转 TTS、文字 TTS 和实时 ASR+TTS。</p>
        </div>
        <span className={`soft-badge ${status === 'done' || status === 'streaming' ? 'success' : ''}`}>{statusText}</span>
      </div>

      <div className="voice-workbench">
        <section className="panel voice-control-panel">
          <div className="mode-switch">
            {(['voice', 'text', 'realtime'] as VoiceMode[]).map((item) => (
              <button key={item} type="button" className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                {modeLabels[item]}
              </button>
            ))}
          </div>

          <div className="voice-form">
            <div className="voice-runtime-card wide">
              <span>{health || '尚未检查服务'}</span>
              <button type="button" onClick={() => void refreshRuntime()}>检查</button>
            </div>
            <label className="wide">
              本次使用音色
              <div className="inline-control">
                <select value={activeVoice} onChange={(event) => {
                  const nextVoice = event.target.value
                  setActiveVoice(nextVoice)
                  applyVoicePreset(nextVoice)
                }}>
                  {Array.from(new Set(['default', ...settings.higgsTtsVoices, settings.higgsTtsVoice].filter(Boolean))).map((voice) => (
                    <option key={voice} value={voice}>{voice}</option>
                  ))}
                </select>
                <button type="button" onClick={() => void refreshRuntime()} title="刷新音色列表和预设">刷新</button>
              </div>
              {activeVoice !== 'default' && (
                <small>
                  {(() => {
                    const preset = voicePresets.find((p) => p.name === activeVoice)
                    if (preset) {
                      return `参考来源：${preset.reference_codes_json ? 'Code JSON' : preset.reference_audio ? '已保存音频' : preset.reference_url ? preset.reference_url : '未知'}`
                    }
                    return settings.higgsTtsReferenceAudioDataUrl
                      ? `参考来源：${settings.higgsTtsReferenceAudioName || '已上传音频'}`
                      : settings.higgsTtsReferenceUrl
                        ? `参考来源：${settings.higgsTtsReferenceUrl}`
                        : settings.higgsTtsReferenceCodesJson
                          ? '参考来源：Code JSON'
                          : '未找到已保存的预设，后端将自动匹配参考信息'
                  })()}
                </small>
              )}
            </label>
            <label className="wide">
              语音输出设备
              <div className="inline-control">
                <select value={settings.audioOutputDeviceId} onChange={(event) => void changeOutputDevice(event.target.value)}>
                  <option value="">系统默认输出</option>
                  {outputDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
                  ))}
                </select>
                <button type="button" onClick={() => void refreshRuntime()}>刷新</button>
                <button type="button" disabled={testingOutput} onClick={() => void testOutput()}>
                  {testingOutput ? '测试中' : '测试输出'}
                </button>
              </div>
              {outputTest && <small>{outputTest}</small>}
            </label>
            <div className={`voice-relay-card wide ${relayActive ? 'active' : ''}`}>
              <div>
                <strong>麦克风音频中转</strong>
                <small>{relayStatus}</small>
                <small>中转输入已启用 AEC；实体扬声器仍建议使用耳机，虚拟声卡不要将同一 monitor 同时选为 ASR 输入。</small>
              </div>
              <button type="button" className={relayActive ? 'record-button recording' : 'primary'} onClick={() => void toggleRelay()}>
                {relayActive ? '停止中转' : '启用中转'}
              </button>
            </div>
          </div>
        </section>

        <section className="panel voice-action-panel">
          {mode === 'text' && (
            <div className="voice-mode-pane">
              <textarea value={ttsText} onChange={(event) => setTtsText(event.target.value)} rows={8} placeholder="输入要合成的文本" />
              <button type="button" className="primary voice-run-button" disabled={busy} onClick={() => void runTextTts()}>
                生成 TTS
              </button>
            </div>
          )}

          {mode === 'voice' && (
            <div className="voice-mode-pane">
              <div className="voice-capture-row">
                <button type="button" className={status === 'recording' ? 'record-button recording' : 'record-button primary'} disabled={busy} onClick={() => void handleRecord()}>
                  {status === 'recording' ? '停止并处理' : '录音'}
                </button>
                <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>上传音频</button>
                <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) handleFile(file)
                  event.currentTarget.value = ''
                }} />
              </div>
              {inputAudioUrl ? <audio controls src={inputAudioUrl} /> : <div className="empty voice-empty">点击录音后再次点击停止，前端会上传完整音频，后端完成 ASR 后送入 Higgs TTS；上传音频会直接处理完整文件。</div>}
            </div>
          )}

          {mode === 'realtime' && (
            <div className="voice-mode-pane">
              <button type="button" className={streamClientRef.current ? 'record-button recording' : 'primary voice-run-button'} onClick={() => void toggleRealtime()}>
                {streamClientRef.current ? '停止实时模式' : '开始实时 ASR + TTS'}
              </button>
              <div className="live-text">
                {partialText || transcript || '实时最终识别片段会逐段触发 Higgs TTS。'}
              </div>
              <div className="live-segment-list">
                {liveSegments.map((item, index) => (
                  <article key={`${item.text}-${index}`}>
                    <span>
                      首包 {formatSec(item.timing)}
                      {item.totalTiming ? ` / 总 ${formatSec(item.totalTiming)}` : ''}
                    </span>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </section>

        <section className="panel voice-output-panel">
          <div className="section-head compact">
            <div>
              <h2>输出</h2>
              <p>{settings.audioOutputDeviceId ? '播放按钮会输出到已选设备' : '播放按钮使用系统默认输出'}</p>
            </div>
            <button
              type="button"
              disabled={!outputBlobRef.current}
              onClick={() => {
                const blob = outputBlobRef.current
                if (!blob) return
                if (relayMixerRef.current.isActive()) {
                  // 中转激活时：注入 relay 混音总线，不影响麦克风透传
                  void relayMixerRef.current.playBlob(blob).catch((err) => setError(err instanceof Error ? err.message : '中转播放失败'))
                } else {
                  // 中转未激活：用独立 AudioContext 路由到指定设备，播放结束自动关闭
                  void playAudioBlobToDevice(blob, settings.audioOutputDeviceId || undefined).catch((err) => {
                    setError(err instanceof Error ? err.message : '播放到输出设备失败')
                  })
                }
              }}
            >播放到输出设备</button>
          </div>
          {outputAudioUrl ? <audio controls src={outputAudioUrl} /> : <div className="empty voice-empty">生成的 TTS 音频会显示在这里。</div>}
          {transcript && (
            <div className="voice-transcript">
              <strong>识别 / 合成文本</strong>
              <p>{transcript}</p>
            </div>
          )}
        </section>

        <section className="panel voice-sfx-panel">
          <div className="section-head compact">
            <div>
              <h2>音效</h2>
              <p>{settings.audioOutputDeviceId ? '点击后输出到已选设备' : '点击后输出到系统默认设备'}</p>
            </div>
            <div className="row-actions">
              <button type="button" onClick={() => soundFileRef.current?.click()}>导入音效</button>
              <button type="button" disabled={!soundEffects.length} onClick={() => setSoundEffects([])}>清空</button>
              <input ref={soundFileRef} type="file" accept="audio/*" multiple hidden onChange={(event) => {
                importSoundEffects(event.target.files)
                event.currentTarget.value = ''
              }} />
            </div>
          </div>
          {soundEffects.length ? (
            <div className="sfx-grid">
              {soundEffects.map((item) => (
                <article key={item.id}>
                  <button type="button" onClick={() => void playSoundEffect(item)}>{item.name}</button>
                  <button type="button" className="ghost tiny" onClick={() => setSoundEffects((prev) => prev.filter((effect) => effect.id !== item.id))}>移除</button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty voice-empty">导入常用音频后，可一键播放到当前输出设备。</div>
          )}
        </section>

      </div>
    </div>
  )
}
