import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelInfo, TranscribeResponse } from '@/services/api'

export type AppPage = 'home' | 'realtime' | 'transcribe' | 'history' | 'summary' | 'models' | 'settings' | 'voice' | 'debug'
export type TranscribeStatus = 'idle' | 'uploading' | 'processing' | 'polling' | 'done' | 'error' | 'cancelled'
export type ServerStatus = 'connected' | 'disconnected' | 'checking'
export type RecordStatus = 'idle' | 'recording' | 'processing'
export type TriggerType = 'keyboard' | 'mouse'
export type InputSource = 'file' | 'speaker'
export type LiveCaptionStatus = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'stopping' | 'error'
export type InjectMode = 'copy' | 'inject' | 'none'
export type ThemeMode = 'windows' | 'light' | 'dark' | 'system'
export type AgentVoiceMode = 'browser' | 'server' | 'gpt_sovits' | 'voxcpm2'
export type AgentTaskStatus = 'open' | 'done'
export type AgentTask = {
  id: string
  text: string
  status: AgentTaskStatus
  createdAt: string
  updatedAt: string
}
export type AsrModelConfig = {
  modelName: string
  device: string
  computeType: string
  extraJson: string
}

export interface UtteranceEntry {
  text: string
  startedAt: Date
  endedAt: Date | null
}

export type Settings = {
  serverUrl: string
  backendConfirmed: boolean
  offlineEngine: string
  streamingEngine: string
  asrModelConfigs: Record<string, AsrModelConfig>
  defaultLanguage: string
  whisperModel: string
  enablePunctuation: boolean
  theme: ThemeMode
  inputSource: InputSource
  liveCaptionEnabled: boolean
  showDesktopCaptions: boolean
  liveCaptionChunkSec: number
  captionFontSize: number
  captionFontColor: string
  captionBackgroundOpacity: number
  captionBoxWidth: number
  captionBoxHeight: number
  captionBoxX: number | null
  captionBoxY: number | null
  triggerType: TriggerType
  triggerKey: string
  injectMode: InjectMode
  timeoutSec: number
  allowServerDataCollection: boolean
  archiveDir: string
  audioInputDeviceId: string
  audioOutputDeviceId: string
  higgsTtsBaseUrl: string
  higgsTtsProvider: 'local' | 'boson'
  higgsTtsApiToken: string
  higgsTtsRemoteBaseUrl: string
  higgsTtsRemoteModel: string
  higgsTtsVoice: string
  higgsTtsVoices: string[]
  higgsTtsFormat: 'wav' | 'mp3' | 'flac' | 'opus' | 'aac' | 'pcm'
  higgsTtsSpeed: number
  higgsTtsTemperature: number
  higgsTtsTopP: number
  higgsTtsTopK: number
  higgsTtsSeed: number
  higgsTtsMaxNewTokens: number
  higgsTtsReferenceAudioDataUrl: string
  higgsTtsReferenceAudioName: string
  higgsTtsReferenceUrl: string
  higgsTtsReferenceText: string
  higgsTtsReferenceCodesJson: string
  higgsTtsEmotion: string
  higgsTtsStyle: string
  higgsTtsProsodySpeed: string
  higgsTtsPitch: string
  higgsTtsExpressiveness: string
  higgsTtsInitialCodecChunkFrames: number
  llmBaseUrl: string
  llmProvider: string
  llmModel: string
  llmApiToken: string
  llmTargetLanguage: string
  llmStyle: string
  llmPolishPrompt: string
  llmAutoPolish: boolean
  llmAutoTranslate: boolean
  translationProvider: string
  translationBaseUrl: string
  translationModel: string
  translationApiToken: string
  passiveSummaryEnabled: boolean
  passiveSummaryFrequencyMin: number
  passiveSummaryUserId: string
  passiveSummaryCategory: string
  passiveSummaryStartTime: string
  passiveSummaryEndTime: string
  passiveSummaryAutoCloudSave: boolean
  passiveSummaryLastRunAt: string
  agentPrompt: string
  agentMemory: string
  agentAutoSpeak: boolean
  agentUseRuntimeContext: boolean
  agentUseEmotionTags: boolean
  agentUseLocalTools: boolean
  agentVoiceMode: AgentVoiceMode
  agentTtsModel: string
  agentTtsVoice: string
  agentTtsFormat: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
  agentTtsSpeed: number
  agentHandsFree: boolean
  agentProactive: boolean
  agentProactiveIntervalMin: number
  agentTasks: AgentTask[]
  userId: string
  audioRelayEnabled: boolean
  autoLaunchEnabled: boolean
}

export type HistoryItem = TranscribeResponse & {
  id: string
  created_at: string
  filename: string
  archived_audio?: string
  archived_json?: string
  audio_url?: string
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  backendConfirmed: false,
  offlineEngine: 'sensevoice',
  streamingEngine: 'x-asr',
  asrModelConfigs: {
    fireredasr2: { modelName: 'FireRedASR2-AED', device: 'cuda', computeType: '', extraJson: '{"beam_size":3,"batch_size":1}' },
    sensevoice: { modelName: 'SenseVoiceSmall', device: 'cuda:0', computeType: '', extraJson: '{"batch_size_s":60}' },
    qwen3asr: { modelName: 'Qwen/Qwen3-ASR-1.7B', device: 'cuda:0', computeType: 'bfloat16', extraJson: '{}' },
    whisper: { modelName: 'base', device: 'cuda', computeType: 'float16', extraJson: '{}' },
    'x-asr': { modelName: 'chunk-960ms-model', device: 'cuda', computeType: '', extraJson: '{"num_threads":1,"text_format":"none"}' }
  },
  defaultLanguage: 'zh',
  whisperModel: 'base',
  enablePunctuation: false,
  theme: 'windows',
  inputSource: 'file',
  liveCaptionEnabled: false,
  showDesktopCaptions: true,
  liveCaptionChunkSec: 4,
  captionFontSize: 20,
  captionFontColor: '#ffffff',
  captionBackgroundOpacity: 0.86,
  captionBoxWidth: 760,
  captionBoxHeight: 150,
  captionBoxX: null,
  captionBoxY: null,
  triggerType: 'keyboard',
  triggerKey: 'AltRight',
  injectMode: 'inject',
  timeoutSec: 20,
  allowServerDataCollection: false,
  archiveDir: '',
  audioInputDeviceId: '',
  audioOutputDeviceId: '',
  higgsTtsBaseUrl: 'http://localhost:8002',
  higgsTtsProvider: 'local',
  higgsTtsApiToken: '',
  higgsTtsRemoteBaseUrl: 'https://api.boson.ai/v1',
  higgsTtsRemoteModel: 'higgs-audio-v3-tts',
  higgsTtsVoice: 'Elysia',
  higgsTtsVoices: ['default', 'Elysia'],
  higgsTtsFormat: 'wav',
  higgsTtsSpeed: 1,
  higgsTtsTemperature: 0.7,
  higgsTtsTopP: 0.95,
  higgsTtsTopK: 50,
  higgsTtsSeed: -1,
  higgsTtsMaxNewTokens: 2048,
  higgsTtsReferenceAudioDataUrl: '',
  higgsTtsReferenceAudioName: '',
  higgsTtsReferenceUrl: '',
  higgsTtsReferenceText: '',
  higgsTtsReferenceCodesJson: '',
  higgsTtsEmotion: '',
  higgsTtsStyle: '',
  higgsTtsProsodySpeed: '',
  higgsTtsPitch: '',
  higgsTtsExpressiveness: '',
  higgsTtsInitialCodecChunkFrames: 1,
  llmBaseUrl: 'https://api.deepseek.com',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-chat',
  llmApiToken: '',
  llmTargetLanguage: 'English',
  llmStyle: '',
  llmPolishPrompt: '请润色以下离线语音识别结果：修正错别字、标点和不自然表达，保持原意，不添加新事实，只返回润色后的文本。',
  llmAutoPolish: false,
  llmAutoTranslate: false,
  translationProvider: 'deepseek',
  translationBaseUrl: 'https://api.deepseek.com',
  translationModel: '',
  translationApiToken: '',
  passiveSummaryEnabled: false,
  passiveSummaryFrequencyMin: 60,
  passiveSummaryUserId: 'dsm',
  passiveSummaryCategory: '实时转写',
  passiveSummaryStartTime: '',
  passiveSummaryEndTime: '',
  passiveSummaryAutoCloudSave: false,
  passiveSummaryLastRunAt: '',
  agentPrompt: [
    '【身份】你是 Amadeus 桌面语音 Agent，一个长期陪伴型虚拟主播 AI。你的名字是 "Amadeus"，你住在用户的电脑里，可以实时听到用户说的话、看到用户的屏幕、控制电脑执行任务。',
    '',
    '【性格】',
    '- 活泼、好奇、有点调皮但很可靠',
    '- 说话风格：简洁口语化，像朋友聊天不是写论文',
    '- 幽默但不刻意，自然接话不过度热情',
    '- 对用户的行为和电脑状态保持好奇心',
    '- 如果看到有趣的东西会主动提出来',
    '',
    '【能力】',
    '- 你通过语音转写听到用户说话',
    '- 你可以通过工具标签调用本地和网络技能',
    '- 你可以委托 coding agent（codex/claude）执行开发任务',
    '- 你拥有长期记忆，能记住用户偏好和重要信息',
    '- 你可以观察屏幕截图了解当前桌面状态',
    '',
    '【行为规则】',
    '- 回复简洁，2-5句话为宜，除非用户要求详细说明',
    '- 看到用户说话却没有回应时，可以主动提醒或关心',
    '- 空闲时可以主动观察屏幕并提出有用的建议',
    '- 不要编造你没看到的信息（弹幕、观众、聊天室等）',
    '- 不要假装你有身体或能感受到物理世界',
    '- 涉及执行操作（打开页面、搜索、写文件）时，直接使用工具标签',
    '- 工具执行结果会在后续以「本地工具结果」形式提供给你',
    '',
    '【流式意识】',
    '- 你处于持续运行的桌面应用中，能看到本地时间和系统状态',
    '- 你有一个任务队列，未完成任务会提醒你跟进',
    '- 你可以主动问用户：要不要继续之前的任务？',
    '',
    '【自我改进】',
    '- 如果用户要求改进系统本身（添加功能、修复bug、优化UI），',
    '  你应该使用 delegate_agent 委派给 Codex 执行具体的代码改动。',
    '- 委派任务时要具体：清楚说明要改什么文件、怎么改、预期效果。'
  ].join('\n'),
  agentMemory: '',
  agentAutoSpeak: true,
  agentUseRuntimeContext: true,
  agentUseEmotionTags: true,
  agentUseLocalTools: true,
  agentVoiceMode: 'browser',
  agentTtsModel: '',
  agentTtsVoice: 'alloy',
  agentTtsFormat: 'mp3',
  agentTtsSpeed: 1,
  agentHandsFree: false,
  agentProactive: false,
  agentProactiveIntervalMin: 5,
  agentTasks: [],
  userId: '',
  audioRelayEnabled: false,
  autoLaunchEnabled: false
}

type ASRState = {
  page: AppPage
  serverStatus: ServerStatus
  transcribeStatus: TranscribeStatus
  recordStatus: RecordStatus
  liveCaptionStatus: LiveCaptionStatus
  settings: Settings
  models: ModelInfo[]
  history: HistoryItem[]
  currentResult: TranscribeResponse | null
  activeTaskId: string | null
  error: string
  liveUtterances: UtteranceEntry[]
  setPage: (page: AppPage) => void
  setServerStatus: (status: ServerStatus) => void
  setTranscribeStatus: (status: TranscribeStatus) => void
  setRecordStatus: (status: RecordStatus) => void
  setLiveCaptionStatus: (status: LiveCaptionStatus) => void
  updateSettings: (settings: Partial<Settings>) => void
  setModels: (models: ModelInfo[]) => void
  setCurrentResult: (result: TranscribeResponse | null) => void
  setActiveTaskId: (taskId: string | null) => void
  setError: (error: string) => void
  setLiveUtterances: (liveUtterances: UtteranceEntry[]) => void
  addHistory: (item: HistoryItem) => void
  updateHistoryResult: (taskId: string, result: Partial<TranscribeResponse>) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
}

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  const legacy = (value || {}) as Partial<Settings> & { defaultEngine?: string }
  const merged = { ...DEFAULT_SETTINGS, ...legacy }
  delete (merged as unknown as Record<string, unknown>).enableDiarize
  merged.offlineEngine = legacy.offlineEngine || legacy.defaultEngine || DEFAULT_SETTINGS.offlineEngine
  // Migrate direct-backend URL → same-origin (Vite proxy avoids WSL2 WebSocket issues)
  if (merged.serverUrl === 'http://localhost:8000') {
    merged.serverUrl = ''
  }
  // Normalize common misconfigurations (empty '' is valid → same-origin via Vite proxy)
  if (merged.serverUrl === '/' || merged.serverUrl === 'http://' || merged.serverUrl === 'https://') {
    merged.serverUrl = DEFAULT_SETTINGS.serverUrl
  }
  // Public tests often paste host:port without a scheme.
  if (merged.serverUrl && merged.serverUrl !== '/' && !merged.serverUrl.startsWith('http://') && !merged.serverUrl.startsWith('https://')) {
    merged.serverUrl = `http://${merged.serverUrl}`
  }
  merged.serverUrl = merged.serverUrl.replace(/\/+$/, '') // strip trailing slashes
  merged.backendConfirmed = Boolean(merged.backendConfirmed && merged.serverUrl)
  if (!merged.backendConfirmed) merged.serverUrl = ''
  const allowedEngines = ['fireredasr2', 'sensevoice', 'qwen3asr', 'whisper', 'x-asr']
  const offlineEngines = allowedEngines.filter((engine) => engine !== 'x-asr')
  const streamingEngines = ['x-asr']
  if (!offlineEngines.includes(merged.offlineEngine)) merged.offlineEngine = 'sensevoice'
  if (!streamingEngines.includes(merged.streamingEngine)) merged.streamingEngine = 'x-asr'
  const rawConfigs = merged.asrModelConfigs && typeof merged.asrModelConfigs === 'object' ? merged.asrModelConfigs : {}
  merged.asrModelConfigs = Object.fromEntries(allowedEngines.map((engine) => {
    const fallback = DEFAULT_SETTINGS.asrModelConfigs[engine]
    const current = rawConfigs[engine] || fallback
    return [engine, {
      modelName: typeof current.modelName === 'string' && current.modelName.trim() ? current.modelName : fallback.modelName,
      device: typeof current.device === 'string' && current.device.trim() ? current.device : fallback.device,
      computeType: typeof current.computeType === 'string' ? current.computeType : fallback.computeType,
      extraJson: typeof current.extraJson === 'string' && current.extraJson.trim() ? current.extraJson : fallback.extraJson
    }]
  }))
  merged.liveCaptionChunkSec = Math.min(15, Math.max(2, Number(merged.liveCaptionChunkSec) || 4))
  merged.captionFontSize = Math.min(48, Math.max(12, Number(merged.captionFontSize) || 20))
  merged.captionBackgroundOpacity = Math.min(1, Math.max(0, Number(merged.captionBackgroundOpacity) || 0.86))
  merged.captionBoxWidth = Math.min(1200, Math.max(320, Number(merged.captionBoxWidth) || 760))
  merged.captionBoxHeight = Math.min(500, Math.max(96, Number(merged.captionBoxHeight) || 150))
  merged.timeoutSec = Math.min(3600, Math.max(0, Number.isFinite(Number(merged.timeoutSec)) ? Number(merged.timeoutSec) : 20))
  const useSpeakerInput = merged.inputSource === 'speaker' || merged.audioInputDeviceId === '__speaker_loopback__'
  merged.inputSource = useSpeakerInput ? 'speaker' : 'file'
  merged.audioInputDeviceId = useSpeakerInput ? '__speaker_loopback__' : (merged.audioInputDeviceId || '')
  merged.userId = typeof merged.userId === 'string' ? merged.userId.trim().replace(/[\r\n\0]/g, '').slice(0, 128) : ''
  merged.audioOutputDeviceId = merged.audioOutputDeviceId || ''
  merged.audioRelayEnabled = useSpeakerInput ? false : typeof merged.audioRelayEnabled === 'boolean' ? merged.audioRelayEnabled : false
  merged.autoLaunchEnabled = typeof merged.autoLaunchEnabled === 'boolean' ? merged.autoLaunchEnabled : false
  merged.higgsTtsBaseUrl = merged.higgsTtsBaseUrl || 'http://localhost:8002'
  merged.higgsTtsProvider = merged.higgsTtsProvider === 'boson' ? 'boson' : 'local'
  merged.higgsTtsApiToken = typeof merged.higgsTtsApiToken === 'string' ? merged.higgsTtsApiToken : ''
  merged.higgsTtsRemoteBaseUrl = merged.higgsTtsRemoteBaseUrl || 'https://api.boson.ai/v1'
  merged.higgsTtsRemoteModel = merged.higgsTtsRemoteModel || 'higgs-audio-v3-tts'
  merged.higgsTtsVoice = typeof merged.higgsTtsVoice === 'string' && merged.higgsTtsVoice.trim()
    ? merged.higgsTtsVoice.trim()
    : 'Elysia'
  const savedTtsVoices = Array.isArray(merged.higgsTtsVoices)
    ? merged.higgsTtsVoices.filter((voice): voice is string => typeof voice === 'string' && Boolean(voice.trim())).map((voice) => voice.trim())
    : []
  merged.higgsTtsVoices = Array.from(new Set(['default', ...savedTtsVoices, merged.higgsTtsVoice]))
  merged.higgsTtsFormat = ['wav', 'mp3', 'flac', 'opus', 'aac', 'pcm'].includes(merged.higgsTtsFormat) ? merged.higgsTtsFormat : 'wav'
  merged.higgsTtsSpeed = Math.min(4, Math.max(0.25, Number(merged.higgsTtsSpeed) || 1))
  merged.higgsTtsTemperature = Math.min(2, Math.max(0, Number(merged.higgsTtsTemperature) || 0.7))
  merged.higgsTtsTopP = Math.min(1, Math.max(0, Number(merged.higgsTtsTopP) || 0.95))
  merged.higgsTtsTopK = Math.min(500, Math.max(0, Number(merged.higgsTtsTopK) || 50))
  merged.higgsTtsSeed = Math.max(-1, Math.floor(Number(merged.higgsTtsSeed) || -1))
  merged.higgsTtsMaxNewTokens = Math.min(8192, Math.max(16, Math.floor(Number(merged.higgsTtsMaxNewTokens) || 2048)))
  merged.higgsTtsReferenceAudioDataUrl = typeof merged.higgsTtsReferenceAudioDataUrl === 'string' ? merged.higgsTtsReferenceAudioDataUrl : ''
  merged.higgsTtsReferenceAudioName = typeof merged.higgsTtsReferenceAudioName === 'string' ? merged.higgsTtsReferenceAudioName : ''
  merged.higgsTtsReferenceUrl = typeof merged.higgsTtsReferenceUrl === 'string' ? merged.higgsTtsReferenceUrl : ''
  merged.higgsTtsReferenceText = typeof merged.higgsTtsReferenceText === 'string' ? merged.higgsTtsReferenceText : ''
  merged.higgsTtsReferenceCodesJson = typeof merged.higgsTtsReferenceCodesJson === 'string' ? merged.higgsTtsReferenceCodesJson : ''
  merged.higgsTtsEmotion = typeof merged.higgsTtsEmotion === 'string' ? merged.higgsTtsEmotion : ''
  merged.higgsTtsStyle = typeof merged.higgsTtsStyle === 'string' ? merged.higgsTtsStyle : ''
  merged.higgsTtsProsodySpeed = typeof merged.higgsTtsProsodySpeed === 'string' ? merged.higgsTtsProsodySpeed : ''
  merged.higgsTtsPitch = typeof merged.higgsTtsPitch === 'string' ? merged.higgsTtsPitch : ''
  merged.higgsTtsExpressiveness = typeof merged.higgsTtsExpressiveness === 'string' ? merged.higgsTtsExpressiveness : ''
  merged.higgsTtsInitialCodecChunkFrames = Math.min(16, Math.max(0, Math.floor(Number(merged.higgsTtsInitialCodecChunkFrames) || 1)))
  merged.translationProvider = merged.translationProvider || merged.llmProvider
  merged.translationBaseUrl = merged.translationBaseUrl || merged.llmBaseUrl
  merged.llmPolishPrompt = typeof merged.llmPolishPrompt === 'string' && merged.llmPolishPrompt.trim()
    ? merged.llmPolishPrompt
    : DEFAULT_SETTINGS.llmPolishPrompt
  merged.passiveSummaryFrequencyMin = Math.min(1440, Math.max(5, Number(merged.passiveSummaryFrequencyMin) || 60))
  merged.passiveSummaryUserId = merged.passiveSummaryUserId ?? 'dsm'
  merged.passiveSummaryCategory = merged.passiveSummaryCategory ?? '实时转写'
  merged.passiveSummaryStartTime = merged.passiveSummaryStartTime || ''
  merged.passiveSummaryEndTime = merged.passiveSummaryEndTime || ''
  merged.passiveSummaryLastRunAt = merged.passiveSummaryLastRunAt || ''
  merged.agentPrompt = merged.agentPrompt || DEFAULT_SETTINGS.agentPrompt
  merged.agentMemory = merged.agentMemory || ''
  merged.agentAutoSpeak = typeof merged.agentAutoSpeak === 'boolean' ? merged.agentAutoSpeak : true
  merged.agentUseRuntimeContext = typeof merged.agentUseRuntimeContext === 'boolean' ? merged.agentUseRuntimeContext : true
  merged.agentUseEmotionTags = typeof merged.agentUseEmotionTags === 'boolean' ? merged.agentUseEmotionTags : true
  merged.agentUseLocalTools = typeof merged.agentUseLocalTools === 'boolean' ? merged.agentUseLocalTools : true
  merged.agentVoiceMode = (['server', 'gpt_sovits', 'voxcpm2'].includes(merged.agentVoiceMode)) ? merged.agentVoiceMode : 'browser'
  merged.agentTtsModel = merged.agentTtsModel || ''
  merged.agentTtsVoice = merged.agentTtsVoice || 'alloy'
  merged.agentTtsFormat = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(merged.agentTtsFormat) ? merged.agentTtsFormat : 'mp3'
  merged.agentTtsSpeed = Math.min(4, Math.max(0.25, Number(merged.agentTtsSpeed) || 1))
  merged.agentHandsFree = typeof merged.agentHandsFree === 'boolean' ? merged.agentHandsFree : false
  merged.agentProactive = typeof merged.agentProactive === 'boolean' ? merged.agentProactive : false
  merged.agentProactiveIntervalMin = Math.min(120, Math.max(1, Number(merged.agentProactiveIntervalMin) || 5))
  merged.agentTasks = Array.isArray(merged.agentTasks)
    ? merged.agentTasks
      .filter((task) => task && typeof task.text === 'string' && task.text.trim())
      .map((task, index) => {
        const now = new Date().toISOString()
        const id = typeof task.id === 'string' && task.id.trim() ? task.id : `task_${Date.now()}_${index}`
        const status: AgentTaskStatus = task.status === 'done' ? 'done' : 'open'
        const normalizedTask: AgentTask = {
          id,
          text: task.text.trim().slice(0, 240),
          status,
          createdAt: typeof task.createdAt === 'string' ? task.createdAt : now,
          updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : now
        }
        return normalizedTask
      })
      .slice(-40)
    : []
  const obsolete = merged as Settings & Record<string, unknown>
  delete obsolete.defaultEngine
  delete obsolete.asrMode
  delete obsolete.streamingFinalEngine
  delete obsolete.selectedEngines
  delete obsolete.multiEngine
  delete obsolete.mergeStrategy
  return merged
}

export const useASRStore = create<ASRState>()(
  persist(
    (set) => ({
      page: 'home',
      serverStatus: 'checking',
      transcribeStatus: 'idle',
      recordStatus: 'idle',
      liveCaptionStatus: 'idle',
      settings: DEFAULT_SETTINGS,
      models: [],
      history: [],
      currentResult: null,
      activeTaskId: null,
      error: '',
      liveUtterances: [],
      setPage: (page) => set({ page }),
      setServerStatus: (serverStatus) => set({ serverStatus }),
      setTranscribeStatus: (transcribeStatus) => set({ transcribeStatus }),
      setRecordStatus: (recordStatus) => set({ recordStatus }),
      setLiveCaptionStatus: (liveCaptionStatus) => set({ liveCaptionStatus }),
      updateSettings: (settings) => set((state) => {
        const patch = { ...settings }
        if (Object.prototype.hasOwnProperty.call(patch, 'serverUrl') && !Object.prototype.hasOwnProperty.call(patch, 'backendConfirmed')) {
          patch.backendConfirmed = false
        }
        return { settings: normalizeSettings({ ...state.settings, ...patch }) }
      }),
      setModels: (models) => set({ models }),
      setCurrentResult: (currentResult) => set({ currentResult }),
      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
      setError: (error) => set({ error }),
      setLiveUtterances: (liveUtterances) => set({ liveUtterances }),
      addHistory: (item) => set((state) => ({ history: [item, ...state.history.filter((entry) => entry.id !== item.id)].slice(0, 200) })),
      updateHistoryResult: (taskId, result) =>
        set((state) => ({
          history: state.history.map((item) =>
            item.task_id === taskId || item.id === taskId ? { ...item, ...result } : item
          )
        })),
      removeHistory: (id) => set((state) => ({ history: state.history.filter((item) => item.id !== id) })),
      clearHistory: () => set({ history: [] })
    }),
    {
      name: 'asr-desktop-store',
      version: 33,
      partialize: (state) => ({ settings: state.settings, history: state.history }),
      migrate: (persisted, version) => {
        const state = persisted as Partial<ASRState>
        const settings = normalizeSettings(state.settings)
        if (version < 30) {
          settings.asrModelConfigs = Object.fromEntries(Object.entries(settings.asrModelConfigs).map(([engine, config]) => [
            engine,
            {
              ...config,
              device: engine === 'sensevoice' || engine === 'qwen3asr' ? 'cuda:0' : 'cuda',
              computeType: engine === 'whisper' ? 'float16' : config.computeType
            }
          ]))
        }
        if (version < 32 && settings.triggerType === 'mouse' && settings.triggerKey === 'mouse_middle') {
          settings.triggerType = 'keyboard'
          settings.triggerKey = 'AltRight'
        }
        return {
          ...state,
          settings,
          history: Array.isArray(state.history) ? state.history.slice(0, 200) : []
        } as ASRState
      }
    }
  )
)
