import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, describeRequestError, isAbortError, isAsyncResponse, type HiggsHealthResult, type HiggsVoicePreset, type HiggsVoicesResult, type HotwordConfig, type ModelInfo, type TranscribeOptions } from '@/services/api'
import { AudioRecorder } from '@/services/audio'
import { DEFAULT_SETTINGS, useASRStore, type AsrModelConfig } from '@/store/useASRStore'
import { FormalAsrNotice } from '@/components/FormalAsrNotice'
import { ModelDownloads } from '@/components/ModelDownloads'
import { TaskModelSettings } from '@/components/TaskModelSettings'
import { isSelectedLocalRuntime } from '@/services/localRuntimeConnection'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'
import { ASR_ENGINE_LABELS as engineLabels, asrLoadPayload as buildAsrLoadPayload, fallbackAsrConfig, getAsrModelModes } from '@/services/asrModels'
export { getAsrModelModes } from '@/services/asrModels'
import './Models.css'

const xAsrVariants = [160, 480, 960, 1920] as const
export type ModelTab = 'asr' | 'llm' | 'tts'
export type AsrSettingsSection = 'all' | 'models' | 'downloads' | 'hotwords' | 'none'

const higgsEmotionOptions = [
  ['', '无'],
  ['affection', '亲切 / 爱意'],
  ['amusement', '愉快 / 好笑'],
  ['anger', '愤怒'],
  ['arousal', '高唤醒 / 强烈感'],
  ['awe', '敬畏 / 惊叹'],
  ['bitterness', '苦涩 / 怨恨'],
  ['confusion', '困惑'],
  ['contemplation', '沉思'],
  ['contentment', '满足 / 平静'],
  ['determination', '坚定'],
  ['disgust', '厌恶'],
  ['elation', '喜悦 / 兴高采烈'],
  ['enthusiasm', '热情 / 兴奋'],
  ['fear', '恐惧'],
  ['helplessness', '无助'],
  ['longing', '渴望 / 思念'],
  ['pride', '自豪 / 自信'],
  ['relief', '如释重负'],
  ['sadness', '悲伤'],
  ['shame', '羞愧'],
  ['surprise', '惊讶']
] as const

const higgsStyleOptions = [
  ['', '无'],
  ['singing', '歌唱式'],
  ['shouting', '喊叫'],
  ['whispering', '耳语']
] as const

const higgsProsodySpeedOptions = [
  ['', '无'],
  ['speed_very_slow', '很慢 ≈0.65x'],
  ['speed_slow', '慢 ≈0.85x'],
  ['speed_fast', '快 ≈1.2x'],
  ['speed_very_fast', '很快 ≈1.4x']
] as const

const higgsPitchOptions = [
  ['', '无'],
  ['pitch_low', '低音高 ≈-3 半音'],
  ['pitch_high', '高音高 ≈+2.5 半音']
] as const

const higgsExpressivenessOptions = [
  ['', '无'],
  ['expressive_high', '高表现力'],
  ['expressive_low', '低表现力 / 平直']
] as const

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('参考音频读取失败'))
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBlob(dataUrl: string) {
  const [header, payload = ''] = dataUrl.split(',', 2)
  if (!header.startsWith('data:')) throw new Error('参考音频格式不是 Data URL')
  const mediaType = header.slice(5).split(';', 1)[0] || 'application/octet-stream'
  if (header.toLowerCase().includes(';base64')) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mediaType })
  }
  return new Blob([decodeURIComponent(payload)], { type: mediaType })
}

function extensionFromMimeType(mimeType: string) {
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  return 'webm'
}

export function ModelsPage({ initialTab = 'asr', allowedTabs = ['asr', 'llm', 'tts'], embedded = false, asrSection = 'all', taskSelectionInShortcut = false }: {
  initialTab?: ModelTab; allowedTabs?: ModelTab[]; embedded?: boolean; asrSection?: AsrSettingsSection; taskSelectionInShortcut?: boolean
} = {}) {
  const settings = useASRStore((state) => state.settings)
  const serverStatus = useASRStore((state) => state.serverStatus)
  const models = useASRStore((state) => state.models)
  const setModels = useASRStore((state) => state.setModels)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const recognitionBusy = useASRStore((state) => state.asrModelLoading || state.fileBatchRunning
    || state.recordStatus !== 'idle' || !['idle', 'error'].includes(state.liveCaptionStatus)
    || ['uploading', 'processing', 'polling'].includes(state.transcribeStatus))
  const [activeTab, setActiveTab] = useState<ModelTab>(() => allowedTabs.includes(initialTab) ? initialTab : allowedTabs[0] || 'asr')
  const [busyEngines, setBusyEngines] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [ttsHealth, setTtsHealth] = useState<HiggsHealthResult | null>(null)
  const [ttsProbe, setTtsProbe] = useState(false)
  const [ttsDialogOpen, setTtsDialogOpen] = useState(false)
  const [voicePresets, setVoicePresets] = useState<HiggsVoicePreset[]>([])
  const [voicePresetBusy, setVoicePresetBusy] = useState(false)
  const [referenceTextBusy, setReferenceTextBusy] = useState(false)
  const [referenceRecording, setReferenceRecording] = useState(false)
  const [selectedAsrEngine, setSelectedAsrEngine] = useState<string>('')
  const [hotwordConfig, setHotwordConfig] = useState<HotwordConfig | null>(null)
  const [hotwordPreview, setHotwordPreview] = useState('')
  const [hotwordPreviewResult, setHotwordPreviewResult] = useState('')
  const [hotwordBusy, setHotwordBusy] = useState(false)
  const [localRuntime, setLocalRuntime] = useState<LocalRuntimeState | null>(null)
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null)
  const referenceRecorderRef = useRef<AudioRecorder | null>(null)
  const refreshControllerRef = useRef<AbortController | null>(null)
  const hotwordControllerRef = useRef<AbortController | null>(null)
  const localRuntimeRef = useRef<LocalRuntimeState | null>(null)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const currentVoicePreset = voicePresets.find((preset) => preset.name === settings.higgsTtsVoice)
  const ttsVoiceCount = Array.from(new Set([...settings.higgsTtsVoices, ...voicePresets.map((preset) => preset.name)])).filter(Boolean).length
  const referenceSource = settings.higgsTtsReferenceCodesJson.trim()
    ? 'Code JSON'
    : settings.higgsTtsReferenceAudioName
      ? settings.higgsTtsReferenceAudioName
      : settings.higgsTtsReferenceUrl.trim()
        ? '参考音频链接'
        : currentVoicePreset
          ? '已保存音色'
          : '未设置'
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const backendPaused = isSelectedLocalRuntime(localRuntime, settings.serverUrl)
    && ['stopping', 'installing', 'starting'].includes(localRuntime!.phase)
  const isBackendPaused = () => {
    const value = localRuntimeRef.current
    return isSelectedLocalRuntime(value, useASRStore.getState().settings.serverUrl)
      && ['stopping', 'installing', 'starting'].includes(value!.phase)
  }

  useEffect(() => {
    const host = window.electronAPI
    if (!host?.localRuntimeStatus || !host.onLocalRuntimeState) return
    let active = true
    let receivedEvent = false
    const receive = (value: LocalRuntimeState) => {
      if (!active) return
      localRuntimeRef.current = value
      setLocalRuntime(value)
      if (isSelectedLocalRuntime(value, useASRStore.getState().settings.serverUrl)
        && ['stopping', 'installing', 'starting'].includes(value.phase)) {
        refreshControllerRef.current?.abort()
        refreshControllerRef.current = null
        hotwordControllerRef.current?.abort()
        hotwordControllerRef.current = null
        setError('')
      }
    }
    const off = host.onLocalRuntimeState(value => { receivedEvent = true; receive(value) })
    void host.localRuntimeStatus().then(value => { if (!receivedEvent) receive(value) }).catch(() => {})
    return () => { active = false; off() }
  }, [])

  const refresh = useCallback(async () => {
    if (isBackendPaused()) return
    if (!backendReady) {
      refreshControllerRef.current?.abort(new DOMException('未确认后端地址', 'AbortError'))
      refreshControllerRef.current = null
      setModels([])
      setError('未确认后端地址，模型管理不会连接后端。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    refreshControllerRef.current?.abort(new DOMException('模型列表刷新已被新请求替代', 'AbortError'))
    const controller = new AbortController()
    refreshControllerRef.current = controller
    try {
      setError('')
      const nextModels = await api.models({ signal: controller.signal, timeoutMs: 20_000 })
      if (refreshControllerRef.current === controller && !controller.signal.aborted && !isBackendPaused()) {
        setModels(nextModels)
        const latest = useASRStore.getState().settings
        const discoveredOffline = nextModels.filter((model) => getAsrModelModes(model).includes('offline')).map((model) => model.engine)
        const discoveredStreaming = nextModels.filter((model) => getAsrModelModes(model).includes('streaming')).map((model) => model.engine)
        updateSettings({
          ...(discoveredOffline.length && !discoveredOffline.includes(latest.offlineEngine) ? { offlineEngine: discoveredOffline[0] } : {}),
          ...(discoveredStreaming.length && !discoveredStreaming.includes(latest.streamingEngine) ? { streamingEngine: discoveredStreaming[0] } : {}),
        })
      }
    } catch (modelError) {
      if (refreshControllerRef.current === controller && !controller.signal.aborted && !isBackendPaused() && !isAbortError(modelError)) {
        setError(describeRequestError(modelError, '模型列表获取失败'))
      }
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null
    }
  }, [api, backendReady, backendPaused, setModels, updateSettings])

  useEffect(() => {
    if (activeTab !== 'asr') return
    if (backendPaused) return
    void refresh()
    return () => {
      refreshControllerRef.current?.abort(new DOMException('模型管理页面已卸载', 'AbortError'))
      refreshControllerRef.current = null
    }
  }, [activeTab, refresh, backendPaused, serverStatus === 'connected'])

  useEffect(() => {
    if (activeTab !== 'asr') return
    if (backendPaused) return
    if (!backendReady) {
      setHotwordConfig(null)
      return
    }
    const controller = new AbortController()
    hotwordControllerRef.current = controller
    void api.hotwords(controller.signal).then(value => {
      if (hotwordControllerRef.current === controller && !controller.signal.aborted && !isBackendPaused()) setHotwordConfig(value)
    }).catch((loadError) => {
      if (hotwordControllerRef.current === controller && !controller.signal.aborted && !isBackendPaused() && !isAbortError(loadError)) {
        setError(loadError instanceof Error ? loadError.message : '热词配置读取失败')
      }
    })
    return () => {
      controller.abort()
      if (hotwordControllerRef.current === controller) hotwordControllerRef.current = null
    }
  }, [activeTab, api, backendReady, backendPaused])

  useEffect(() => {
    if (activeTab !== 'tts') return
    if (backendPaused) return
    if (!backendReady) {
      setTtsHealth(null)
      return
    }
    const timer = window.setTimeout(() => {
      void refreshTtsRuntime()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [activeTab, settings.higgsTtsApiToken, settings.higgsTtsBaseUrl, settings.higgsTtsProvider, settings.higgsTtsRemoteBaseUrl, api, backendReady, backendPaused])

  useEffect(() => () => {
    referenceRecorderRef.current?.cancel()
  }, [])

  const modelList = Array.isArray(models) ? models : []
  const rows: ModelInfo[] = modelList
  const offlineEngines = rows.filter((model) => getAsrModelModes(model).includes('offline')).map((model) => model.engine)
  const streamingEngines = rows.filter((model) => getAsrModelModes(model).includes('streaming')).map((model) => model.engine)
  const selectedModel = rows.find((model) => model.engine === selectedAsrEngine)
    || rows.find((model) => model.engine === settings.offlineEngine)
    || rows[0]
  const selectedConfig = selectedModel
    ? settings.asrModelConfigs[selectedModel.engine] || fallbackAsrConfig(selectedModel.engine, selectedModel)
    : null
  const showModelSettings = asrSection === 'all' || asrSection === 'models'
  const showHotwords = asrSection === 'all' || asrSection === 'hotwords'
  const scopedAsr = activeTab === 'asr' && embedded && asrSection !== 'all'

  const updateAsrConfig = (engine: string, patch: Partial<AsrModelConfig>) => {
    const current = settings.asrModelConfigs[engine] || fallbackAsrConfig(engine, rows.find((model) => model.engine === engine))
    updateSettings({
      asrModelConfigs: {
        ...settings.asrModelConfigs,
        [engine]: { ...current, ...patch }
      }
    })
  }

  const asrLoadPayload = (engine: string) => {
    const config = settings.asrModelConfigs[engine] || fallbackAsrConfig(engine, rows.find((model) => model.engine === engine))
    return buildAsrLoadPayload(engine, config)
  }

  const load = async (engine: string) => {
    if (recognitionBusy || useASRStore.getState().asrModelLoading || busyEngines.has(engine) || isBackendPaused()) return
    useASRStore.setState({ asrModelLoading: true })
    setBusyEngines((prev) => new Set(prev).add(engine))
    try {
      await api.loadModel(engine, asrLoadPayload(engine))
      await refresh()
    } catch (loadError) {
      if (!isBackendPaused()) setError(loadError instanceof Error ? loadError.message : `${engine} 模型加载失败`)
    } finally {
      useASRStore.setState({ asrModelLoading: false })
      setBusyEngines((prev) => {
        const next = new Set(prev)
        next.delete(engine)
        return next
      })
    }
  }

  const unload = async (engine: string) => {
    if (recognitionBusy || useASRStore.getState().asrModelLoading || busyEngines.has(engine) || isBackendPaused()) return
    useASRStore.setState({ asrModelLoading: true })
    setBusyEngines((prev) => new Set(prev).add(engine))
    try {
      await api.unloadModel(engine)
      await refresh()
    } catch (unloadError) {
      if (!isBackendPaused()) setError(unloadError instanceof Error ? unloadError.message : '模型卸载失败')
    } finally {
      useASRStore.setState({ asrModelLoading: false })
      setBusyEngines((prev) => {
        const next = new Set(prev)
        next.delete(engine)
        return next
      })
    }
  }

  const saveHotwords = async () => {
    if (!hotwordConfig || isBackendPaused()) return
    setHotwordBusy(true)
    setError('')
    try {
      setHotwordConfig(await api.saveHotwords({
        enabled: hotwordConfig.enabled,
        rule_enabled: hotwordConfig.rule_enabled,
        threshold: hotwordConfig.threshold,
        similar_threshold: hotwordConfig.similar_threshold,
        hotwords: hotwordConfig.hotwords,
        rules: hotwordConfig.rules
      }))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '热词保存失败')
    } finally {
      setHotwordBusy(false)
    }
  }

  const previewHotwords = async () => {
    if (!hotwordPreview.trim() || isBackendPaused()) return
    setHotwordBusy(true)
    try {
      const result = await api.previewHotwords(hotwordPreview)
      setHotwordPreviewResult(result.text)
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : '热词预览失败')
    } finally {
      setHotwordBusy(false)
    }
  }

  const refreshVoicePresets = async () => {
    if (!backendReady) return []
    const result = await api.higgsVoicePresets()
    setVoicePresets(result.presets)
    const voices = Array.from(new Set(['default', ...settings.higgsTtsVoices, ...result.voices, settings.higgsTtsVoice]
      .filter((voice): voice is string => typeof voice === 'string' && Boolean(voice.trim()))
      .map((voice) => voice.trim())))
    updateSettings({ higgsTtsVoices: voices })
    return result.presets
  }

  const refreshTtsRuntime = async () => {
    if (isBackendPaused()) return
    if (!backendReady) {
      setError('未确认后端地址，无法检查 TTS 运行状态。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    const baseUrl = settings.higgsTtsProvider === 'boson'
      ? settings.higgsTtsRemoteBaseUrl.trim() || 'https://api.boson.ai/v1'
      : settings.higgsTtsBaseUrl.trim() || 'http://localhost:8002'
    setTtsProbe(true)
    setError('')
    try {
      const health = await api.higgsConnection({
        provider: settings.higgsTtsProvider,
        base_url: baseUrl,
        api_token: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsApiToken : ''
      })
      setTtsHealth(health)
      const voiceResult: HiggsVoicesResult = settings.higgsTtsProvider === 'local'
        ? await api.higgsVoices(baseUrl).catch(() => ({ voices: [] }))
        : { voices: [] }
      const localPresets = voiceResult.presets || await refreshVoicePresets().catch(() => [])
      if (voiceResult.presets) setVoicePresets(voiceResult.presets)
      const localVoices = localPresets.map((preset) => preset.name)
      const voices = Array.from(new Set(['default', ...settings.higgsTtsVoices, ...voiceResult.voices, ...localVoices, settings.higgsTtsVoice]
        .filter((voice): voice is string => typeof voice === 'string' && Boolean(voice.trim()))
        .map((voice) => voice.trim())))
      updateSettings({
        ...(settings.higgsTtsProvider === 'boson' ? { higgsTtsRemoteBaseUrl: baseUrl } : { higgsTtsBaseUrl: baseUrl }),
        higgsTtsVoices: voices,
        higgsTtsVoice: voices.includes(settings.higgsTtsVoice) ? settings.higgsTtsVoice : 'Elysia'
      })
    } catch (ttsError) {
      if (isBackendPaused()) return
      setTtsHealth({
        connected: false,
        base_url: baseUrl,
        elapsed_sec: 0,
        message: ttsError instanceof Error ? ttsError.message : 'TTS 服务检查失败'
      })
    } finally {
      setTtsProbe(false)
    }
  }

  const applyVoicePreset = (preset: HiggsVoicePreset) => {
    updateSettings({
      higgsTtsVoice: preset.name,
      higgsTtsReferenceAudioDataUrl: preset.reference_audio || '',
      higgsTtsReferenceAudioName: preset.reference_audio ? `${preset.name} · 已保存音频` : '',
      higgsTtsReferenceUrl: preset.reference_url || '',
      higgsTtsReferenceText: preset.reference_text || '',
      higgsTtsReferenceCodesJson: preset.reference_codes_json || ''
    })
  }

  const saveVoicePreset = async () => {
    if (!backendReady) {
      setError('未确认后端地址，无法保存音色到后端。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    const name = settings.higgsTtsVoice.trim()
    if (!name) {
      setError('请先填写音色名')
      return
    }
    if (!settings.higgsTtsReferenceAudioDataUrl && !settings.higgsTtsReferenceUrl.trim() && !settings.higgsTtsReferenceCodesJson.trim()) {
      setError('请至少上传参考音频、填写参考音频链接或填写 Code JSON')
      return
    }
    setVoicePresetBusy(true)
    setError('')
    try {
      const result = await api.saveHiggsVoicePreset({
        name,
        higgs_base_url: settings.higgsTtsBaseUrl.trim() || 'http://localhost:8002',
        reference_audio: settings.higgsTtsReferenceAudioDataUrl,
        reference_url: settings.higgsTtsReferenceUrl,
        reference_text: settings.higgsTtsReferenceText,
        reference_codes_json: settings.higgsTtsReferenceCodesJson
      })
      setVoicePresets(result.presets)
      const voices = Array.from(new Set(['default', ...settings.higgsTtsVoices, ...result.voices, name]
        .filter((voice) => voice.trim())
        .map((voice) => voice.trim())))
      updateSettings({ higgsTtsVoice: result.preset.name, higgsTtsVoices: voices })
    } catch (presetError) {
      setError(presetError instanceof Error ? presetError.message : '音色保存失败')
    } finally {
      setVoicePresetBusy(false)
    }
  }

  const loadReferenceAudio = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) {
      setError('参考音频超过 50 MiB，请先裁剪或压缩')
      return
    }
    try {
      setError('')
      updateSettings({
        higgsTtsReferenceAudioDataUrl: await blobToDataUrl(file),
        higgsTtsReferenceAudioName: file.name
      })
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : '参考音频读取失败')
    }
  }

  const toggleReferenceRecording = async () => {
    if (referenceRecording) {
      const recorder = referenceRecorderRef.current
      referenceRecorderRef.current = null
      setReferenceRecording(false)
      if (!recorder) {
        setError('参考音频录音状态异常，请重新录音')
        return
      }
      try {
        setError('')
        const { blob, durationSec, mimeType } = await recorder.stop()
        if (!blob.size || durationSec < 0.2) throw new Error('录音太短，请重新录制参考音频')
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        updateSettings({
          higgsTtsReferenceAudioDataUrl: await blobToDataUrl(blob),
          higgsTtsReferenceAudioName: `reference-${timestamp}.${extensionFromMimeType(mimeType)}`
        })
      } catch (recordError) {
        setError(recordError instanceof Error ? recordError.message : '参考音频录音失败')
      }
      return
    }

    const recorder = new AudioRecorder({ rejectLoopbackInput: true })
    try {
      setError('')
      await recorder.start(settings.audioInputDeviceId || undefined)
      referenceRecorderRef.current = recorder
      setReferenceRecording(true)
    } catch (recordError) {
      recorder.cancel()
      referenceRecorderRef.current = null
      setReferenceRecording(false)
      setError(recordError instanceof Error ? recordError.message : '无法启动参考音频录音')
    }
  }

  const closeTtsDialog = () => {
    referenceRecorderRef.current?.cancel()
    referenceRecorderRef.current = null
    setReferenceRecording(false)
    setTtsDialogOpen(false)
  }

  const referenceTranscribeOptions = (): TranscribeOptions => ({
    engine: settings.offlineEngine,
    timeout_sec: settings.timeoutSec,
    language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
    whisper_model: settings.whisperModel,
    enable_punctuation: settings.enablePunctuation,
    enable_hotwords: true,
    allow_server_data_collection: settings.allowServerDataCollection
  })

  const waitReferenceTranscribeTask = async (taskId: string) => {
    const startedAt = Date.now()
    const timeoutMs = Math.max(30 * 60 * 1000, settings.timeoutSec * 1000)
    let pollCount = 0
    while (Date.now() - startedAt < timeoutMs) {
      // Query once immediately. A completed backend task must not sit behind
      // the old unconditional 1-second renderer delay before filling the text.
      const delayMs = pollCount === 0 ? 0 : pollCount < 10 ? 100 : pollCount < 30 ? 250 : 500
      pollCount += 1
      if (delayMs) await new Promise((resolve) => window.setTimeout(resolve, delayMs))
      const result = await api.task(taskId)
      if (['success', 'failed', 'cancelled'].includes(result.status)) return result
    }
    throw new Error('参考音频 ASR 任务超时')
  }

  const generateReferenceText = async () => {
    if (!backendReady) {
      setError('未确认后端地址，无法生成参考文本。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    if (!settings.higgsTtsReferenceAudioDataUrl) {
      setError('请先上传参考音频')
      return
    }
    setReferenceTextBusy(true)
    setError('')
    try {
      const audio = await dataUrlToBlob(settings.higgsTtsReferenceAudioDataUrl)
      const filename = settings.higgsTtsReferenceAudioName || `tts_reference_${Date.now()}.webm`
      const response = await api.transcribe(audio, filename, referenceTranscribeOptions())
      const result = isAsyncResponse(response) ? await waitReferenceTranscribeTask(response.task_id) : response
      if (result.status !== 'success') {
        throw new Error(`参考音频 ASR 任务${result.status === 'cancelled' ? '已取消' : '失败'}`)
      }
      if (!result.full_text.trim()) {
        setError('ASR 未识别到参考音频文本')
        return
      }
      updateSettings({ higgsTtsReferenceText: result.full_text.trim() })
    } catch (asrError) {
      setError(asrError instanceof Error ? asrError.message : '参考音频转文本失败')
    } finally {
      setReferenceTextBusy(false)
    }
  }

  if (activeTab === 'asr' && asrSection === 'none') return null

  return (
    <div className={`${embedded ? 'models-page models-embedded' : 'page models-page'}${activeTab === 'asr' ? ' asr-workspace' : ''}${scopedAsr ? ' asr-workspace-scoped' : ''}`}>
      <section className="panel">
        {!scopedAsr && <div className="panel-head">
          <div>
            {embedded ? <h2>{activeTab === 'asr' ? '识别模型与运行组件' : '语音合成模型'}</h2> : <h1>模型与服务连接</h1>}
            <p>{embedded ? activeTab === 'asr' ? '下载模型权重、检查运行依赖，并加载所选识别引擎。' : '配置语音合成连接、音色和参考音频。' : '模型按任务独立选择；同一服务连接可在不同任务中复用。'}</p>
          </div>
          {activeTab !== 'llm' && <button type="button" disabled={backendPaused || busyEngines.size > 0 || ttsProbe} onClick={() => { if (activeTab === 'asr') void refresh(); else void refreshTtsRuntime() }}>刷新</button>}
        </div>}
        {allowedTabs.length > 1 && <div className="model-tabs">
          {allowedTabs.includes('asr') && <button type="button" className={activeTab === 'asr' ? 'active' : ''} onClick={() => setActiveTab('asr')}>ASR 模型设置</button>}
          {allowedTabs.includes('llm') && <button type="button" className={activeTab === 'llm' ? 'active' : ''} onClick={() => setActiveTab('llm')}>按任务选择大模型</button>}
          {allowedTabs.includes('tts') && <button type="button" className={activeTab === 'tts' ? 'active' : ''} onClick={() => setActiveTab('tts')}>TTS 模型设置</button>}
        </div>}
        {error && !backendPaused && <p className="error">{error}</p>}
        {backendPaused && (asrSection !== 'downloads' || activeTab !== 'asr') && <p role="status">{localRuntime!.message}，服务恢复后会自动刷新状态。</p>}
        {activeTab === 'asr' && (
          <div className="asr-section">
            {(asrSection === 'all' || asrSection === 'downloads') && <ModelDownloads />}
            {showModelSettings && (
              <>
                <section className="asr-task-settings" aria-label="默认识别设置">
                  <div className="asr-task-fields">
                    {!taskSelectionInShortcut && <label>
                      <span>离线识别模型</span>
                      <select value={settings.offlineEngine} disabled={recognitionBusy} onChange={(event) => updateSettings({ offlineEngine: event.target.value })}>
                        {offlineEngines.map((engine) => <option key={engine} value={engine}>{engineLabels[engine] || engine}</option>)}
                      </select>
                    </label>}
                    {!taskSelectionInShortcut && <label>
                      <span>实时流式模型</span>
                      <select value={settings.streamingEngine} disabled={recognitionBusy} onChange={(event) => updateSettings({ streamingEngine: event.target.value })}>
                        {streamingEngines.map((engine) => <option key={engine} value={engine}>{engineLabels[engine] || engine}</option>)}
                      </select>
                    </label>}
                    <label>
                      <span>默认语言</span>
                      <select value={settings.defaultLanguage} onChange={(event) => updateSettings({ defaultLanguage: event.target.value })}>
                        <option value="zh">中文</option>
                        <option value="en">英文</option>
                        <option value="auto">自动</option>
                      </select>
                    </label>
                  </div>
                  <div className="asr-task-footer">
                    <small className="asr-task-hint">离线：文件 / 录音 · 实时：字幕 / 对话</small>
                    <label className="asr-check">
                      <input type="checkbox" checked={settings.enablePunctuation} onChange={(event) => updateSettings({ enablePunctuation: event.target.checked })} />
                      标点恢复
                    </label>
                    <span>已加载 {rows.filter((model) => model.is_loaded).length} / {rows.length} 个引擎</span>
                    <button type="button" disabled={backendPaused || busyEngines.size > 0} onClick={() => void refresh()}>刷新状态</button>
                  </div>
                </section>
                {asrSection === 'all' && settings.offlineEngine === 'formalasr' && <FormalAsrNotice />}
                <div className="asr-engine-workspace">
                  <section className="asr-engine-list" aria-label="识别引擎列表">
                    <div className="asr-list-heading"><span>可用引擎</span><small>{rows.length}</small></div>
                    <div className="asr-engine-options">
                      {rows.map((model) => (
                        <button
                          type="button"
                          key={model.engine}
                          className="asr-engine-option"
                          aria-pressed={selectedModel?.engine === model.engine}
                          aria-controls="asr-engine-detail"
                          onClick={() => setSelectedAsrEngine(model.engine)}
                        >
                          <span className="asr-engine-option-title">
                            <strong>{engineLabels[model.engine] || model.engine}</strong>
                            <span className={model.is_loaded ? 'asr-state-dot loaded' : 'asr-state-dot'} aria-hidden="true" />
                          </span>
                          <span className="asr-engine-option-meta">
                            {getAsrModelModes(model).map((mode) => mode === 'streaming' ? '实时' : '离线').join(' / ')}
                            <span>·</span>{model.is_loaded ? '已加载' : '未加载'}
                          </span>
                          {(settings.offlineEngine === model.engine || settings.streamingEngine === model.engine) && (
                            <span className="asr-engine-assignment">
                              {settings.offlineEngine === model.engine && <small>默认离线</small>}
                              {settings.streamingEngine === model.engine && <small>默认实时</small>}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </section>
                  {selectedModel && selectedConfig ? (
                    <article className="asr-engine-detail" id="asr-engine-detail" aria-label={`${engineLabels[selectedModel.engine] || selectedModel.engine} 配置`}>
                      <div className="asr-detail-heading">
                        <div>
                          <h3>{engineLabels[selectedModel.engine] || selectedModel.engine}</h3>
                          <p className="asr-configured-model" title={selectedConfig.modelName}>{selectedConfig.modelName}</p>
                        </div>
                        <span className={selectedModel.is_loaded ? 'asr-state-badge loaded' : 'asr-state-badge'}>
                          {busyEngines.has(selectedModel.engine) ? '正在处理' : selectedModel.is_loaded ? '已加载' : '待加载'}
                        </span>
                      </div>
                      <div className="asr-detail-actions">
                        {!taskSelectionInShortcut && <div>
                          {getAsrModelModes(selectedModel).includes('offline') && (
                            <button type="button" disabled={recognitionBusy || settings.offlineEngine === selectedModel.engine} onClick={() => updateSettings({ offlineEngine: selectedModel.engine })}>
                              {settings.offlineEngine === selectedModel.engine ? '离线使用中' : '设为离线'}
                            </button>
                          )}
                          {getAsrModelModes(selectedModel).includes('streaming') && (
                            <button type="button" disabled={recognitionBusy || settings.streamingEngine === selectedModel.engine} onClick={() => updateSettings({ streamingEngine: selectedModel.engine })}>
                              {settings.streamingEngine === selectedModel.engine ? '实时使用中' : '设为实时'}
                            </button>
                          )}
                        </div>}
                        {selectedModel.is_loaded ? (
                          <button type="button" disabled={recognitionBusy || backendPaused || busyEngines.has(selectedModel.engine)} onClick={() => void unload(selectedModel.engine)}>卸载</button>
                        ) : (
                          <button type="button" className="primary" disabled={recognitionBusy || backendPaused || busyEngines.has(selectedModel.engine)} onClick={() => void load(selectedModel.engine)}>
                            {busyEngines.has(selectedModel.engine) ? '加载中…' : '加载'}
                          </button>
                        )}
                      </div>
                      <dl className="asr-runtime" aria-label="当前运行状态">
                        <div><dt>当前运行设备</dt><dd>{selectedModel.is_loaded ? selectedModel.device || '后端未报告' : '尚未加载'}</dd></div>
                        <div><dt>当前运行精度</dt><dd>{selectedModel.is_loaded ? selectedModel.compute_type || '后端未报告' : '—'}</dd></div>
                      </dl>
                      {selectedModel.engine === 'formalasr' && (
                        <p className="asr-engine-description">中文口语直接整理为书面文本，去除口头禅与重复表达。录音结束后返回完整结果。</p>
                      )}
                      <div className="asr-detail-fields">
                        {selectedModel.engine === 'x-asr' && (
                          <fieldset className="asr-variants asr-wide">
                            <legend>流式窗口</legend>
                            <div>
                              {xAsrVariants.map((chunkMs) => {
                                const modelName = `chunk-${chunkMs}ms-model`
                                const available = Array.isArray(selectedModel.extra?.available_variants)
                                  ? selectedModel.extra.available_variants.includes(modelName)
                                  : false
                                return (
                                  <label key={chunkMs}>
                                    <input type="radio" name="xasr-model-variant" checked={selectedConfig.modelName === modelName} onChange={() => updateAsrConfig(selectedModel.engine, { modelName })} />
                                    <span>{chunkMs} ms</span><small>{available ? '已下载' : '未下载'}</small>
                                  </label>
                                )
                              })}
                            </div>
                          </fieldset>
                        )}
                        <label>
                          <span>加载设备</span>
                          <select value={selectedConfig.device} onChange={(event) => updateAsrConfig(selectedModel.engine, { device: event.target.value, deviceConfigured: true })}>
                            {['qwen3asr', 'formalasr'].includes(selectedModel.engine) && <option value="auto">自动（CPU / GPU）</option>}
                            <option value="cpu">CPU</option>
                            <option value="cuda">CUDA</option>
                            <option value="cuda:0">CUDA:0</option>
                          </select>
                        </label>
                        <label>
                          <span>计算精度 / dtype</span>
                          <input value={selectedConfig.computeType} placeholder={['qwen3asr', 'formalasr'].includes(selectedModel.engine) ? 'auto / float32 / bfloat16' : 'int8 / float16 / float32'} onChange={(event) => updateAsrConfig(selectedModel.engine, { computeType: event.target.value, deviceConfigured: true })} />
                        </label>
                        <p className="asr-field-hint asr-wide">
                          下次加载生效。{['qwen3asr', 'formalasr'].includes(selectedModel.engine)
                            ? 'auto 精度：CPU 使用 float32，CUDA 使用 bfloat16。'
                            : '请按可用硬件选择模型支持的精度。'}
                        </p>
                      </div>
                      <details className="asr-advanced" key={selectedModel.engine}>
                        <summary>模型路径与高级参数 <span>下次加载生效</span></summary>
                        <label>
                          <span>模型 / 路径</span>
                          <input value={selectedConfig.modelName} onChange={(event) => updateAsrConfig(selectedModel.engine, { modelName: event.target.value })} />
                          <small>填写模型名称或本机模型目录。CUDA 需要 NVIDIA 显卡及 CUDA 版运行环境。</small>
                        </label>
                        <label>
                          <span>参数 JSON</span>
                          <textarea rows={4} spellCheck={false} value={selectedConfig.extraJson} onChange={(event) => updateAsrConfig(selectedModel.engine, { extraJson: event.target.value })} />
                        </label>
                      </details>
                    </article>
                  ) : (
                    <div className="asr-empty">
                      <strong>暂未发现识别引擎</strong>
                      <p>连接后端后，刷新状态以读取可用模型。</p>
                    </div>
                  )}
                </div>
              </>
            )}
            {showHotwords && (hotwordConfig ? (
              <section className="asr-hotword-workspace" aria-label="热词纠错设置">
                <div className="asr-hotword-toolbar">
                  <label className="asr-check">
                    <input type="checkbox" checked={hotwordConfig.enabled} onChange={(event) => setHotwordConfig({ ...hotwordConfig, enabled: event.target.checked })} />
                    启用拼音热词纠错
                  </label>
                  <button type="button" className="primary" disabled={hotwordBusy} onClick={() => void saveHotwords()}>
                    {hotwordBusy ? '处理中…' : '保存热词'}
                  </button>
                </div>
                <div className="asr-hotword-columns">
                  <section className="asr-hotword-dictionary">
                    <label>
                      <span>热词词典</span>
                      <small>每行一个标准词，可补充别名和不替换的词语。</small>
                      <textarea rows={10} spellCheck={false} value={hotwordConfig.hotwords} placeholder="撒贝宁|撒贝你|撒贝林~~~撒贝宁工作室" onChange={(event) => setHotwordConfig({ ...hotwordConfig, hotwords: event.target.value })} />
                    </label>
                    <p className="asr-field-hint">兼容 hot.txt：标准词 | 别名 ~~~ 黑名单。保存后下次离线识别生效。</p>
                  </section>
                  <section className="asr-hotword-preview">
                    <label>
                      <span>效果预览</span>
                      <small>使用后端已保存的规则；编辑后请先保存。</small>
                      <textarea rows={4} value={hotwordPreview} placeholder="输入一段识别文本" onChange={(event) => setHotwordPreview(event.target.value)} />
                    </label>
                    <button type="button" disabled={hotwordBusy || !hotwordPreview.trim()} onClick={() => void previewHotwords()}>预览纠错结果</button>
                    <div className="asr-preview-result" aria-live="polite">
                      <span>纠错结果</span>
                      <p>{hotwordPreviewResult || '输入文本后，查看热词纠错效果。'}</p>
                    </div>
                  </section>
                </div>
                <details className="asr-advanced">
                  <summary>正则替换规则 <span>{hotwordConfig.rule_enabled ? '已开启' : '未开启'}</span></summary>
                  <label className="asr-check">
                    <input type="checkbox" checked={hotwordConfig.rule_enabled} onChange={(event) => setHotwordConfig({ ...hotwordConfig, rule_enabled: event.target.checked })} />
                    启用正则替换
                  </label>
                  <label>
                    <span>替换规则</span>
                    <textarea rows={5} spellCheck={false} value={hotwordConfig.rules} onChange={(event) => setHotwordConfig({ ...hotwordConfig, rules: event.target.value })} />
                    <small>兼容 hot-rule.txt，每行一条：正则 = 替换文本。例如 50赫兹 = 50Hz。</small>
                  </label>
                </details>
                <details className="asr-advanced">
                  <summary>高级匹配设置 <span>阈值</span></summary>
                  <div className="asr-detail-fields">
                    <label>
                      <span>自动替换阈值</span>
                      <input type="number" min="0" max="1" step="0.01" value={hotwordConfig.threshold} onChange={(event) => setHotwordConfig({ ...hotwordConfig, threshold: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>相似词提示阈值</span>
                      <input type="number" min="0" max="1" step="0.01" value={hotwordConfig.similar_threshold} onChange={(event) => setHotwordConfig({ ...hotwordConfig, similar_threshold: Number(event.target.value) })} />
                    </label>
                  </div>
                </details>
              </section>
            ) : (
              <div className="asr-empty"><strong>热词配置暂不可用</strong><p>请确认后端已连接，再刷新配置。</p><button type="button" disabled={!backendReady} onClick={() => { void api.hotwords().then(setHotwordConfig).catch((loadError) => setError(describeRequestError(loadError, '热词配置读取失败'))) }}>刷新配置</button></div>
            ))}
          </div>
        )}

        {activeTab === 'llm' && (
          <div className="model-section">
            <TaskModelSettings task="asr" />
            <TaskModelSettings task="summary" />
            <TaskModelSettings task="realtime" />
          </div>
        )}
        {activeTab === 'tts' && (
          <div className="model-section">
            <div className="tts-summary">
              <div className={ttsHealth?.connected ? 'provider-status connected' : 'provider-status'}>
                <div>
                  <strong>{ttsProbe ? '正在连接 Higgs' : ttsHealth?.connected ? 'Higgs 已连接' : 'Higgs 未连接'}</strong>
                  <span>{ttsHealth?.message || (ttsHealth ? `${ttsHealth.base_url} · ${ttsHealth.elapsed_sec.toFixed(3)}s` : '等待检测')}</span>
                </div>
                <button type="button" disabled={ttsProbe} onClick={() => void refreshTtsRuntime()}>
                  {ttsProbe ? '刷新中' : '刷新'}
                </button>
              </div>
              <div className="tts-summary-grid">
                <article>
                  <span>运行方式</span>
                  <strong>{settings.higgsTtsProvider === 'boson' ? 'Boson 远程 API' : '本地部署'}</strong>
                </article>
                <article>
                  <span>当前音色</span>
                  <strong>{settings.higgsTtsVoice || 'Elysia'}</strong>
                </article>
                <article>
                  <span>参考来源</span>
                  <strong>{referenceSource}</strong>
                </article>
                <article>
                  <span>已发现音色</span>
                  <strong>{ttsVoiceCount}</strong>
                </article>
              </div>
              <div className="model-settings-grid tts-inline-settings">
                <label>
                  TTS 来源
                  <select value={settings.higgsTtsProvider} onChange={(event) => updateSettings({ higgsTtsProvider: event.target.value as 'local' | 'boson' })}>
                    <option value="local">本地部署</option>
                    <option value="boson">Boson 远程 API</option>
                  </select>
                </label>
                {settings.higgsTtsProvider === 'boson' && (
                  <label>
                    远程模型
                    <input value={settings.higgsTtsRemoteModel} onChange={(event) => updateSettings({ higgsTtsRemoteModel: event.target.value })} />
                  </label>
                )}
                <label className="wide">
                  {settings.higgsTtsProvider === 'boson' ? 'Boson API 地址' : '本地 Higgs API 地址'}
                  <div className="inline-control">
                    <input
                      value={settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteBaseUrl : settings.higgsTtsBaseUrl}
                      placeholder={settings.higgsTtsProvider === 'boson' ? 'https://api.boson.ai/v1' : 'http://127.0.0.1:8002'}
                      onChange={(event) => updateSettings(settings.higgsTtsProvider === 'boson'
                        ? { higgsTtsRemoteBaseUrl: event.target.value }
                        : { higgsTtsBaseUrl: event.target.value })}
                    />
                    <button type="button" disabled={ttsProbe} onClick={() => void refreshTtsRuntime()}>{ttsProbe ? '检查中' : '检查 / 刷新音色'}</button>
                  </div>
                </label>
                {settings.higgsTtsProvider === 'boson' && (
                  <label className="wide">
                    API Token
                    <input type="password" value={settings.higgsTtsApiToken} placeholder="仅保存在本机，不写入日志" onChange={(event) => updateSettings({ higgsTtsApiToken: event.target.value })} />
                  </label>
                )}
                <label>
                  使用音色
                  <select value={settings.higgsTtsVoice} onChange={(event) => updateSettings({ higgsTtsVoice: event.target.value })}>
                    {Array.from(new Set(['default', ...settings.higgsTtsVoices, ...voicePresets.map((preset) => preset.name)])).map((voice) => (
                      <option key={voice} value={voice}>{voice}</option>
                    ))}
                  </select>
                </label>
                <label>
                  输出格式
                  <select value={settings.higgsTtsFormat} onChange={(event) => updateSettings({ higgsTtsFormat: event.target.value as typeof settings.higgsTtsFormat })}>
                    <option value="wav">wav</option>
                    <option value="mp3">mp3</option>
                    <option value="flac">flac</option>
                    <option value="opus">opus</option>
                    <option value="aac">aac</option>
                    <option value="pcm">pcm</option>
                  </select>
                </label>
                <div className="wide model-subhead">
                  <strong>句首控制标签</strong>
                  <span>这些字段会作为官方控制标签加到每句文本开头。</span>
                </div>
                <label>
                  情绪
                  <select value={settings.higgsTtsEmotion} onChange={(event) => updateSettings({ higgsTtsEmotion: event.target.value })}>
                    {higgsEmotionOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  风格
                  <select value={settings.higgsTtsStyle} onChange={(event) => updateSettings({ higgsTtsStyle: event.target.value })}>
                    {higgsStyleOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  模型韵律：语速
                  <select value={settings.higgsTtsProsodySpeed} onChange={(event) => updateSettings({ higgsTtsProsodySpeed: event.target.value })}>
                    {higgsProsodySpeedOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  模型韵律：音高
                  <select value={settings.higgsTtsPitch} onChange={(event) => updateSettings({ higgsTtsPitch: event.target.value })}>
                    {higgsPitchOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  模型韵律：表现力
                  <select value={settings.higgsTtsExpressiveness} onChange={(event) => updateSettings({ higgsTtsExpressiveness: event.target.value })}>
                    {higgsExpressivenessOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}
                  </select>
                </label>
                <div className="wide model-subhead">
                  <strong>生成参数</strong>
                  <span>直接透传给 Higgs 语音接口。</span>
                </div>
                <label>
                  API 播放速度 {settings.higgsTtsSpeed.toFixed(2)}x
                  <input type="range" min="0.25" max="4" step="0.05" value={settings.higgsTtsSpeed} onChange={(event) => updateSettings({ higgsTtsSpeed: Number(event.target.value) })} />
                </label>
                <label>
                  Temperature
                  <input type="number" min="0" max="2" step="0.05" value={settings.higgsTtsTemperature} onChange={(event) => updateSettings({ higgsTtsTemperature: Number(event.target.value) })} />
                </label>
                <label>
                  Top P
                  <input type="number" min="0" max="1" step="0.01" value={settings.higgsTtsTopP} onChange={(event) => updateSettings({ higgsTtsTopP: Number(event.target.value) })} />
                </label>
                <label>
                  Top K
                  <input type="number" min="0" max="500" step="1" value={settings.higgsTtsTopK} onChange={(event) => updateSettings({ higgsTtsTopK: Number(event.target.value) })} />
                </label>
                <label>
                  Seed
                  <input type="number" min="-1" step="1" value={settings.higgsTtsSeed} onChange={(event) => updateSettings({ higgsTtsSeed: Number(event.target.value) })} />
                </label>
                <label>
                  Max Tokens
                  <input type="number" min="16" max="8192" step="64" value={settings.higgsTtsMaxNewTokens} onChange={(event) => updateSettings({ higgsTtsMaxNewTokens: Number(event.target.value) })} />
                </label>
                <label>
                  流式首个 codec chunk 帧数
                  <input type="number" min="0" max="16" step="1" value={settings.higgsTtsInitialCodecChunkFrames} onChange={(event) => updateSettings({ higgsTtsInitialCodecChunkFrames: Number(event.target.value) })} />
                </label>
              </div>
              <div className="tts-summary-actions">
                <button type="button" className="primary" onClick={() => setTtsDialogOpen(true)}>
                  上传 / 保存音色
                </button>
                <button type="button" onClick={() => void refreshVoicePresets()}>
                  刷新已保存音色
                </button>
              </div>
            </div>
            {ttsDialogOpen && (
              <div className="modal-backdrop" role="presentation" onMouseDown={closeTtsDialog}>
                <section className="modal-panel tts-modal" role="dialog" aria-modal="true" aria-labelledby="tts-modal-title" onMouseDown={(event) => event.stopPropagation()}>
                  <div className="modal-head">
                    <div>
                      <h2 id="tts-modal-title">上传 / 保存音色</h2>
                      <p>上传参考音频、检查音频内容，并保存为可复用的本地音色。</p>
                    </div>
                    <button type="button" onClick={closeTtsDialog}>关闭</button>
                  </div>
                  <div className="tts-modal-body">
                    <div className="model-settings-grid">
                      <label className="wide">
                        保存为音色名
                        <input
                          list="higgs-tts-voices"
                          value={settings.higgsTtsVoice}
                          placeholder="给音色起一个名字"
                          onChange={(event) => updateSettings({ higgsTtsVoice: event.target.value })}
                          onBlur={(event) => updateSettings({ higgsTtsVoice: event.currentTarget.value.trim() || 'Elysia' })}
                        />
                        <datalist id="higgs-tts-voices">
                          {settings.higgsTtsVoices.map((voice) => <option key={voice} value={voice} />)}
                        </datalist>
                      </label>
                      <div className="wide model-subhead">
                        <strong>上传 / 保存音色</strong>
                        <span>保存后后端会记录到本地音色库；之后只选择这个音色名，也会自动套用参考信息。</span>
                      </div>
                      <label className="wide">
                        参考音频
                        <div className="inline-control">
                          <input
                            type="file"
                            accept="audio/*"
                            onChange={(event) => {
                              void loadReferenceAudio(event.currentTarget.files?.[0])
                              event.currentTarget.value = ''
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => updateSettings({ higgsTtsReferenceAudioDataUrl: '', higgsTtsReferenceAudioName: '' })}
                            disabled={!settings.higgsTtsReferenceAudioDataUrl || referenceRecording}
                          >
                            清除
                          </button>
                          <button type="button" className={referenceRecording ? 'record-button recording' : ''} onClick={() => void toggleReferenceRecording()}>
                            {referenceRecording ? '停止录音' : '录音输入'}
                          </button>
                        </div>
                        <small>{referenceRecording ? '正在录制参考音频...' : settings.higgsTtsReferenceAudioName || '未上传或录制参考音频'}</small>
                        {settings.higgsTtsReferenceAudioDataUrl && (
                          <audio
                            ref={referenceAudioRef}
                            controls
                            src={settings.higgsTtsReferenceAudioDataUrl}
                          />
                        )}
                      </label>
                      <label className="wide">
                        参考音频链接
                        <input value={settings.higgsTtsReferenceUrl} placeholder="https://.../reference.wav" onChange={(event) => updateSettings({ higgsTtsReferenceUrl: event.target.value })} />
                      </label>
                      <label className="wide">
                        参考音频准确文本
                        <div className="inline-control top">
                          <textarea rows={3} value={settings.higgsTtsReferenceText} placeholder="强烈建议填写音频中实际说出的完整文本" onChange={(event) => updateSettings({ higgsTtsReferenceText: event.target.value })} />
                          <button type="button" disabled={referenceTextBusy || referenceRecording || !settings.higgsTtsReferenceAudioDataUrl} onClick={() => void generateReferenceText()}>
                            {referenceTextBusy ? '识别中' : '当前 ASR 生成并填充'}
                          </button>
                        </div>
                      </label>
                      <label className="wide">
                        Code JSON
                        <textarea rows={4} value={settings.higgsTtsReferenceCodesJson} placeholder="[[1,2,3,4,5,6,7,8], ...]" onChange={(event) => updateSettings({ higgsTtsReferenceCodesJson: event.target.value })} />
                      </label>
                      <div className="wide tts-save-row">
                        <button type="button" className="primary" disabled={voicePresetBusy} onClick={() => void saveVoicePreset()}>
                          {voicePresetBusy ? '保存中' : '保存音色到后端'}
                        </button>
                        <button type="button" disabled={voicePresetBusy} onClick={() => void refreshVoicePresets()}>
                          刷新音色库
                        </button>
                      </div>
                      <div className="wide voice-preset-list">
                        {voicePresets.length ? voicePresets.map((preset) => (
                          <article key={preset.name}>
                            <div>
                              <strong>{preset.name}</strong>
                              <span>{preset.reference_codes_json ? 'Code JSON' : preset.reference_audio ? '上传音频' : preset.reference_url ? preset.reference_url : '未记录来源'}</span>
                            </div>
                            <button type="button" onClick={() => applyVoicePreset(preset)}>使用</button>
                          </article>
                        )) : (
                          <p className="empty">还没有保存的音色。</p>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
