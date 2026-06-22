import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, describeRequestError, isAbortError, isAsyncResponse, type HiggsHealthResult, type HiggsVoicePreset, type HiggsVoicesResult, type HotwordConfig, type LLMModelsResult, type ModelInfo, type TranscribeOptions } from '@/services/api'
import { AudioRecorder } from '@/services/audio'
import { getProviderPreset, LLM_PROVIDER_PRESETS, type LLMProvider } from '@/services/llmProviders'
import { useASRStore, type AsrModelConfig } from '@/store/useASRStore'

const builtInEngines = ['fireredasr2', 'sensevoice', 'qwen3asr', 'whisper', 'x-asr']
const streamingEngines = ['x-asr']
const offlineEngines = builtInEngines.filter((engine) => !streamingEngines.includes(engine))
const xAsrVariants = [160, 480, 960, 1920] as const
type ModelTab = 'asr' | 'llm' | 'translate' | 'tts'

const defaultAsrConfigs: Record<string, AsrModelConfig> = {
  fireredasr2: { modelName: 'FireRedASR2-AED', device: 'cuda', computeType: '', extraJson: '{"beam_size":3,"batch_size":1}' },
  sensevoice: { modelName: 'SenseVoiceSmall', device: 'cuda:0', computeType: '', extraJson: '{"batch_size_s":60}' },
  qwen3asr: { modelName: 'Qwen/Qwen3-ASR-1.7B', device: 'cuda:0', computeType: 'bfloat16', extraJson: '{}' },
  whisper: { modelName: 'base', device: 'cuda', computeType: 'float16', extraJson: '{}' },
  'x-asr': { modelName: 'chunk-960ms-model', device: 'cuda', computeType: '', extraJson: '{"num_threads":1,"text_format":"none"}' }
}

const engineLabels: Record<string, string> = {
  fireredasr2: 'FireRedASR2',
  sensevoice: 'SenseVoice',
  qwen3asr: 'Qwen3-ASR',
  whisper: 'Whisper',
  'x-asr': 'X-ASR'
}

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

export function ModelsPage() {
  const settings = useASRStore((state) => state.settings)
  const models = useASRStore((state) => state.models)
  const setModels = useASRStore((state) => state.setModels)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [activeTab, setActiveTab] = useState<ModelTab>('asr')
  const [busyEngines, setBusyEngines] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [llmModels, setLlmModels] = useState<LLMModelsResult | null>(null)
  const [translationModels, setTranslationModels] = useState<LLMModelsResult | null>(null)
  const [ttsHealth, setTtsHealth] = useState<HiggsHealthResult | null>(null)
  const [ttsProbe, setTtsProbe] = useState(false)
  const [ttsDialogOpen, setTtsDialogOpen] = useState(false)
  const [voicePresets, setVoicePresets] = useState<HiggsVoicePreset[]>([])
  const [voicePresetBusy, setVoicePresetBusy] = useState(false)
  const [referenceTextBusy, setReferenceTextBusy] = useState(false)
  const [referenceRecording, setReferenceRecording] = useState(false)
  const [expandedAsrEngine, setExpandedAsrEngine] = useState<string>('')
  const [hotwordConfig, setHotwordConfig] = useState<HotwordConfig | null>(null)
  const [hotwordPreview, setHotwordPreview] = useState('')
  const [hotwordPreviewResult, setHotwordPreviewResult] = useState('')
  const [hotwordBusy, setHotwordBusy] = useState(false)
  const [modelProbe, setModelProbe] = useState<'llm' | 'translate' | ''>('')
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null)
  const referenceRecorderRef = useRef<AudioRecorder | null>(null)
  const refreshControllerRef = useRef<AbortController | null>(null)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const llmPreset = getProviderPreset(settings.llmProvider)
  const translationPreset = getProviderPreset(settings.translationProvider)
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

  const refresh = useCallback(async () => {
    refreshControllerRef.current?.abort(new DOMException('模型列表刷新已被新请求替代', 'AbortError'))
    const controller = new AbortController()
    refreshControllerRef.current = controller
    try {
      setError('')
      const nextModels = await api.models({ signal: controller.signal, timeoutMs: 20_000 })
      if (refreshControllerRef.current === controller) setModels(nextModels)
    } catch (modelError) {
      if (!isAbortError(modelError)) setError(describeRequestError(modelError, '模型列表获取失败'))
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null
    }
  }, [api, setModels])

  useEffect(() => {
    void refresh()
    return () => {
      refreshControllerRef.current?.abort(new DOMException('模型管理页面已卸载', 'AbortError'))
      refreshControllerRef.current = null
    }
  }, [refresh])

  useEffect(() => {
    if (activeTab !== 'asr') return
    void api.hotwords().then(setHotwordConfig).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '热词配置读取失败')
    })
  }, [activeTab, api])

  useEffect(() => {
    if (activeTab !== 'llm') return
    if (!settings.llmBaseUrl.trim() || settings.llmApiToken.trim().length < 6) {
      setLlmModels(null)
      return
    }
    const timer = window.setTimeout(() => {
      void checkRemoteModels('llm')
    }, 650)
    return () => window.clearTimeout(timer)
  }, [activeTab, settings.llmProvider, settings.llmBaseUrl, settings.llmApiToken, api])

  useEffect(() => {
    if (activeTab !== 'translate') return
    const token = settings.translationApiToken.trim() || settings.llmApiToken.trim()
    if (!settings.translationBaseUrl.trim() || token.length < 6) {
      setTranslationModels(null)
      return
    }
    const timer = window.setTimeout(() => {
      void checkRemoteModels('translate')
    }, 650)
    return () => window.clearTimeout(timer)
  }, [
    activeTab,
    settings.translationProvider,
    settings.translationBaseUrl,
    settings.translationApiToken,
    settings.llmApiToken,
    api
  ])

  useEffect(() => {
    if (activeTab !== 'tts') return
    const timer = window.setTimeout(() => {
      void refreshTtsRuntime()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [activeTab, settings.higgsTtsApiToken, settings.higgsTtsBaseUrl, settings.higgsTtsProvider, settings.higgsTtsRemoteBaseUrl, api])

  useEffect(() => () => {
    referenceRecorderRef.current?.cancel()
  }, [])

  const modelList = Array.isArray(models) ? models : []
  const rows: ModelInfo[] = builtInEngines.map((engine) => modelList.find((model) => model.engine === engine) || {
    engine,
    model_name: settings.asrModelConfigs[engine]?.modelName || defaultAsrConfigs[engine]?.modelName || engine,
    is_loaded: false,
    device: null,
    compute_type: null,
    languages: [],
    extra: {}
  })

  const updateAsrConfig = (engine: string, patch: Partial<AsrModelConfig>) => {
    const current = settings.asrModelConfigs[engine] || defaultAsrConfigs[engine]
    updateSettings({
      asrModelConfigs: {
        ...settings.asrModelConfigs,
        [engine]: { ...current, ...patch }
      }
    })
  }

  const asrLoadPayload = (engine: string) => {
    const config = settings.asrModelConfigs[engine] || defaultAsrConfigs[engine]
    let extra: Record<string, unknown> = {}
    try {
      extra = config.extraJson.trim() ? JSON.parse(config.extraJson) as Record<string, unknown> : {}
    } catch {
      throw new Error(`${engine} 的参数 JSON 无效`)
    }
    return {
      model_name: config.modelName,
      device: config.device,
      compute_type: config.computeType || undefined,
      extra
    }
  }

  const load = async (engine: string) => {
    if (busyEngines.has(engine)) return
    setBusyEngines((prev) => new Set(prev).add(engine))
    try {
      await api.loadModel(engine, asrLoadPayload(engine))
      await refresh()
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `${engine} 模型加载失败`)
    } finally {
      setBusyEngines((prev) => {
        const next = new Set(prev)
        next.delete(engine)
        return next
      })
    }
  }

  const unload = async (engine: string) => {
    if (busyEngines.has(engine)) return
    setBusyEngines((prev) => new Set(prev).add(engine))
    try {
      await api.unloadModel(engine)
      await refresh()
    } catch (unloadError) {
      setError(unloadError instanceof Error ? unloadError.message : '模型卸载失败')
    } finally {
      setBusyEngines((prev) => {
        const next = new Set(prev)
        next.delete(engine)
        return next
      })
    }
  }

  const saveHotwords = async () => {
    if (!hotwordConfig) return
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
    if (!hotwordPreview.trim()) return
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

  const chooseLLMProvider = (provider: LLMProvider) => {
    const preset = getProviderPreset(provider)
    updateSettings({
      llmProvider: provider,
      llmBaseUrl: provider === 'custom' ? settings.llmBaseUrl : preset.baseUrl
    })
  }

  const chooseTranslationProvider = (provider: LLMProvider) => {
    const preset = getProviderPreset(provider)
    updateSettings({
      translationProvider: provider,
      translationBaseUrl: provider === 'custom' ? settings.translationBaseUrl : preset.baseUrl
    })
  }

  const checkRemoteModels = async (kind: 'llm' | 'translate') => {
    const isTranslate = kind === 'translate'
    const baseUrl = isTranslate ? settings.translationBaseUrl : settings.llmBaseUrl
    const apiToken = isTranslate
      ? settings.translationApiToken.trim() || settings.llmApiToken.trim()
      : settings.llmApiToken
    const provider = isTranslate ? settings.translationProvider : settings.llmProvider
    if (!baseUrl.trim() || !apiToken.trim()) {
      const empty: LLMModelsResult = {
        connected: false,
        models: [],
        provider,
        base_url: baseUrl,
        message: '请先填写接口地址和 API Token'
      }
      if (isTranslate) setTranslationModels(empty)
      else setLlmModels(empty)
      return
    }
    setModelProbe(kind)
    try {
      const result = await api.listLLMModels({
        base_url: baseUrl,
        api_token: apiToken,
        provider
      })
      if (isTranslate) setTranslationModels(result)
      else setLlmModels(result)
    } catch (probeError) {
      const failed: LLMModelsResult = {
        connected: false,
        models: [],
        provider,
        base_url: baseUrl,
        message: probeError instanceof Error ? probeError.message : '模型连接检测失败'
      }
      if (isTranslate) setTranslationModels(failed)
      else setLlmModels(failed)
    } finally {
      setModelProbe('')
    }
  }

  const chooseRemoteModel = (kind: 'llm' | 'translate', model: string) => {
    if (kind === 'translate') updateSettings({ translationModel: model })
    else updateSettings({ llmModel: model })
  }

  const refreshVoicePresets = async () => {
    const result = await api.higgsVoicePresets()
    setVoicePresets(result.presets)
    const voices = Array.from(new Set(['default', ...settings.higgsTtsVoices, ...result.voices, settings.higgsTtsVoice]
      .filter((voice): voice is string => typeof voice === 'string' && Boolean(voice.trim()))
      .map((voice) => voice.trim())))
    updateSettings({ higgsTtsVoices: voices })
    return result.presets
  }

  const refreshTtsRuntime = async () => {
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

    const recorder = new AudioRecorder()
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
    language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
    whisper_model: settings.whisperModel,
    enable_punctuation: settings.enablePunctuation,
    enable_hotwords: true,
    allow_server_data_collection: settings.allowServerDataCollection,
    archive_dir: settings.archiveDir || undefined
  })

  const waitReferenceTranscribeTask = async (taskId: string) => {
    const startedAt = Date.now()
    const timeoutMs = settings.timeoutSec === 0 ? 30 * 60 * 1000 : settings.timeoutSec * 1000
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      const result = await api.task(taskId)
      if (['success', 'failed', 'cancelled'].includes(result.status)) return result
    }
    throw new Error('参考音频 ASR 任务超时')
  }

  const generateReferenceText = async () => {
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

  const renderProviderProbe = (kind: 'llm' | 'translate', result: LLMModelsResult | null) => {
    const isChecking = modelProbe === kind
    const hasToken = kind === 'translate'
      ? Boolean(settings.translationApiToken.trim() || settings.llmApiToken.trim())
      : Boolean(settings.llmApiToken.trim())
    return (
      <div className={result?.connected ? 'provider-status connected' : 'provider-status'}>
        <div>
          <strong>{isChecking ? '正在连接官方接口' : result?.connected ? '连接成功' : '未连接'}</strong>
          <span>{result?.message || (hasToken ? '等待检测' : '填写 API Token 后自动检测')}</span>
        </div>
        <button type="button" disabled={isChecking} onClick={() => void checkRemoteModels(kind)}>
          {isChecking ? '检测中' : '刷新模型'}
        </button>
        {result?.models.length ? (
          <div className="remote-model-list">
            <select
              value={kind === 'translate' ? settings.translationModel : settings.llmModel}
              onChange={(event) => chooseRemoteModel(kind, event.target.value)}
            >
              <option value="">选择可用模型</option>
              {result.models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
            {result.models.map((model) => (
              <button key={model} type="button" onClick={() => chooseRemoteModel(kind, model)}>
                {model}
              </button>
            ))}
          </div>
        ) : (
          <p className="empty">暂无可选模型。</p>
        )}
      </div>
    )
  }

  return (
    <div className="page models-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h1>模型管理</h1>
            <p>集中管理 ASR、本地模型和 OpenAI 兼容模型配置。</p>
          </div>
          <button type="button" disabled={busyEngines.size > 0} onClick={() => void refresh()}>刷新</button>
        </div>
        <div className="model-tabs">
          <button type="button" className={activeTab === 'asr' ? 'active' : ''} onClick={() => setActiveTab('asr')}>ASR 模型设置</button>
          <button type="button" className={activeTab === 'llm' ? 'active' : ''} onClick={() => setActiveTab('llm')}>大模型设置</button>
          <button type="button" className={activeTab === 'translate' ? 'active' : ''} onClick={() => setActiveTab('translate')}>翻译模型设置</button>
          <button type="button" className={activeTab === 'tts' ? 'active' : ''} onClick={() => setActiveTab('tts')}>TTS 模型设置</button>
        </div>
        {error && <p className="error">{error}</p>}
        {activeTab === 'asr' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                离线识别模型
                <select value={settings.offlineEngine} onChange={(event) => updateSettings({ offlineEngine: event.target.value })}>
                  {offlineEngines.map((engine) => <option key={engine} value={engine}>{engineLabels[engine] || engine}</option>)}
                </select>
                <small>文件、录音和参考音频使用完整音频离线识别</small>
              </label>
              <label>
                实时流式模型
                <select value={settings.streamingEngine} onChange={(event) => updateSettings({ streamingEngine: event.target.value })}>
                  {streamingEngines.map((engine) => <option key={engine} value={engine}>{engineLabels[engine] || engine}</option>)}
                </select>
                <small>实时字幕和实时对话只使用原生流式解码</small>
              </label>
              <label>
                默认语言
                <select value={settings.defaultLanguage} onChange={(event) => updateSettings({ defaultLanguage: event.target.value })}>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                  <option value="auto">自动</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.enablePunctuation} onChange={(event) => updateSettings({ enablePunctuation: event.target.checked })} />
                标点恢复
              </label>
            </div>
            <div className="model-table">
              {rows.map((model) => {
                const config = settings.asrModelConfigs[model.engine] || defaultAsrConfigs[model.engine]
                const isExpanded = expandedAsrEngine === model.engine
                return (
                  <article key={model.engine} className={isExpanded ? 'model-row expanded' : 'model-row'}>
                    <button type="button" className="model-row-main" onClick={() => setExpandedAsrEngine(isExpanded ? '' : model.engine)}>
                      <div>
                        <strong>{engineLabels[model.engine] || model.engine}</strong>
                        <span>{model.model_name}</span>
                        <small>{Boolean(model.extra?.supports_streaming) || model.engine === 'x-asr' ? '真流式模型' : '离线模型'}</small>
                      </div>
                      <span className={model.is_loaded ? 'loaded' : 'unloaded'}>{model.is_loaded ? '已加载' : '未加载'}</span>
                      <span>{model.device || config.device || '-'}</span>
                      <span>{model.compute_type || config.computeType || '-'}</span>
                    </button>
                    <div className="row-actions">
                      <button type="button" onClick={() => model.engine === 'x-asr'
                        ? updateSettings({ streamingEngine: model.engine })
                        : updateSettings({ offlineEngine: model.engine })}>
                        {(model.engine === 'x-asr' && settings.streamingEngine === model.engine)
                          || (model.engine !== 'x-asr' && settings.offlineEngine === model.engine) ? '使用中' : model.engine === 'x-asr' ? '设为实时' : '设为离线'}
                      </button>
                      {model.is_loaded ? (
                        <button type="button" disabled={busyEngines.has(model.engine)} onClick={() => unload(model.engine)}>卸载</button>
                      ) : (
                        <button type="button" disabled={busyEngines.has(model.engine)} onClick={() => load(model.engine)}>加载</button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="model-detail-grid">
                        {model.engine === 'x-asr' ? (
                          <fieldset className="xasr-variant-picker wide">
                            <legend>流式窗口模型（选择后点击加载完成切换）</legend>
                            {xAsrVariants.map((chunkMs) => {
                              const modelName = `chunk-${chunkMs}ms-model`
                              const available = Array.isArray(model.extra?.available_variants)
                                ? model.extra.available_variants.includes(modelName)
                                : false
                              return (
                                <label key={chunkMs}>
                                  <input
                                    type="radio"
                                    name="xasr-model-variant"
                                    checked={config.modelName === modelName}
                                    onChange={() => updateAsrConfig(model.engine, { modelName })}
                                  />
                                  <span>{chunkMs} ms</span>
                                  <small>{available ? '已下载' : '未下载'}</small>
                                </label>
                              )
                            })}
                            <small>来源：Hugging Face · GilgameshWind/X-ASR-zh-en</small>
                          </fieldset>
                        ) : (
                          <label>
                            模型 / 路径
                            <input value={config.modelName} onChange={(event) => updateAsrConfig(model.engine, { modelName: event.target.value })} />
                          </label>
                        )}
                        <label>
                          启动方式
                          <select value={config.device} onChange={(event) => updateAsrConfig(model.engine, { device: event.target.value })}>
                            <option value="cpu">CPU</option>
                            <option value="cuda">CUDA</option>
                            <option value="cuda:0">CUDA:0</option>
                          </select>
                        </label>
                        <label>
                          Compute / dtype
                          <input value={config.computeType} placeholder={model.engine === 'qwen3asr' ? 'bfloat16' : 'int8 / float16 / float32'} onChange={(event) => updateAsrConfig(model.engine, { computeType: event.target.value })} />
                        </label>
                        <label className="wide">
                          参数 JSON
                          <textarea rows={3} value={config.extraJson} onChange={(event) => updateAsrConfig(model.engine, { extraJson: event.target.value })} />
                        </label>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
            {hotwordConfig && (
              <section className="hotword-editor">
                <div className="section-head compact">
                  <div>
                    <h2>离线识别热词</h2>
                    <p>兼容 CapsWriter 写法，保存后下一次离线识别立即生效。</p>
                  </div>
                  <button type="button" disabled={hotwordBusy} onClick={() => void saveHotwords()}>
                    {hotwordBusy ? '处理中' : '保存热词'}
                  </button>
                </div>
                <div className="model-settings-grid">
                  <label className="check">
                    <input type="checkbox" checked={hotwordConfig.enabled} onChange={(event) => setHotwordConfig({ ...hotwordConfig, enabled: event.target.checked })} />
                    启用拼音热词纠错
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={hotwordConfig.rule_enabled} onChange={(event) => setHotwordConfig({ ...hotwordConfig, rule_enabled: event.target.checked })} />
                    启用正则替换
                  </label>
                  <label>
                    自动替换阈值
                    <input type="number" min="0" max="1" step="0.01" value={hotwordConfig.threshold} onChange={(event) => setHotwordConfig({ ...hotwordConfig, threshold: Number(event.target.value) })} />
                  </label>
                  <label>
                    相似词提示阈值
                    <input type="number" min="0" max="1" step="0.01" value={hotwordConfig.similar_threshold} onChange={(event) => setHotwordConfig({ ...hotwordConfig, similar_threshold: Number(event.target.value) })} />
                  </label>
                  <label className="wide">
                    hot.txt（标准词|别名~~~黑名单）
                    <textarea rows={8} value={hotwordConfig.hotwords} onChange={(event) => setHotwordConfig({ ...hotwordConfig, hotwords: event.target.value })} />
                    <small>示例：撒贝宁|撒贝你|撒贝林~~~撒贝宁工作室</small>
                  </label>
                  <label className="wide">
                    hot-rule.txt（正则 = 替换文本）
                    <textarea rows={6} value={hotwordConfig.rules} onChange={(event) => setHotwordConfig({ ...hotwordConfig, rules: event.target.value })} />
                    <small>示例：50赫兹 = 50Hz</small>
                  </label>
                  <label className="wide">
                    即时预览
                    <div className="inline-field">
                      <input value={hotwordPreview} placeholder="输入一段识别文本" onChange={(event) => setHotwordPreview(event.target.value)} />
                      <button type="button" disabled={hotwordBusy || !hotwordPreview.trim()} onClick={() => void previewHotwords()}>应用</button>
                    </div>
                    {hotwordPreviewResult && <small>结果：{hotwordPreviewResult}</small>}
                  </label>
                </div>
              </section>
            )}
          </div>
        )}
        {activeTab === 'llm' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                厂商
                <select value={settings.llmProvider} onChange={(event) => chooseLLMProvider(event.target.value as LLMProvider)}>
                  {LLM_PROVIDER_PRESETS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
              </label>
              <label>
                接口地址
                <input value={settings.llmBaseUrl} placeholder={llmPreset.baseUrl || 'https://example.com/v1'} onChange={(event) => updateSettings({ llmBaseUrl: event.target.value })} />
              </label>
              <label>
                模型
                <input value={settings.llmModel} placeholder={llmPreset.modelPlaceholder} onChange={(event) => updateSettings({ llmModel: event.target.value })} />
              </label>
              <label>
                API Token
                <input type="password" value={settings.llmApiToken} placeholder={`${llmPreset.tokenPlaceholder}，仅保存在本机`} onChange={(event) => updateSettings({ llmApiToken: event.target.value })} />
              </label>
              <div className="wide">
                {renderProviderProbe('llm', llmModels)}
              </div>
              <label className="wide">
                润色 / 总结风格
                <input value={settings.llmStyle} placeholder="例如：正式、简洁、会议纪要风格" onChange={(event) => updateSettings({ llmStyle: event.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.llmAutoPolish} onChange={(event) => updateSettings({ llmAutoPolish: event.target.checked })} />
                转写完成后自动润色
              </label>
            </div>
          </div>
        )}
        {activeTab === 'translate' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                厂商
                <select value={settings.translationProvider} onChange={(event) => chooseTranslationProvider(event.target.value as LLMProvider)}>
                  {LLM_PROVIDER_PRESETS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
              </label>
              <label>
                接口地址
                <input value={settings.translationBaseUrl} placeholder={translationPreset.baseUrl || settings.llmBaseUrl} onChange={(event) => updateSettings({ translationBaseUrl: event.target.value })} />
              </label>
              <label>
                翻译模型
                <input value={settings.translationModel} placeholder={translationPreset.modelPlaceholder} onChange={(event) => updateSettings({ translationModel: event.target.value })} />
              </label>
              <label>
                API Token
                <input type="password" value={settings.translationApiToken} placeholder={`${translationPreset.tokenPlaceholder}，留空则使用大模型 Token`} onChange={(event) => updateSettings({ translationApiToken: event.target.value })} />
              </label>
              <div className="wide">
                {renderProviderProbe('translate', translationModels)}
              </div>
              <label>
                目标语言
                <input value={settings.llmTargetLanguage} onChange={(event) => updateSettings({ llmTargetLanguage: event.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.llmAutoTranslate} onChange={(event) => updateSettings({ llmAutoTranslate: event.target.checked })} />
                转写完成后自动翻译
              </label>
            </div>
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
