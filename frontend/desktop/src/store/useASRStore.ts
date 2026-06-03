import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelInfo, TranscribeResponse } from '@/services/api'

export type AppPage = 'home' | 'realtime' | 'transcribe' | 'history' | 'summary' | 'events' | 'models' | 'settings'
export type TranscribeStatus = 'idle' | 'uploading' | 'processing' | 'polling' | 'done' | 'error' | 'cancelled'
export type ServerStatus = 'connected' | 'disconnected' | 'checking'
export type RecordStatus = 'idle' | 'recording' | 'processing'
export type TriggerType = 'keyboard' | 'mouse'
export type InputSource = 'file' | 'speaker'
export type LiveCaptionStatus = 'idle' | 'listening' | 'transcribing' | 'error'
export type MergeStrategy = 'first' | 'vote' | 'concat'
export type InjectMode = 'copy' | 'inject' | 'none'
export type ThemeMode = 'windows' | 'light' | 'dark' | 'system'

export type Settings = {
  serverUrl: string
  defaultEngine: string
  selectedEngines: string[]
  defaultLanguage: string
  whisperModel: string
  enablePunctuation: boolean
  enableDiarize: boolean
  multiEngine: boolean
  mergeStrategy: MergeStrategy
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
  llmBaseUrl: string
  llmProvider: string
  llmModel: string
  llmApiToken: string
  llmTargetLanguage: string
  llmStyle: string
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
  serverUrl: 'http://112.124.13.120:18000',
  defaultEngine: 'fireredasr2',
  selectedEngines: ['fireredasr2'],
  defaultLanguage: 'zh',
  whisperModel: 'base',
  enablePunctuation: false,
  enableDiarize: false,
  multiEngine: false,
  mergeStrategy: 'first',
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
  triggerType: 'mouse',
  triggerKey: 'mouse_middle',
  injectMode: 'inject',
  timeoutSec: 60,
  allowServerDataCollection: false,
  archiveDir: '',
  audioInputDeviceId: '',
  llmBaseUrl: 'https://api.deepseek.com',
  llmProvider: 'deepseek',
  llmModel: '',
  llmApiToken: '',
  llmTargetLanguage: 'English',
  llmStyle: '',
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
  passiveSummaryLastRunAt: ''
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
  addHistory: (item: HistoryItem) => void
  updateHistoryResult: (taskId: string, result: Partial<TranscribeResponse>) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
}

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(value || {}) }
  if (merged.serverUrl === 'http://10.154.39.91:8001') {
    merged.serverUrl = DEFAULT_SETTINGS.serverUrl
  }
  merged.liveCaptionChunkSec = Math.min(15, Math.max(2, Number(merged.liveCaptionChunkSec) || 4))
  merged.captionFontSize = Math.min(48, Math.max(12, Number(merged.captionFontSize) || 20))
  merged.captionBackgroundOpacity = Math.min(1, Math.max(0, Number(merged.captionBackgroundOpacity) || 0.86))
  merged.captionBoxWidth = Math.min(1200, Math.max(320, Number(merged.captionBoxWidth) || 760))
  merged.captionBoxHeight = Math.min(500, Math.max(96, Number(merged.captionBoxHeight) || 150))
  merged.selectedEngines = merged.selectedEngines.length ? merged.selectedEngines : [merged.defaultEngine]
  merged.translationProvider = merged.translationProvider || merged.llmProvider
  merged.translationBaseUrl = merged.translationBaseUrl || merged.llmBaseUrl
  merged.passiveSummaryFrequencyMin = Math.min(1440, Math.max(5, Number(merged.passiveSummaryFrequencyMin) || 60))
  merged.passiveSummaryUserId = merged.passiveSummaryUserId ?? 'dsm'
  merged.passiveSummaryCategory = merged.passiveSummaryCategory ?? '实时转写'
  merged.passiveSummaryStartTime = merged.passiveSummaryStartTime || ''
  merged.passiveSummaryEndTime = merged.passiveSummaryEndTime || ''
  merged.passiveSummaryLastRunAt = merged.passiveSummaryLastRunAt || ''
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
      setPage: (page) => set({ page }),
      setServerStatus: (serverStatus) => set({ serverStatus }),
      setTranscribeStatus: (transcribeStatus) => set({ transcribeStatus }),
      setRecordStatus: (recordStatus) => set({ recordStatus }),
      setLiveCaptionStatus: (liveCaptionStatus) => set({ liveCaptionStatus }),
      updateSettings: (settings) => set((state) => ({ settings: normalizeSettings({ ...state.settings, ...settings }) })),
      setModels: (models) => set({ models }),
      setCurrentResult: (currentResult) => set({ currentResult }),
      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
      setError: (error) => set({ error }),
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
      version: 16,
      partialize: (state) => ({ settings: state.settings, history: state.history }),
      migrate: (persisted) => {
        const state = persisted as Partial<ASRState>
        return {
          ...state,
          settings: normalizeSettings(state.settings),
          history: Array.isArray(state.history) ? state.history.slice(0, 200) : []
        } as ASRState
      }
    }
  )
)
