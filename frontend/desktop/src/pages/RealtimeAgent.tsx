import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Aemeath3D } from '@/components/Aemeath3D'
import { MeetingAssistPanel } from '@/components/MeetingAssistPanel'
import { RealtimeVoiceConfig, type RealtimeVoiceCatalog } from '@/components/RealtimeVoiceConfig'
import { ASRApi, isAsyncResponse, type LLMChatContent, type LLMChatRole, type SkillDefinition, type TranscribeOptions } from '@/services/api'
import { StreamingASRClient, audioRelayMixer, captureSpeakerAudio, speechRecorder } from '@/services/audio'
import { useASRStore, type AgentTask, type AgentVoiceMode, type AppPage } from '@/store/useASRStore'
import { codexRequest, streamCodexTurn, type CodexCatalog, type CodexAccounting, type CodexReply, type CodexVoiceEvent } from '@/services/codex'
import { fillPromptFromAsr } from '@/services/agentPrompt'
import { LiveVoiceSession, type LiveVoiceCallbacks, type LiveVoiceState } from '@/services/liveVoice'
import type { LiveAvatarAudioFrame } from '@/services/liveVoiceTypes'
import { observeAudioElement, silentAvatarAudioFrame } from '@/services/avatarAudio'
import { RealtimePlayback } from '@/services/realtimePlayback'

type AgentStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'responding' | 'speaking' | 'error'
type AgentEmotion = 'neutral' | 'happy' | 'curious' | 'focused' | 'surprised' | 'concerned'
type AgentAction = 'idle' | 'listening' | 'thinking' | 'speaking' | 'observing'
type AgentLocalTool = 'open_page' | 'remember' | 'add_task' | 'complete_task' | 'speak'
type AgentToolCall = {
  id: string
  name: string  // dynamic: local tools + backend skills
  args: Record<string, string>
}
type AgentToolLog = {
  id: string
  label: string
  createdAt: string
}
type AgentMessage = {
  id: string
  role: LLMChatRole
  content: string
  createdAt: string
  kind?: 'chat' | 'tool'
  codex?: CodexReply
}

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])
const SENTENCE_BOUNDARY = /[。！？!?；;\n]/g
const AGENT_STATE_PATTERN = /\[\[agent_state\s+([^\]]+)\]\]\s*/gi
const AGENT_STATE_PARTIAL_PATTERN = /^\s*\[\[agent_state[^\]]*$/i
const AGENT_TOOL_PATTERN = /\[\[agent_tool\s+([^\]]+)\]\]\s*/gi
const AGENT_TOOL_PARTIAL_PATTERN = /^\s*\[\[agent_tool[^\]]*$/i
const agentEmotions: AgentEmotion[] = ['neutral', 'happy', 'curious', 'focused', 'surprised', 'concerned']
const agentActions: AgentAction[] = ['idle', 'listening', 'thinking', 'speaking', 'observing']
const agentLocalTools: AgentLocalTool[] = ['open_page', 'remember', 'add_task', 'complete_task', 'speak']

function inferPetGesture(text: string) {
  if (/(挥手|招手|打招呼|wave\b)/i.test(text)) return 'wave'
  if (/(跳舞|跳一段|dance\b)/i.test(text)) return 'dance'
  if (/(向左走|往左走|左移一步)/.test(text)) return 'step_left'
  if (/(向右走|往右走|右移一步)/.test(text)) return 'step_right'
  if (/(走近|靠近我|come closer)/i.test(text)) return 'come_closer'
  if (/(后退|退后|step back)/i.test(text)) return 'step_back'
  if (/(向左转|左转身)/.test(text)) return 'turn_left'
  if (/(向右转|右转身)/.test(text)) return 'turn_right'
  return 'none'
}

function inferAssistantPetGesture(text: string) {
  const firstSentence = text.trim().slice(0, 90)
  if (/^(好[的呀啊]?|当然|没问题)?[，,!！。\s]*(我(现在|来|给你|这就)?|让爱弥斯)(挥手|招手)/.test(firstSentence)) return 'wave'
  if (/^(好[的呀啊]?|当然|没问题)?[，,!！。\s]*(我(现在|来|给你|这就)?|让爱弥斯)(跳舞|跳一段)/.test(firstSentence)) return 'dance'
  return 'none'
}
const toolPages: AppPage[] = ['home', 'realtime', 'transcribe', 'history', 'summary', 'models', 'settings', 'voice']

function createTask(text: string): AgentTask {
  const now = new Date().toISOString()
  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim().slice(0, 240),
    status: 'open',
    createdAt: now,
    updatedAt: now
  }
}

function createMessage(role: 'user' | 'assistant', content: string): AgentMessage {
  return {
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    kind: 'chat'
  }
}

function createToolMessage(content: string): AgentMessage {
  return {
    id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    kind: 'tool'
  }
}

function statusLabel(status: AgentStatus) {
  const labels: Record<AgentStatus, string> = {
    idle: '待机',
    listening: '聆听中',
    transcribing: '转写中',
    thinking: '思考中',
    responding: '生成中',
    speaking: '朗读中',
    error: '异常'
  }
  return labels[status]
}

function chatContentText(content: LLMChatContent) {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.type === 'text' ? part.text : '')
    .join('\n')
}

function parseKeyValuePayload(payload: string) {
  const values: Record<string, string> = {}
  const pairs = payload.matchAll(/([a-zA-Z_]+)=("[^"]*"|'[^']*'|[^\s]+)/g)
  for (const pair of pairs) values[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '')
  return values
}

function parseAgentState(text: string) {
  let emotion: AgentEmotion | undefined
  let action: AgentAction | undefined
  const cleaned = text
    .replace(AGENT_STATE_PATTERN, (_match, payload: string) => {
      const values = parseKeyValuePayload(payload)
      const nextEmotion = values.emotion?.toLowerCase()
      const nextAction = values.action?.toLowerCase()
      if (agentEmotions.includes(nextEmotion as AgentEmotion)) emotion = nextEmotion as AgentEmotion
      if (agentActions.includes(nextAction as AgentAction)) action = nextAction as AgentAction
      return ''
    })
    .replace(AGENT_STATE_PARTIAL_PATTERN, '')
    .trimStart()

  return { text: cleaned, emotion, action }
}

function parseAgentTools(text: string, validSkills: Set<string>) {
  const tools: AgentToolCall[] = []
  const cleaned = text
    .replace(AGENT_TOOL_PATTERN, (match, payload: string) => {
      const values = parseKeyValuePayload(payload)
      const name = values.name?.toLowerCase()
      if (name && validSkills.has(name)) {
        tools.push({
          id: match.trim(),
          name,
          args: values
        })
      }
      return ''
    })
    .replace(AGENT_TOOL_PARTIAL_PATTERN, '')
    .trimStart()

  return { text: cleaned, tools }
}

function statusAction(status: AgentStatus): AgentAction | null {
  if (status === 'listening' || status === 'transcribing') return 'listening'
  if (status === 'thinking' || status === 'responding') return 'thinking'
  if (status === 'speaking') return 'speaking'
  return null
}

function emotionLabel(emotion: AgentEmotion) {
  const labels: Record<AgentEmotion, string> = {
    neutral: '平稳',
    happy: '开心',
    curious: '好奇',
    focused: '专注',
    surprised: '惊讶',
    concerned: '担心'
  }
  return labels[emotion]
}

async function captureScreenFrame() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前环境不支持屏幕捕获')
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  })
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    await new Promise((resolve) => window.setTimeout(resolve, 120))
    const sourceWidth = video.videoWidth || 1280
    const sourceHeight = video.videoHeight || 720
    const scale = Math.min(1, 1280 / sourceWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法读取屏幕画面')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  } finally {
    stream.getTracks().forEach((track) => track.stop())
  }
}

export function RealtimeAgentPage() {
  const settings = useASRStore((state) => state.settings)
  const petCommand = useASRStore((state) => state.petCommand)
  const setPetCommand = useASRStore((state) => state.setPetCommand)
  const models = useASRStore((state) => state.models)
  const serverStatus = useASRStore((state) => state.serverStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const history = useASRStore((state) => state.history)
  const currentResult = useASRStore((state) => state.currentResult)
  const setPage = useASRStore((state) => state.setPage)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const recorderRef = useRef(speechRecorder)
  const handsFreeStreamerRef = useRef<StreamingASRClient | null>(null)
  const liveVoiceRef = useRef<LiveVoiceSession | null>(null)
  const liveGenerationRef = useRef(0)
  const liveMessageRef = useRef<{ user: { id: string; at: number }; assistant: { id: string; at: number } }>({ user: { id: '', at: 0 }, assistant: { id: '', at: 0 } })
  const speechQueueRef = useRef<string[]>([])
  const speechBufferRef = useRef('')
  const speakingRef = useRef(false)
  const speechGenerationRef = useRef(0)
  const responseActiveRef = useRef(false)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const avatarAudioFrameRef = useRef<LiveAvatarAudioFrame | null>(null)
  const avatarGenerationRef = useRef(0)
  const avatarEpochRef = useRef(Date.now())
  const avatarObserverRef = useRef<(() => void) | null>(null)
  const previewPlaybackRef = useRef<RealtimePlayback | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [avatarView, setAvatarView] = useState<'portrait' | 'full'>('portrait')
  const currentAudioUrlRef = useRef('')
  const relaySpeechTimerRef = useRef<number | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const turnIdRef = useRef(0)
  const statusRef = useRef<AgentStatus>('idle')
  const settingsRef = useRef(settings)
  const proactiveLastAtRef = useRef(0)
  const sendToAgentRef = useRef<(text: string) => Promise<void>>(async () => undefined)
  const executedToolsRef = useRef<Set<string>>(new Set())
  const codexSessionRef = useRef(crypto.randomUUID())
  const mountedRef = useRef(true)
  const [codexCatalog, setCodexCatalog] = useState<CodexCatalog | null>(null)
  const [meetingMode, setMeetingMode] = useState(() => window.location.hash === '#meeting')
  const [meetingBusy, setMeetingBusy] = useState(false)
  useEffect(() => {
    if (meetingMode) updateSettings({ agentBackend: 'codex', agentAutoSpeak: false })
  }, [meetingMode, updateSettings])
  const [codexCatalogError, setCodexCatalogError] = useState('')
  const [codexConnectionRevision, setCodexConnectionRevision] = useState(0)
  const [codexUsage, setCodexUsage] = useState<CodexAccounting | null>(null)
  const [codexTotal, setCodexTotal] = useState<CodexAccounting | null>(null)
  const [codexPending, setCodexPending] = useState(false)
  const [voiceDraining, setVoiceDraining] = useState(false)
  const [liveVoiceState, setLiveVoiceState] = useState<LiveVoiceState>('closed')
  const [liveCatalog, setLiveCatalog] = useState<RealtimeVoiceCatalog | null>(null)
  const [liveCapture, setLiveCapture] = useState<{ level: number; seconds: number; serverSeconds?: number } | null>(null)
  const [partialTranscript, setPartialTranscript] = useState('')
  const [aecStatus, setAecStatus] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [messages, setMessages] = useState<AgentMessage[]>([
    createMessage('assistant', '我在。点击语音或直接输入，我们可以开始对话。')
  ])
  const messagesRef = useRef<AgentMessage[]>(messages)
  const petReplyIdRef = useRef('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [lastTranscript, setLastTranscript] = useState('')
  const [memoryStatus, setMemoryStatus] = useState<'idle' | 'extracting' | 'done'>('idle')
  const [handsFreeStatus, setHandsFreeStatus] = useState<'idle' | 'connecting' | 'loading' | 'listening' | 'transcribing' | 'error'>('idle')
  const [proactiveStatus, setProactiveStatus] = useState<'idle' | 'waiting' | 'triggered'>('idle')
  const [agentEmotion, setAgentEmotion] = useState<AgentEmotion>('neutral')
  const [agentDirectedAction, setAgentDirectedAction] = useState<AgentAction>('idle')
  const [toolLog, setToolLog] = useState<AgentToolLog[]>([])
  const [backendSkills, setBackendSkills] = useState<SkillDefinition[]>([])
  const validSkillNames = useMemo(() => {
    const names: Set<string> = new Set(agentLocalTools)
    backendSkills.forEach((skill) => names.add(skill.name))
    names.add('delegate_agent')
    return names
  }, [backendSkills])

  const usingCodex = settings.agentBackend === 'codex'
  const legacyReady = Boolean(settings.llmModel.trim() && settings.llmBaseUrl.trim() && settings.llmApiToken.trim())
  const canChat = usingCodex ? Boolean(codexCatalog && settings.backendConfirmed) : legacyReady
  const codexVoiceOpen = usingCodex && handsFreeStatus !== 'idle' && handsFreeStatus !== 'error'
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const busy = codexPending || voiceDraining || status === 'listening' || status === 'transcribing' || status === 'thinking' || status === 'responding'
  const voiceBlocked = status === 'listening' || status === 'transcribing' || status === 'thinking'
  const agentAction = statusAction(status) || agentDirectedAction
  const liveSelected = settings.agentRealtimeProvider !== 'off'
  const selectedLiveProvider = liveCatalog?.providers.find((provider) => provider.id === settings.agentRealtimeProvider)
  const selectedLiveProviderReady = Boolean(selectedLiveProvider?.available)
  const liveActive = liveVoiceState !== 'closed' && liveVoiceState !== 'error'
  const visualStatus: AgentStatus = liveActive
    ? liveVoiceState === 'speaking' ? 'speaking' : liveVoiceState === 'working' ? 'thinking' : 'listening'
    : previewPlaying ? 'speaking' : status

  function publishAvatarFrame(frame: LiveAvatarAudioFrame) {
    avatarAudioFrameRef.current = frame
    window.electronAPI?.publishPetAudioFrame?.(frame)
  }

  function clearAvatarOutput(invalidate = true) {
    if (invalidate) avatarGenerationRef.current += 1
    avatarEpochRef.current = Math.max(Date.now(), avatarEpochRef.current + 1)
    publishAvatarFrame(silentAvatarAudioFrame(avatarEpochRef.current))
  }

  function beginAvatarOutput() {
    clearAvatarOutput()
    const generation = avatarGenerationRef.current
    let localEpoch = -1
    let wireEpoch = avatarEpochRef.current
    return (frame: LiveAvatarAudioFrame) => {
      if (!mountedRef.current || generation !== avatarGenerationRef.current || frame.epoch < localEpoch) return
      if (frame.epoch !== localEpoch || wireEpoch < avatarEpochRef.current) {
        localEpoch = frame.epoch
        wireEpoch = avatarEpochRef.current = Math.max(Date.now(), avatarEpochRef.current + 1)
      }
      publishAvatarFrame({ ...frame, epoch: wireEpoch })
    }
  }

  function cancelAvatarPreview() {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    const playback = previewPlaybackRef.current
    previewPlaybackRef.current = null
    playback?.close()
    clearAvatarOutput()
    setPreviewPlaying(false)
  }

  async function toggleAvatarPreview() {
    if (previewAbortRef.current || previewPlaybackRef.current) { cancelAvatarPreview(); return }
    const abort = new AbortController()
    previewAbortRef.current = abort
    const onFrame = beginAvatarOutput()
    let enqueueing = true
    let playback: RealtimePlayback
    const finish = () => {
      if (!mountedRef.current || previewPlaybackRef.current !== playback) return
      previewPlaybackRef.current = null
      previewAbortRef.current = null
      playback.close()
      clearAvatarOutput()
      setPreviewPlaying(false)
    }
    playback = new RealtimePlayback(() => {
      if (!enqueueing && !playback.active) finish()
    }, (cause) => {
      setError(cause instanceof Error ? cause.message : '试听播放失败')
      finish()
    }, settings.audioOutputDeviceId || undefined, onFrame)
    previewPlaybackRef.current = playback
    setPreviewPlaying(true)
    try {
      const response = await fetch(new URL('./pet/speech-preview.pcm', window.location.href), { signal: abort.signal })
      if (!response.ok) throw new Error('试听音频未找到，请重新构建桌面端')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.length || bytes.length % 2) throw new Error('试听音频格式不正确')
      // Same 24kHz PCM path as a streaming provider, without an API request.
      for (let offset = 0; offset < bytes.length && !abort.signal.aborted; offset += 4800) {
        const chunk = bytes.subarray(offset, offset + 4800)
        await playback.play(btoa(String.fromCharCode(...chunk)), 'local-avatar-preview')
      }
      enqueueing = false
      if (!playback.active) finish()
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '试听播放失败')
      finish()
    }
  }

  useEffect(() => {
    // A settings change must not leave a microphone streaming to the former
    // backend/provider. AudioRecorder.cancel invalidates pending preparation.
    if (settings.agentRealtimeProvider !== 'off') recorderRef.current.cancel()
    if (!liveVoiceRef.current) return
    liveGenerationRef.current += 1
    liveVoiceRef.current.stop()
    liveVoiceRef.current = null
    clearAvatarOutput()
    setLiveVoiceState('closed'); setLiveCapture(null); setPartialTranscript('')
  }, [settings.serverUrl, settings.agentRealtimeProvider])

  useEffect(() => {
    if (!settings.agentPetEnabled || !window.electronAPI) return
    const lastUser = [...messages].reverse().find((message) => message.role === 'user' && message.kind !== 'tool')
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    const assistantGesture = lastAssistant && messages.length > 1 && !responseActiveRef.current
      ? inferAssistantPetGesture(lastAssistant.content) : 'none'
    const gesture = assistantGesture !== 'none' ? assistantGesture : lastUser ? inferPetGesture(lastUser.content) : 'none'
    const gestureId = assistantGesture !== 'none' ? lastAssistant?.id || '' : lastUser?.id || ''
    let reply = ''
    if (lastAssistant && messages.length > 1 && !responseActiveRef.current
      && lastAssistant.content && petReplyIdRef.current !== lastAssistant.id) {
      reply = lastAssistant.content.slice(0, 240)
      petReplyIdRef.current = lastAssistant.id
    }
    const petStatus = liveActive ? visualStatus : status === 'idle' && handsFreeStatus === 'listening' ? 'listening'
      : status === 'idle' && handsFreeStatus === 'transcribing' ? 'transcribing' : status
    window.electronAPI.publishPetState({ status: petStatus, emotion: agentEmotion, action: agentAction,
      reply, error, gesture, gestureId: gesture === 'none' ? '' : gestureId })
  }, [settings.agentPetEnabled, status, handsFreeStatus, agentEmotion, agentAction, messages, error, liveActive, visualStatus])

  useEffect(() => () => {
    liveGenerationRef.current += 1
    liveVoiceRef.current?.stop()
    liveVoiceRef.current = null
    const previewAbort = previewAbortRef.current
    const previewPlayback = previewPlaybackRef.current
    previewAbortRef.current = null
    previewPlaybackRef.current = null
    previewAbort?.abort()
    previewPlayback?.close()
    speechGenerationRef.current += 1
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null
      currentAudioRef.current.onerror = null
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    if (currentAudioUrlRef.current) URL.revokeObjectURL(currentAudioUrlRef.current)
    currentAudioUrlRef.current = ''
    avatarObserverRef.current?.()
    clearAvatarOutput()
    window.electronAPI?.publishPetState({ status: 'idle', emotion: 'neutral', action: 'idle', reply: '', error: '', gesture: 'none', gestureId: '' })
  }, [])
  const openTasks = useMemo(() => settings.agentTasks.filter((task) => task.status === 'open'), [settings.agentTasks])
  const doneTasks = useMemo(() => settings.agentTasks.filter((task) => task.status === 'done'), [settings.agentTasks])
  const loadedModels = useMemo(() => models.filter((model) => model.is_loaded).map((model) => model.engine), [models])
  const runtimeContext = useMemo(() => {
    const now = new Date()
    const recentItems = history.slice(0, 3).map((item, index) => {
      const text = (item.full_text || '').replace(/\s+/g, ' ').slice(0, 120)
      return `${index + 1}. ${item.filename || item.task_id}: ${text || '无文本'}`
    })
    const recentTools = toolLog.slice(0, 3).map((item, index) => `${index + 1}. ${item.label}`)
    const taskItems = openTasks.slice(0, 8).map((task, index) => `${index + 1}. ${task.id}: ${task.text}`)
    return [
      `本地时间：${now.toLocaleString()}`,
      `桌面前端：${window.electronAPI ? 'Electron' : '浏览器预览'}`,
      `后端状态：${serverStatus}`,
      `离线 ASR：${settings.offlineEngine}`,
      `实时 ASR：${settings.streamingEngine}`,
      `已加载 ASR 引擎：${loadedModels.length ? loadedModels.join(', ') : '未知或未刷新'}`,
      `LLM：${usingCodex ? `Codex/${settings.codexModel || '当前配置'}` : `${settings.llmProvider}/${settings.llmModel || '未选择模型'}`}`,
      `语言：${settings.defaultLanguage}`,
      `实时字幕状态：${liveCaptionStatus}`,
      `角色情绪：${emotionLabel(agentEmotion)} / ${agentAction}`,
      `本地工具：${!usingCodex && settings.agentUseLocalTools ? '开启' : '关闭'}（open_page、remember、add_task、complete_task、speak + 后端技能 ${backendSkills.length ? backendSkills.map(s => s.name).join('、') : '未加载'}）`,
      `任务队列：\n${taskItems.length ? taskItems.join('\n') : '无'}`,
      `最近工具动作：${recentTools.length ? recentTools.join('；') : '无'}`,
      `免按键监听：${handsFreeStatus}`,
      `主动观察：${settings.agentProactive ? `开启，每 ${settings.agentProactiveIntervalMin} 分钟` : '关闭'}`,
      `主动观察状态：${proactiveStatus}`,
      `最近一次语音输入：${lastTranscript || '无'}`,
      `当前转写结果：${currentResult?.full_text ? currentResult.full_text.replace(/\s+/g, ' ').slice(0, 160) : '无'}`,
      `最近转写历史：\n${recentItems.length ? recentItems.join('\n') : '无'}`
    ].join('\n')
  }, [
    currentResult?.full_text,
    history,
    lastTranscript,
    liveCaptionStatus,
    loadedModels,
    serverStatus,
    settings.offlineEngine,
    settings.streamingEngine,
    settings.defaultLanguage,
    usingCodex,
    settings.codexModel,
    settings.llmModel,
    settings.llmProvider,
    settings.agentUseLocalTools,
    agentAction,
    agentEmotion,
    openTasks,
    toolLog,
    settings.agentProactive,
    settings.agentProactiveIntervalMin,
    handsFreeStatus,
    proactiveStatus
  ])

  useEffect(() => {
    statusRef.current = status
    if (status === 'error') setAgentEmotion('concerned')
  }, [status])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const refreshCodexUsage = useCallback(async () => {
    if (!backendReady) return
    const id = codexSessionRef.current
    const [current, total] = await Promise.all([
      codexRequest<CodexAccounting>(settings.serverUrl, `/usage?session_id=${id}`),
      codexRequest<CodexAccounting>(settings.serverUrl, '/usage'),
    ])
    if (mountedRef.current && id === codexSessionRef.current) {
      setCodexUsage(current); setCodexTotal(total)
    }
  }, [settings.serverUrl, backendReady])

  useEffect(() => {
    let cancelled = false
    setCodexCatalog(null)
    setCodexCatalogError('')
    if (!backendReady || !usingCodex) return
    void codexRequest<CodexCatalog>(settings.serverUrl, '/models').then((catalog) => {
      if (cancelled) return
      setCodexCatalog(catalog)
      if (!settings.codexModel) updateSettings({ codexModel: catalog.configured_model || catalog.models[0]?.id || '' })
    }).catch((cause) => {
      if (!cancelled) setCodexCatalogError(cause instanceof Error ? cause.message : 'Codex 连接失败')
    })
    void refreshCodexUsage().catch(() => {})
    const timer = window.setInterval(() => void refreshCodexUsage().catch(() => {}), 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [backendReady, usingCodex, settings.serverUrl, refreshCodexUsage, updateSettings, codexConnectionRevision])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      turnIdRef.current += 1
      if (settings.serverUrl) void codexRequest(settings.serverUrl, `/sessions/${codexSessionRef.current}/cancel`, { method: 'POST' }).catch(() => {})
    }
  }, [settings.serverUrl])

  const codexOptions = () => ({
    session_id: codexSessionRef.current,
    model: settings.codexModel || undefined,
    effort: settings.codexEffort,
    context: [settings.agentPrompt, settings.agentMemory ? `长期记忆：\n${settings.agentMemory}` : '',
      settings.agentUseRuntimeContext ? runtimeContext : '',
      '请用自然语言回答。当前对话不执行本地工具，不要输出 agent_tool 或 agent_state 指令。',
    ].filter(Boolean).join('\n\n').slice(0, 16000),
  })

  const applyCodexReply = (result: CodexReply, messageId = result.call_id) => {
    setMessages((current) => {
      const content = result.status === 'completed' ? result.text : result.error || '请求已取消'
      const found = current.some((message) => message.id === messageId)
      const updated = found ? current.map((message) => message.id === messageId ? { ...message, content, codex: result } : message)
        : [...current, { ...createMessage('assistant', content), id: messageId, codex: result }]
      messagesRef.current = updated
      return updated
    })
    if (result.status !== 'completed') setError(result.error || '请求已取消')
    void refreshCodexUsage().catch(() => setError('用量刷新失败，请稍后重试。'))
  }

  const handleCodexVoice = (event: CodexVoiceEvent) => {
    if (!mountedRef.current) return
    if (event.type === 'agent.queued') { setCodexPending(true); setStatus('thinking') }
    if (event.type === 'agent.started') {
      responseActiveRef.current = true
      setStatus('responding')
    }
    if (event.type === 'agent.delta' && event.call_id) {
      speechBufferRef.current += event.text || ''
      flushSpeechBuffer(false)
      setMessages((current) => {
        const updated = current.some((message) => message.id === event.call_id)
          ? current.map((message) => message.id === event.call_id ? { ...message, content: message.content + (event.text || '') } : message)
          : [...current, { ...createMessage('assistant', event.text || ''), id: event.call_id! }]
        messagesRef.current = updated
        return updated
      })
    }
    if (event.type === 'agent.completed' && event.result) {
      applyCodexReply(event.result)
      responseActiveRef.current = false
      setCodexPending(false)
      flushSpeechBuffer(true)
      if (!speakingRef.current) setStatus('idle')
    }
    if (event.type === 'agent.error') {
      responseActiveRef.current = false
      setCodexPending(false); setError(event.message || 'Codex 请求失败'); setStatus('error')
    }
  }

  // Fetch backend skills on mount
  useEffect(() => {
    if (!backendReady) {
      setBackendSkills([])
      return
    }
    let cancelled = false
    api.listSkills().then((response) => {
      if (!cancelled) setBackendSkills(response.skills)
    }).catch(() => {
      // Backend may not have skills endpoint yet; fail silently
    })
    return () => { cancelled = true }
  }, [api, backendReady])

  useEffect(() => {
    if (settings.agentHandsFree) updateSettings({ agentHandsFree: false })
    return () => {
      handsFreeStreamerRef.current?.stop()
    }
  }, [])

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort()
      handsFreeStreamerRef.current?.stop()
      window.speechSynthesis?.cancel()
      recorderRef.current.cancel()
      const latest = useASRStore.getState().settings
      const useSpeaker = latest.inputSource === 'speaker' || latest.audioInputDeviceId === '__speaker_loopback__'
      if (latest.agentRealtimeProvider === 'off' && !latest.audioRelayEnabled && !useSpeaker) void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
    }
  }, [])

  const buildOptions = (): TranscribeOptions => {
    return {
      engine: settings.offlineEngine,
      timeout_sec: settings.timeoutSec,
      language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
      whisper_model: settings.whisperModel,
      enable_punctuation: true,
      enable_hotwords: true,
      allow_server_data_collection: settings.allowServerDataCollection,
      user_id: settings.userId || undefined
    }
  }

  const pollTask = async (taskId: string) => {
    const startedAt = Date.now()
    const timeoutMs = settings.timeoutSec === 0 ? 30 * 60 * 1000 : settings.timeoutSec * 1000
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      const result = await api.task(taskId)
      if (terminalStatuses.has(result.status)) return result
    }
    throw new Error('任务超时')
  }

  const resetSpeech = () => {
    speechGenerationRef.current += 1
    speechQueueRef.current = []
    speechBufferRef.current = ''
    speakingRef.current = false
    avatarObserverRef.current?.()
    avatarObserverRef.current = null
    if (!liveVoiceRef.current && !previewPlaybackRef.current) clearAvatarOutput()
    responseActiveRef.current = false
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null
      currentAudioRef.current.onerror = null
      currentAudioRef.current.pause()
    }
    currentAudioRef.current = null
    if (currentAudioUrlRef.current) URL.revokeObjectURL(currentAudioUrlRef.current)
    currentAudioUrlRef.current = ''
    if (relaySpeechTimerRef.current !== null) window.clearTimeout(relaySpeechTimerRef.current)
    relaySpeechTimerRef.current = null
    if (audioRelayMixer.isActive()) audioRelayMixer.stopInjectedAudio()
    window.speechSynthesis?.cancel()
  }

  useEffect(() => {
    if (!settings.agentAutoSpeak) {
      resetSpeech()
      if (statusRef.current === 'speaking') setStatus('idle')
    }
  }, [settings.agentAutoSpeak])

  const interruptActiveTurn = () => {
    turnIdRef.current += 1
    streamAbortRef.current?.abort()
    streamAbortRef.current = null
    resetSpeech()
    responseActiveRef.current = false
  }

  const finishSpeechItem = () => {
    avatarObserverRef.current?.()
    avatarObserverRef.current = null
    speakingRef.current = false
    void pumpSpeechQueue()
    if (!speechQueueRef.current.length && !responseActiveRef.current) setStatus('idle')
  }

  const playBrowserSpeech = (text: string) => {
    if (!settingsRef.current.agentAutoSpeak) return
    if (!('speechSynthesis' in window)) {
      finishSpeechItem()
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = settings.defaultLanguage === 'en' ? 'en-US' : 'zh-CN'
    utterance.rate = settings.agentTtsSpeed
    utterance.pitch = 1.04
    const generation = speechGenerationRef.current
    utterance.onstart = () => { if (generation === speechGenerationRef.current) setStatus('speaking') }
    utterance.onend = () => { if (generation === speechGenerationRef.current) finishSpeechItem() }
    utterance.onerror = utterance.onend
    window.speechSynthesis.speak(utterance)
  }

  const playGeneratedSpeech = async (blob: Blob, generation: number) => {
    const canPlay = () => mountedRef.current && generation === speechGenerationRef.current && settingsRef.current.agentAutoSpeak
    if (!canPlay()) return
    if (audioRelayMixer.isActive()) {
      const result = await audioRelayMixer.playBlob(blob, canPlay)
      if (!canPlay()) return
      relaySpeechTimerRef.current = window.setTimeout(() => {
        relaySpeechTimerRef.current = null
        if (speakingRef.current) finishSpeechItem()
      }, Math.max(20, Math.ceil(result.duration * 1000)))
      return
    }
    const url = URL.createObjectURL(blob)
    currentAudioUrlRef.current = url
    const audio = new Audio(url)
    currentAudioRef.current = audio
    avatarObserverRef.current?.()
    avatarObserverRef.current = observeAudioElement(audio, beginAvatarOutput())
    const finish = () => {
      URL.revokeObjectURL(url)
      if (currentAudioUrlRef.current === url) currentAudioUrlRef.current = ''
      if (!canPlay() || currentAudioRef.current !== audio) return
      currentAudioRef.current = null
      finishSpeechItem()
    }
    audio.onended = finish
    audio.onerror = finish
    await audio.play()
  }

  const playServerSpeech = async (text: string) => {
    const generation = speechGenerationRef.current
    const model = settings.agentTtsModel.trim() || settings.llmModel.trim()
    if (!model || !settings.llmBaseUrl.trim() || !settings.llmApiToken.trim()) {
      playBrowserSpeech(text)
      return
    }
    try {
      setStatus('speaking')
      const blob = await api.synthesizeSpeech({
        text,
        provider: settings.llmProvider,
        model,
        voice: settings.agentTtsVoice,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
        response_format: settings.agentTtsFormat,
        speed: settings.agentTtsSpeed
      })
      if (!speakingRef.current || generation !== speechGenerationRef.current || !settingsRef.current.agentAutoSpeak) return
      await playGeneratedSpeech(blob, generation)
    } catch (speechError) {
      console.warn('Server TTS failed, falling back to browser speech', speechError)
      if (generation === speechGenerationRef.current) playBrowserSpeech(text)
    }
  }

  const playVoxCpmSpeech = async (text: string) => {
    const generation = speechGenerationRef.current
    try {
      setStatus('speaking')
      const blob = await api.ttsSpeak(text, 'zh', settings.agentTtsSpeed, 'voxcpm2')
      if (!speakingRef.current || generation !== speechGenerationRef.current || !settingsRef.current.agentAutoSpeak) return
      await playGeneratedSpeech(blob, generation)
    } catch (e) {
      console.warn('VoxCPM2 TTS failed, falling back', e)
      if (generation === speechGenerationRef.current) playBrowserSpeech(text)
    }
  }

  const playGptSovitsSpeech = async (text: string) => {
    const generation = speechGenerationRef.current
    try {
      setStatus('speaking')
      const blob = await api.ttsSpeak(
        text,
        settings.defaultLanguage === 'en' ? 'en' : 'zh',
        settings.agentTtsSpeed
      )
      if (!speakingRef.current || generation !== speechGenerationRef.current || !settingsRef.current.agentAutoSpeak) return
      await playGeneratedSpeech(blob, generation)
    } catch (e) {
      console.warn('GPT-SoVITS TTS failed, falling back to browser', e)
      if (generation === speechGenerationRef.current) playBrowserSpeech(text)
    }
  }

  const pumpSpeechQueue = async () => {
    if (!settingsRef.current.agentAutoSpeak || speakingRef.current) return
    const next = speechQueueRef.current.shift()
    if (!next) {
      setStatus(responseActiveRef.current ? 'responding' : 'idle')
      return
    }
    speakingRef.current = true
    if (settings.agentVoiceMode === 'voxcpm2') await playVoxCpmSpeech(next)
    else if (settings.agentVoiceMode === 'gpt_sovits') await playGptSovitsSpeech(next)
    else if (settings.agentVoiceMode === 'server') await playServerSpeech(next)
    else playBrowserSpeech(next)
  }

  const enqueueSpeech = (text: string) => {
    const cleanText = text.trim()
    if (!cleanText || !settingsRef.current.agentAutoSpeak) return
    speechQueueRef.current.push(cleanText)
    void pumpSpeechQueue()
  }

  const flushSpeechBuffer = (force = false) => {
    if (!settingsRef.current.agentAutoSpeak) {
      speechBufferRef.current = ''
      return
    }
    const buffer = speechBufferRef.current
    if (!buffer.trim()) return
    let splitIndex = -1
    for (const match of buffer.matchAll(SENTENCE_BOUNDARY)) splitIndex = match.index + match[0].length
    if (!force && splitIndex < 8) return

    const spoken = force ? buffer.trim() : buffer.slice(0, splitIndex).trim()
    speechBufferRef.current = force ? '' : buffer.slice(splitIndex).trimStart()
    enqueueSpeech(spoken)
  }

  const buildSystemPrompt = () => {
    const prompt = settings.agentPrompt.trim()
    const memory = settings.agentMemory.trim()
    const blocks = [prompt]
    if (memory) blocks.push(`长期记忆：\n${memory}`)
    if (settings.agentUseRuntimeContext) {
      blocks.push([
        '运行上下文：',
        runtimeContext,
        '使用规则：上下文可能过期或不完整。只在相关时使用，不要声称看到了未在上下文中出现的屏幕画面。'
      ].join('\n'))
    }
    if (settings.agentUseEmotionTags) {
      blocks.push([
        '角色演出输出：',
        '你可以在回复最开头输出一行隐藏状态指令，格式严格为：[[agent_state emotion=happy action=speaking]]',
        'emotion 只能是 neutral、happy、curious、focused、surprised、concerned。',
        'action 只能是 idle、listening、thinking、speaking、observing。',
        '状态指令用于驱动立绘情绪和动作，不要在正文解释这行，也不要把它当作聊天内容。'
      ].join('\n'))
    }
    if (settings.agentUseLocalTools) {
      const localToolDescs = [
        'open_page — 打开指定页面。参数: page（' + toolPages.join('、') + '）。仅用户明确要求时使用。',
        'remember — 保存长期稳定信息（偏好、设定、规则）。参数: text。不要保存密钥/密码。',
        'add_task — 添加待办任务到任务队列。参数: text。',
        'complete_task — 完成任务队列中的任务。参数: id（任务ID）或 text（任务文本）。',
        'speak — 通过前端朗读文字。参数: text、voice（默认alloy）、speed（默认1.0）。'
      ]
      const backendSkillDescs = backendSkills.map((skill) => {
        const params = skill.parameters.map((p) => p.required ? `${p.name}（必填）` : p.name).join('、')
        return `${skill.name} — ${skill.description}。参数: ${params || '无'}`
      })
      const allSkillDescs = [...localToolDescs, ...backendSkillDescs]
      blocks.push([
        '本地工具指令：',
        '你可以在回复最开头输出隐藏工具指令，格式严格为：[[agent_tool name=技能名 参数1=”值1” 参数2=”值2”]]',
        '可用技能：',
        ...allSkillDescs.map((desc, i) => `${i + 1}. ${desc}`),
        'delegate_agent — 委派开发任务给外部 coding agent。参数: agent（codex/claude/claudecode）、prompt（必填）。',
        '工具指令不是正文。输出工具指令后仍要用自然语言简短说明你做了什么或记住了什么。',
        '工具执行结果会在后续对话中以”本地工具结果”提供给你。'
      ].join('\n'))
    }
    return blocks.join('\n\n')
  }

  const addToolLog = (label: string) => {
    setToolLog((current) => [
      { id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, label, createdAt: new Date().toISOString() },
      ...current
    ].slice(0, 6))
  }

  const appendToolObservation = (label: string) => {
    const message = createToolMessage(label)
    setMessages((current) => {
      const updated = [...current, message].slice(-40)
      messagesRef.current = updated
      return updated
    })
  }

  const updateAgentTasks = (tasks: AgentTask[]) => {
    const normalized = tasks
      .filter((task) => task.text.trim())
      .map((task) => ({ ...task, text: task.text.trim().slice(0, 240) }))
      .slice(-40)
    settingsRef.current = { ...settingsRef.current, agentTasks: normalized }
    updateSettings({ agentTasks: normalized })
  }

  const addAgentTask = (text: string) => {
    const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!cleanText) return null
    const exists = settingsRef.current.agentTasks.some((task) => task.status === 'open' && task.text === cleanText)
    if (exists) return null
    const task = createTask(cleanText)
    updateAgentTasks([...settingsRef.current.agentTasks, task])
    return task
  }

  const completeAgentTask = (idOrText: string) => {
    const query = idOrText.replace(/\s+/g, ' ').trim()
    if (!query) return null
    const now = new Date().toISOString()
    const taskIndex = settingsRef.current.agentTasks.findIndex((task) =>
      task.status === 'open' && (task.id === query || task.text.includes(query) || query.includes(task.text))
    )
    if (taskIndex < 0) return null
    const completed: AgentTask = { ...settingsRef.current.agentTasks[taskIndex], status: 'done', updatedAt: now }
    const tasks = settingsRef.current.agentTasks.map((task, index) => index === taskIndex ? completed : task)
    updateAgentTasks(tasks)
    return completed
  }

  const delegateToExternalAgent = async (tool: AgentToolCall) => {
    const agent = ['codex', 'claude', 'claudecode'].includes((tool.args.agent || '').toLowerCase())
      ? tool.args.agent.toLowerCase() as 'codex' | 'claude' | 'claudecode'
      : 'codex'
    const prompt = (tool.args.prompt || tool.args.task || tool.args.text || '').trim().slice(0, 6000)
    if (!prompt) return
    const startLabel = `委派 ${agent}：${prompt.slice(0, 80)}`
    addToolLog(startLabel)
    appendToolObservation(`${startLabel}（执行中）`)
    try {
      const result = await api.delegateAgent({
        agent,
        prompt,
        cwd: '.',
        sandbox: 'workspace-write',
        timeout_sec: 240
      })
      const finalText = (result.final_message || result.stdout || result.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
      const statusText = result.timed_out ? '超时' : result.exit_code === 0 ? '完成' : `退出码 ${result.exit_code}`
      const label = `${agent} ${statusText}：${finalText || '无输出'}`
      addToolLog(label)
      appendToolObservation(label)
    } catch (agentError) {
      const label = `${agent} 委派失败：${agentError instanceof Error ? agentError.message : '未知错误'}`
      addToolLog(label)
      appendToolObservation(label)
    }
  }

  const executeBackendSkill = async (tool: AgentToolCall) => {
    const skillName = tool.name === 'delegate_agent' ? 'delegate_agent' : tool.name
    const startLabel = `执行技能 ${skillName}：${Object.values(tool.args).join(' ').slice(0, 80)}`
    addToolLog(startLabel)
    appendToolObservation(`${startLabel}（执行中）`)
    try {
      // Special case: delegate_agent maps to the existing delegate flow
      if (tool.name === 'delegate_agent') {
        await delegateToExternalAgent(tool)
        return
      }
      // Special case: speak is handled locally by the frontend
      if (tool.name === 'speak') {
        const text = (tool.args.text || '').trim()
        if (text && settingsRef.current.agentAutoSpeak) {
          speechQueueRef.current.push(text)
          void pumpSpeechQueue()
        }
        const label = `朗读：${text.slice(0, 80)}`
        addToolLog(label)
        appendToolObservation(label)
        return
      }
      // All other skills go through the backend skill API
      const parameters: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(tool.args)) {
        if (key !== 'name' && key !== 'id') parameters[key] = value
      }
      // Inject LLM settings for skills that need them
      if (['tts'].includes(tool.name)) {
        parameters.base_url = settingsRef.current.llmBaseUrl
        parameters.api_token = settingsRef.current.llmApiToken
        parameters.model = settingsRef.current.agentTtsModel || settingsRef.current.llmModel
      }
      const result = await api.executeSkill({ skill: tool.name, parameters })
      const statusText = result.success ? '完成' : '失败'
      const output = (result.output || result.error || '无输出').slice(0, 1200)
      const label = `${tool.name} ${statusText}：${output}`
      addToolLog(label)
      appendToolObservation(label)
    } catch (skillError) {
      const label = `${tool.name} 执行失败：${skillError instanceof Error ? skillError.message : '未知错误'}`
      addToolLog(label)
      appendToolObservation(label)
    }
  }

  const executeAgentTool = (tool: AgentToolCall) => {
    if (executedToolsRef.current.has(tool.id)) return
    executedToolsRef.current.add(tool.id)
    if (!settingsRef.current.agentUseLocalTools) return

    // Local tools handled in frontend
    if (tool.name === 'open_page') {
      const page = (tool.args.page || tool.args.target || '').toLowerCase()
      if (!toolPages.includes(page as AppPage)) return
      setPage(page as AppPage)
      const label = `打开页面：${page}`
      addToolLog(label)
      appendToolObservation(label)
      return
    }

    if (tool.name === 'remember') {
      const text = (tool.args.text || tool.args.value || '').replace(/\s+/g, ' ').trim().slice(0, 240)
      if (!text) return
      if (/(api[_ -]?key|token|secret|password|密码|密钥|sk-[a-z0-9]{8,})/i.test(text)) {
        const label = '忽略疑似敏感记忆'
        addToolLog(label)
        appendToolObservation(label)
        return
      }
      const currentMemory = settingsRef.current.agentMemory.trim()
      if (currentMemory.includes(text)) return
      const nextMemory = [currentMemory, `- ${text}`].filter(Boolean).join('\n').slice(-4000)
      settingsRef.current = { ...settingsRef.current, agentMemory: nextMemory }
      updateSettings({ agentMemory: nextMemory })
      const label = `写入记忆：${text}`
      addToolLog(label)
      appendToolObservation(label)
      return
    }

    if (tool.name === 'add_task') {
      const text = tool.args.text || tool.args.task || tool.args.value || ''
      const task = addAgentTask(text)
      if (!task) return
      const label = `加入任务：${task.text}`
      addToolLog(label)
      appendToolObservation(`${label}（${task.id}）`)
      return
    }

    if (tool.name === 'complete_task') {
      const query = tool.args.id || tool.args.text || tool.args.task || ''
      const task = completeAgentTask(query)
      if (!task) return
      const label = `完成任务：${task.text}`
      addToolLog(label)
      appendToolObservation(`${label}（${task.id}）`)
      return
    }

    // Backend skills and hybrid skills (speak, delegate_agent)
    void executeBackendSkill(tool)
  }

  const applyAgentDirectives = (rawText: string) => {
    const stateParsed = parseAgentState(rawText)
    if (stateParsed.emotion) setAgentEmotion(stateParsed.emotion)
    if (stateParsed.action) setAgentDirectedAction(stateParsed.action)
    const toolParsed = parseAgentTools(stateParsed.text, validSkillNames)
    toolParsed.tools.forEach(executeAgentTool)
    return toolParsed.text
  }

  const sendToAgent = async (text: string) => {
    const cleanText = text.trim()
    if (liveSelected) {
      if (!cleanText) return
      if (!liveVoiceRef.current || !liveActive || liveVoiceState === 'connecting') { setError('请先开始所选模型的全双工会话'); return }
      try { liveVoiceRef.current.sendText(cleanText); setDraft(''); setError('') }
      catch (cause) { setError(cause instanceof Error ? cause.message : '实时消息发送失败') }
      return
    }
    if (!cleanText || (usingCodex && (responseActiveRef.current || codexPending || codexVoiceOpen))) return
    if (!canChat) {
      setError(usingCodex ? '请先确认后端地址并连接 Codex' : '请先在模型管理中填写 LLM 接口、模型和 API Token')
      setStatus('error')
      return
    }

    const userMessage = createMessage('user', cleanText)
    const nextMessages = [...messagesRef.current, userMessage]
    messagesRef.current = nextMessages
    setMessages(nextMessages)
    setDraft('')
    setStatus('thinking')
    setError('')
    interruptActiveTurn()
    const turnId = turnIdRef.current

    try {
      const assistantMessage = createMessage('assistant', '')
      const messagesWithAssistant = [...nextMessages, assistantMessage]
      messagesRef.current = messagesWithAssistant
      setMessages(messagesWithAssistant)
      setStatus('responding')
      responseActiveRef.current = true
      const controller = new AbortController()
      streamAbortRef.current = controller
      let streamedText = ''
      const completedTools = new Set<string>()

      if (usingCodex) {
        setCodexPending(true)
        try {
          const result = await streamCodexTurn(settings.serverUrl, { ...codexOptions(), text: cleanText }, controller.signal, (event) => {
            if (turnId !== turnIdRef.current || event.type !== 'agent.delta') return
            streamedText += event.text || ''
            speechBufferRef.current += event.text || ''
            flushSpeechBuffer(false)
            setMessages((current) => {
              const updated = current.map((message) => message.id === assistantMessage.id ? { ...message, content: streamedText } : message)
              messagesRef.current = updated
              return updated
            })
          })
          if (turnId !== turnIdRef.current || !mountedRef.current) return
          applyCodexReply(result, assistantMessage.id)
          responseActiveRef.current = false
          streamAbortRef.current = null
          if (result.status === 'completed') { if (!streamedText) speechBufferRef.current = result.text; flushSpeechBuffer(true) }
          if (!speakingRef.current) setStatus(result.status === 'completed' ? 'idle' : 'error')
        } finally { if (mountedRef.current && turnId === turnIdRef.current) setCodexPending(false) }
        return
      }

      await api.agentChatStream({
        text: cleanText,
        session_id: 'default',
        persona: settings.agentPrompt,
        memory: settings.agentMemory,
        llm_base_url: settings.llmBaseUrl,
        llm_api_token: settings.llmApiToken,
        llm_model: settings.llmModel,
        llm_provider: settings.llmProvider,
        use_skills: settings.agentUseLocalTools,
        use_emotions: settings.agentUseEmotionTags,
        use_context: settings.agentUseRuntimeContext,
        context: {
          time: new Date().toLocaleString(),
          engine: settings.offlineEngine,
          language: settings.defaultLanguage,
          handsfree: handsFreeStatus,
          proactive: proactiveStatus,
          last_transcript: lastTranscript,
        }
      }, (event) => {
        if (turnId !== turnIdRef.current) return

        if (event.type === 'delta') {
          streamedText += event.text
          speechBufferRef.current += event.text
          flushSpeechBuffer(false)
          setMessages((current) => {
            const updated = current.map((m) =>
              m.id === assistantMessage.id ? { ...m, content: streamedText } : m
            )
            messagesRef.current = updated
            return updated
          })
        } else if (event.type === 'state') {
          setAgentEmotion(event.emotion as AgentEmotion)
          setAgentDirectedAction(event.action as AgentAction)
        } else if (event.type === 'tool') {
          const label = `${event.name}: ${event.result.slice(0, 100)}`
          addToolLog(label)
          if (!completedTools.has(event.name + event.result.slice(0, 40))) {
            completedTools.add(event.name + event.result.slice(0, 40))
            appendToolObservation(label)
          }
          // If speak tool, extract text and enqueue for TTS
          if (event.name === 'speak') {
            const speakText = event.result.replace(/^SPEAK:/i, '').trim()
            if (speakText && settingsRef.current.agentAutoSpeak) {
              speechQueueRef.current.push(speakText)
              void pumpSpeechQueue()
            }
          }
        } else if (event.type === 'error') {
          setError(event.message)
          setStatus('error')
        }
      }, controller.signal)

      if (turnId !== turnIdRef.current) return
      responseActiveRef.current = false
      streamAbortRef.current = null
      flushSpeechBuffer(true)

      setMessages((current) => {
        const updated = current.map((m) =>
          m.id === assistantMessage.id ? { ...m, content: streamedText } : m
        )
        messagesRef.current = updated
        return updated
      })

      if (!settings.agentAutoSpeak || (!speakingRef.current && !speechQueueRef.current.length)) setStatus('idle')
    } catch (agentError) {
      if (agentError instanceof DOMException && agentError.name === 'AbortError') return
      responseActiveRef.current = false
      streamAbortRef.current = null
      setError(agentError instanceof Error ? agentError.message : 'Agent 回复失败')
      setStatus('error')
    }
  }

  useEffect(() => {
    sendToAgentRef.current = sendToAgent
  }, [sendToAgent])

  useEffect(() => {
    if (meetingMode || liveSelected || !settings.agentProactive || !canChat) {
      setProactiveStatus('idle')
      proactiveLastAtRef.current = 0
      return
    }

    proactiveLastAtRef.current = Date.now()
    setProactiveStatus('waiting')
    const intervalMs = Math.max(1, settings.agentProactiveIntervalMin) * 60 * 1000
    const checkMs = Math.min(30000, Math.max(5000, Math.round(intervalMs / 4)))
    let statusTimer = 0
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (now - proactiveLastAtRef.current < intervalMs) return
      proactiveLastAtRef.current = now
      if (
        statusRef.current !== 'idle' ||
        speakingRef.current ||
        responseActiveRef.current
      ) {
        return
      }

      setProactiveStatus('triggered')
      void sendToAgentRef.current('系统事件：你处于空闲状态。请基于当前本地上下文和长期记忆，主动说一句简短、有用、不过度打扰的观察、提醒或问题。')
      window.clearTimeout(statusTimer)
      statusTimer = window.setTimeout(() => setProactiveStatus('waiting'), 1200)
    }, checkMs)

    return () => {
      window.clearInterval(timer)
      window.clearTimeout(statusTimer)
    }
  }, [settings.agentProactive, settings.agentProactiveIntervalMin, canChat, meetingMode, liveSelected])

  const inspectScreen = async () => {
    if (!canChat) {
      setError('请先在模型管理中填写 LLM 接口、模型和 API Token')
      setStatus('error')
      return
    }
    if (voiceBlocked) return
    setError('')
    setStatus('thinking')
    interruptActiveTurn()
    const turnId = turnIdRef.current
    try {
      const imageUrl = await captureScreenFrame()
      const prompt = '我刚刚授权你截取了一帧屏幕。请只根据这张截图和本地上下文，简要说明你看到了什么、当前可能在做什么、以及下一步可帮我做什么。'
      const userMessage = createMessage('user', '请观察当前屏幕。')
      const nextMessages = [...messagesRef.current, userMessage]
      messagesRef.current = nextMessages
      const dialogue = nextMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-10)
        .map(({ role, content, kind }) => ({
          role,
          content: kind === 'tool' ? `本地工具结果：${content}` : content
        }))
      const assistantMessage = createMessage('assistant', '')
      const messagesWithAssistant = [...nextMessages, assistantMessage]
      messagesRef.current = messagesWithAssistant
      setMessages(messagesWithAssistant)
      setStatus('responding')
      responseActiveRef.current = true
      const controller = new AbortController()
      streamAbortRef.current = controller
      let streamedRawText = ''
      let streamedText = ''
      const response = await api.streamChat({
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          ...dialogue,
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        provider: settings.llmProvider,
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
        temperature: 0.35
      }, (event) => {
        if (turnId !== turnIdRef.current) return
        if (event.type !== 'delta') return
        streamedRawText += event.text
        const nextStreamedText = applyAgentDirectives(streamedRawText)
        const cleanDelta = nextStreamedText.slice(streamedText.length)
        streamedText = nextStreamedText
        speechBufferRef.current += cleanDelta
        flushSpeechBuffer(false)
        setMessages((current) => {
          const updated = current.map((message) =>
            message.id === assistantMessage.id ? { ...message, content: streamedText } : message
          )
          messagesRef.current = updated
          return updated
        })
      }, controller.signal)
      if (turnId !== turnIdRef.current) return
      responseActiveRef.current = false
      streamAbortRef.current = null
      flushSpeechBuffer(true)
      const finalText = applyAgentDirectives(chatContentText(response.message.content) || streamedRawText) || streamedText
      setMessages((current) => {
        const updated = current.map((message) =>
          message.id === assistantMessage.id ? { ...message, content: finalText } : message
        )
        messagesRef.current = updated
        return updated
      })
      if (!settings.agentAutoSpeak || (!speakingRef.current && !speechQueueRef.current.length)) setStatus('idle')
    } catch (screenError) {
      if (screenError instanceof DOMException && screenError.name === 'AbortError') return
      responseActiveRef.current = false
      streamAbortRef.current = null
      setError(screenError instanceof Error ? screenError.message : '屏幕观察失败')
      setStatus('error')
    }
  }

  const extractMemory = async () => {
    if (!canChat) {
      setError('请先在模型管理中填写 LLM 接口、模型和 API Token')
      return
    }
    const dialogue = messagesRef.current
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map((message) => {
        if (message.kind === 'tool') return `工具：${message.content}`
        return `${message.role === 'user' ? '用户' : 'Agent'}：${message.content}`
      })
      .join('\n')
    if (!dialogue.trim()) {
      setError('没有可提取的对话内容')
      return
    }

    setMemoryStatus('extracting')
    setError('')
    try {
      const response = await api.chat({
        provider: settings.llmProvider,
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: [
              '你是长期记忆整理器。只提取以后对桌面语音 agent 有用的稳定信息。',
              '保留用户偏好、长期目标、称呼、禁忌、角色设定、工作流规则。',
              '不要保存临时闲聊、一次性任务、敏感密钥、API token、完整隐私文本。',
              '输出中文短条目，每行以 "- " 开头。没有可保存信息时只输出“无”。'
            ].join('\n')
          },
          {
            role: 'user',
            content: `已有记忆：\n${settings.agentMemory || '无'}\n\n最近对话：\n${dialogue}\n\n请合并去重后输出新的长期记忆。`
          }
        ]
      })
      const nextMemory = chatContentText(response.message.content).trim()
      if (nextMemory && nextMemory !== '无') updateSettings({ agentMemory: nextMemory })
      setMemoryStatus('done')
      window.setTimeout(() => setMemoryStatus('idle'), 1800)
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : '记忆提取失败')
      setMemoryStatus('idle')
    }
  }

  const transcribeVoice = async (blob: Blob) => {
    setStatus('transcribing')
    setError('')
    try {
      const response = await api.transcribe(blob, `agent_voice_${Date.now()}.webm`, buildOptions())
      const result = isAsyncResponse(response) ? await pollTask(response.task_id) : response
      if (!mountedRef.current || useASRStore.getState().settings.agentRealtimeProvider !== 'off') return
      const text = result.full_text.trim()
      setLastTranscript(text)
      setStatus('idle')
      if (usingCodex && text) await sendToAgentRef.current(text)
      else setDraft((current) => fillPromptFromAsr(current, text))
    } catch (voiceError) {
      if (!mountedRef.current || useASRStore.getState().settings.agentRealtimeProvider !== 'off') return
      setError(voiceError instanceof Error ? voiceError.message : '语音识别失败')
      setStatus('error')
    } finally {
      const latest = useASRStore.getState().settings
      const useSpeaker = latest.inputSource === 'speaker' || latest.audioInputDeviceId === '__speaker_loopback__'
      if (latest.agentRealtimeProvider === 'off' && !audioRelayMixer.isActive() && !useSpeaker) void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
    }
  }

  const toggleHandsFree = async () => {
    if (useASRStore.getState().settings.agentRealtimeProvider !== 'off') return
    if (handsFreeStreamerRef.current) {
      if (usingCodex) {
        setVoiceDraining(true)
        handsFreeStreamerRef.current.finish()
        return
      }
      handsFreeStreamerRef.current.stop()
      handsFreeStreamerRef.current = null
      updateSettings({ agentHandsFree: false })
      setHandsFreeStatus('idle')
      const latest = useASRStore.getState().settings
      const useSpeaker = latest.inputSource === 'speaker' || latest.audioInputDeviceId === '__speaker_loopback__'
      if (latest.agentRealtimeProvider === 'off' && !audioRelayMixer.isActive() && !useSpeaker) void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
      return
    }
    if (usingCodex ? !canChat || responseActiveRef.current || codexPending : status !== 'idle') return
    if (usingCodex && status !== 'speaking') setStatus('idle')
    if (!backendReady) {
      setError('未确认后端地址。请先在设置中输入后端 IP/地址并点击确认。')
      return
    }
    setError('')
    setAecStatus('正在启用声学回声消除…')
    setPartialTranscript('')
    setHandsFreeStatus('connecting')
    try {
      const streamer = new StreamingASRClient(settings.serverUrl, (event) => {
        if (!mountedRef.current || handsFreeStreamerRef.current !== streamer) return
        if (event.type === 'accepted') setHandsFreeStatus('loading')
        if (event.type === 'loading') setHandsFreeStatus('loading')
        if (event.type === 'ready') setHandsFreeStatus('loading')
        if (event.type === 'configured') { setHandsFreeStatus('listening'); if (usingCodex) setStatus('listening') }
        if (event.type === 'speech_start') setHandsFreeStatus('transcribing')
        if (event.type === 'partial' && usingCodex) setPartialTranscript(event.text)
        if (event.type === 'final') {
          const text = event.text.trim()
          if (usingCodex) {
            setPartialTranscript('')
            setLastTranscript(text)
            if (text) setMessages((current) => {
              const updated = [...current, createMessage('user', text)]
              messagesRef.current = updated
              return updated
            })
            setHandsFreeStatus('listening')
            return
          }
          if (statusRef.current !== 'idle' || speakingRef.current || responseActiveRef.current || text.length < 2) {
            setHandsFreeStatus('listening')
            return
          }
          setLastTranscript(text)
          setHandsFreeStatus('listening')
          void sendToAgentRef.current(text)
        }
        if (event.type === 'error') {
          setError(event.message)
          setAecStatus('语音启动失败，可重新点击语音重试')
          setHandsFreeStatus('error')
          if (usingCodex) { streamer.stop(); setCodexPending(false); setVoiceDraining(false) }
        }
        if (event.type === 'closed' && handsFreeStreamerRef.current) {
          setVoiceDraining(false)
          if (usingCodex && event.intentional && !speakingRef.current) setStatus('idle')
          setCodexPending(false)
          responseActiveRef.current = false
          if (usingCodex && !event.intentional) { setError('语音连接已断开，请重新开始。'); setStatus('error') }

          handsFreeStreamerRef.current = null
          updateSettings({ agentHandsFree: false })
          setHandsFreeStatus('idle')
          const latest = useASRStore.getState().settings
          const useSpeaker = latest.inputSource === 'speaker' || latest.audioInputDeviceId === '__speaker_loopback__'
          if (latest.agentRealtimeProvider === 'off' && !audioRelayMixer.isActive() && !useSpeaker) void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
        }
      })
      handsFreeStreamerRef.current = streamer
      const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      await streamer.start({
        engine: settings.streamingEngine,
        language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
        deviceId: useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
        inputStream: useSpeaker
          ? await captureSpeakerAudio()
          : audioRelayMixer.isActive()
            ? audioRelayMixer.createInputStream()
            : recorderRef.current.takePreparedStream(settings.audioInputDeviceId || undefined),
        userId: settings.userId || undefined,
        archive: settings.allowServerDataCollection,
        echoCancellation: true,
        ...(usingCodex ? { onCaptureSettings: (state: { mode: string }) => {
          if (!mountedRef.current || handsFreeStreamerRef.current !== streamer) return
          const labels: Record<string, string> = {
            all: '声学回声消除已开启 · 系统播放参考', browser: '声学回声消除已开启 · WebRTC',
            unavailable: '录音已开启；当前设备未启用回声消除，自动朗读保持关闭',
            unknown: '录音已开启；浏览器未报告回声消除状态，自动朗读保持关闭',
          }
          setAecStatus(labels[state.mode])
          if (state.mode === 'unavailable' || state.mode === 'unknown') updateSettings({ agentAutoSpeak: false })
        }, endpointing: 'manual' as const, agent: { enabled: true, ...codexOptions() }, onAgentEvent: (event: CodexVoiceEvent) => { if (handsFreeStreamerRef.current === streamer) handleCodexVoice(event) } } : {}),
      })
      if (!mountedRef.current || useASRStore.getState().settings.agentRealtimeProvider !== 'off' || handsFreeStreamerRef.current !== streamer) {
        streamer.stop()
        if (handsFreeStreamerRef.current === streamer) handsFreeStreamerRef.current = null
        return
      }
      updateSettings({ agentHandsFree: true })
    } catch (handsFreeError) {
      if (!mountedRef.current || useASRStore.getState().settings.agentRealtimeProvider !== 'off') return
      handsFreeStreamerRef.current = null
      updateSettings({ agentHandsFree: false })
      setHandsFreeStatus('error')
      setAecStatus('声学回声消除未就绪')
      setError(handsFreeError instanceof Error ? handsFreeError.message : '免按键监听启动失败')
    }
  }

  const appendLiveTranscript = (role: 'user' | 'assistant', delta: string) => {
    const now = Date.now()
    const slot = liveMessageRef.current[role]
    if (!slot.id || now - slot.at > 1800) slot.id = `${role}_live_${now}_${Math.random().toString(36).slice(2, 7)}`
    slot.at = now
    setMessages((current) => {
      const existing = current.some((message) => message.id === slot.id)
      const updated = existing
        ? current.map((message) => message.id === slot.id ? { ...message, content: message.content + delta } : message)
        : [...current, { ...createMessage(role, delta), id: slot.id }]
      messagesRef.current = updated
      return updated
    })
    if (role === 'user') setLastTranscript((current) => (current + delta).slice(-500))
  }

  const toggleLiveVoice = async () => {
    if (previewAbortRef.current || previewPlaybackRef.current) cancelAvatarPreview()
    if (liveVoiceRef.current) {
      liveGenerationRef.current += 1
      liveVoiceRef.current.stop(); liveVoiceRef.current = null
      clearAvatarOutput()
      setLiveVoiceState('closed'); setLiveCapture(null); setPartialTranscript('')
      return
    }
    const provider = settings.agentRealtimeProvider
    if (provider === 'off') return
    if (!backendReady) { setError('请先在设置中确认本机后端地址'); return }
    if (!selectedLiveProviderReady) {
      setError(selectedLiveProvider?.unavailable_reason || '所选实时模型尚不可用，请检查服务商配置。')
      return
    }
    handsFreeStreamerRef.current?.stop()
    handsFreeStreamerRef.current = null
    recorderRef.current.cancel()
    setHandsFreeStatus('idle')
    interruptActiveTurn()
    setStatus('idle')
    const generation = ++liveGenerationRef.current
    const currentSession = () => generation === liveGenerationRef.current && mountedRef.current
    const onAvatarFrame = beginAvatarOutput()
    const callbacks: LiveVoiceCallbacks = {
      onAvatarAudioFrame: (frame) => { if (currentSession()) onAvatarFrame(frame) },
      onState: (state) => {
        if (!currentSession()) return
        setLiveVoiceState(state)
        if (state === 'closed' || state === 'error') { liveVoiceRef.current = null; clearAvatarOutput(); setLiveCapture(null); setPartialTranscript('') }
      },
      onTranscript: (role, delta) => { if (currentSession()) appendLiveTranscript(role, delta) },
      onTranscriptItem: ({ role, text, id, final }) => {
        if (!currentSession()) return
        const messageId = `live_${generation}_${role}_${id}`
        setMessages((current) => {
          const next = current.some((message) => message.id === messageId)
            ? current.map((message) => message.id === messageId ? { ...message, content: text } : message)
            : [...current, { ...createMessage(role, text), id: messageId }]
          messagesRef.current = next
          return next
        })
        if (role === 'user') { setLastTranscript(text); setPartialTranscript(final ? '' : text) }
      },
      onCapture: (capture) => { if (currentSession()) setLiveCapture(capture) },
      onTool: ({ name, result }) => {
        if (!currentSession()) return
        const label = `${name}：${typeof result === 'string' ? result : JSON.stringify(result)}`
        setToolLog((current) => [{ id: crypto.randomUUID(), label, createdAt: new Date().toISOString() }, ...current].slice(0, 20))
      },
      onError: (message) => { if (currentSession()) setError(message) },
      onDelegate: async (task) => {
        if (!currentSession()) throw new Error('语音会话已结束')
        setCodexPending(true)
        try {
          const current = settingsRef.current
          const allowWork = current.agentWorkMode && window.confirm(
            `允许 Codex 执行以下后台任务吗？\n\n${task.slice(0, 800)}\n\n执行时将使用当前 Windows 用户权限，可运行命令并读写本机文件。请只批准明确任务；取消后仅进行分析。`
          )
          const workToken = allowWork ? await window.electronAPI?.getWorkToken() : ''
          if (allowWork && !workToken) throw new Error('桌面端未取得本机任务授权令牌，请重启后端和桌面端')
          const result = await codexRequest<CodexReply>(current.serverUrl, '/turns', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(workToken ? { 'X-Amadeus-Work-Token': workToken } : {}) },
            body: JSON.stringify({
              session_id: codexSessionRef.current,
              model: current.codexModel || undefined,
              effort: current.codexEffort,
              allow_work: allowWork,
              context: [current.agentPrompt, current.agentMemory ? `长期记忆：\n${current.agentMemory}` : '',
                '你在为爱弥斯实时语音会话处理一项后台任务。请给出准确结果和当前完成状态。'].filter(Boolean).join('\n\n').slice(0, 16000),
              text: task.slice(0, 12000),
            }),
          })
          if (!currentSession()) throw new Error('语音会话已结束')
          if (result.status !== 'completed') throw new Error(result.error || 'Codex 任务未完成')
          setMessages((messages) => [...messages, createToolMessage(`Codex 已完成后台任务：${result.text.slice(0, 500)}`)])
          void refreshCodexUsage().catch(() => {})
          return result.text
        } finally { if (currentSession()) setCodexPending(false) }
      },
    }
    const options = settings.agentRealtimeOptions?.[provider] || {}
    const voice = selectedLiveProvider?.voices.some((item) => item.id === options.voice) ? options.voice : selectedLiveProvider?.default_voice
    const instructions = [settings.agentPrompt, settings.agentMemory ? `长期记忆：\n${settings.agentMemory}` : ''].filter(Boolean).join('\n\n')
    const session = new LiveVoiceSession(settings.serverUrl, provider, instructions, callbacks, {
      voice: voice || undefined,
      brain: provider === 'qwen' && liveCatalog?.brain_available ? options.brain || 'off' : 'off',
      reasoning: provider === 'gemini_thinking' ? options.reasoning || 'low' : options.reasoning || 'high',
      outputDeviceId: settings.audioOutputDeviceId || undefined,
    })
    liveVoiceRef.current = session
    setError('')
    setLastTranscript('')
    setPartialTranscript(''); setLiveCapture(null)
    liveMessageRef.current = { user: { id: '', at: 0 }, assistant: { id: '', at: 0 } }
    try { await session.start(settings.audioInputDeviceId || undefined) }
    catch (cause) {
      if (!currentSession()) return
      liveGenerationRef.current += 1
      session.stop()
      if (liveVoiceRef.current === session) liveVoiceRef.current = null
      setLiveVoiceState('error')
      setError(cause instanceof Error ? cause.message : '实时语音启动失败')
    }
  }

  const toggleVoice = async () => {
    if (liveSelected) { await toggleLiveVoice(); return }
    if (usingCodex) {
      if (!canChat && !codexVoiceOpen) {
        setError('请先确认后端地址并连接 Codex')
        setStatus('error')
        return
      }
      if (!voiceDraining) await toggleHandsFree()
      return
    }
    if (status === 'listening') {
      const { blob } = await recorderRef.current.stop()
      await transcribeVoice(blob)
      return
    }
    if (status === 'transcribing' || status === 'thinking') return
    if (handsFreeStreamerRef.current) {
      handsFreeStreamerRef.current.stop()
      handsFreeStreamerRef.current = null
      updateSettings({ agentHandsFree: false })
      setHandsFreeStatus('idle')
    }
    interruptActiveTurn()
    const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
    try { await recorderRef.current.start(
      useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
      useSpeaker
        ? await captureSpeakerAudio()
        : audioRelayMixer.isActive() ? audioRelayMixer.createInputStream() : undefined,
    ) } catch (cause) {
      setError(cause instanceof Error ? cause.message : '录音启动失败')
      setStatus('error')
      return
    }
    setStatus('listening')
    setError('')
  }

  useEffect(() => {
    if (!petCommand) return
    setPetCommand(null)
    if (meetingMode && petCommand.type !== 'open') {
      setMeetingMode(false)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#realtime`)
    }
    if (petCommand.type === 'voice') void toggleVoice()
    if (petCommand.type === 'text' && petCommand.text?.trim()) void sendToAgentRef.current(petCommand.text)
  }, [petCommand, setPetCommand, meetingMode])

  const stopSpeech = async () => {
    if (previewAbortRef.current || previewPlaybackRef.current) cancelAvatarPreview()
    if (liveVoiceRef.current) { liveVoiceRef.current.interrupt(); clearAvatarOutput(false); return }
    interruptActiveTurn()
    if (usingCodex) {
      setCodexPending(true)
      handsFreeStreamerRef.current?.cancelAgent()
      try { await codexRequest(settings.serverUrl, `/sessions/${codexSessionRef.current}/cancel`, { method: 'POST' }) }
      catch (cause) { setError(cause instanceof Error ? cause.message : '取消失败') }
      finally { setCodexPending(false); void refreshCodexUsage().catch(() => {}) }
    }
    setStatus('idle')
  }

  const resetConversation = async () => {
    cancelAvatarPreview()
    interruptActiveTurn()
    liveGenerationRef.current += 1
    liveVoiceRef.current?.stop()
    liveVoiceRef.current = null
    setLiveVoiceState('closed'); setLiveCapture(null); setPartialTranscript(''); setCodexPending(false)
    liveMessageRef.current = { user: { id: '', at: 0 }, assistant: { id: '', at: 0 } }
    handsFreeStreamerRef.current?.stop()
    handsFreeStreamerRef.current = null
    setHandsFreeStatus('idle'); setVoiceDraining(false)
    if (usingCodex && backendReady && !liveSelected) {
      setCodexPending(true)
      try { await codexRequest(settings.serverUrl, `/sessions/${codexSessionRef.current}`, { method: 'DELETE' }) }
      catch (cause) { setError(cause instanceof Error ? cause.message : '清空失败'); setCodexPending(false); return }
      codexSessionRef.current = crypto.randomUUID()
      setCodexUsage(null)
      void refreshCodexUsage().catch(() => {})
      setCodexPending(false)
    }
    const resetMessages = [createMessage('assistant', '上下文已清空。我们重新开始。')]
    messagesRef.current = resetMessages
    setMessages(resetMessages)
    setAgentEmotion('neutral')
    setAgentDirectedAction('idle')
    executedToolsRef.current = new Set()
    setToolLog([])
    setLastTranscript('')
    setError('')
    setStatus('idle')
  }

  return (
    <div className="page realtime-agent-page">
      <section className="agent-stage">
        <div className="agent-visual" data-emotion={agentEmotion} data-action={agentAction}>
          <Aemeath3D status={visualStatus} emotion={agentEmotion} action={agentAction} gesture={inferPetGesture(lastTranscript)} audioFrameRef={avatarAudioFrameRef} view={avatarView} />
          <div className="agent-avatar-controls">
            <button type="button" onClick={() => setAvatarView((view) => view === 'portrait' ? 'full' : 'portrait')}>{avatarView === 'portrait' ? '全身视角' : '半身视角'}</button>
            <button type="button" disabled={liveActive || (!previewPlaying && (busy || speakingRef.current))} onClick={() => void toggleAvatarPreview()} title="播放本地测试语音，不调用在线模型">{previewPlaying ? '停止试听' : '试听口型'}</button>
          </div>
          <div className={`agent-status ${visualStatus}`}>
            <span className="mini-wave" aria-hidden="true" />
            <strong>{liveVoiceState === 'connecting' ? '连接实时语音' : liveVoiceState === 'working' ? '后台任务中' : statusLabel(visualStatus)}</strong>
          </div>
          <div className="agent-presence">
            <span>{emotionLabel(agentEmotion)}</span>
            <span>{agentAction}</span>
          </div>
        </div>

        <div className="agent-dialogue">
          <div className="section-head compact">
            <div>
              <h1>实时对话</h1>
              <select aria-label="实时对话模式" value={meetingMode ? 'meeting' : 'chat'} disabled={busy || codexVoiceOpen || meetingBusy || liveActive} onChange={(event) => {
                const meeting = event.target.value === 'meeting'
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${meeting ? '#meeting' : '#realtime'}`)
                setMeetingMode(meeting)
              }}><option value="chat">语音对话</option><option value="meeting">会议旁听与解释</option></select>
              <p>{liveSelected ? `${selectedLiveProvider?.label || settings.agentRealtimeProvider} · ${selectedLiveProvider?.model || '读取配置中'}` : `${usingCodex ? `Codex · ${settings.codexModel || '连接中'}` : settings.llmModel || '未选择 LLM 模型'} / ${usingCodex ? settings.streamingEngine : settings.offlineEngine}`}</p>
            </div>
            {!meetingMode && <div className="agent-actions">
              <button type="button" onClick={() => void inspectScreen()} disabled={busy || !legacyReady || usingCodex || liveSelected} title={usingCodex ? '屏幕观察暂需切换到原有 Agent' : undefined}>
                看屏幕
              </button>
              <button type="button" onClick={() => void sendToAgent('根据你当前可见的本地上下文，简要说明你现在知道哪些状态。')} disabled={liveSelected ? !liveActive || liveVoiceState === 'connecting' : busy}>
                读状态
              </button>
              <button type="button" onClick={() => void stopSpeech()} disabled={liveSelected ? !liveActive || liveVoiceState === 'connecting' : status !== 'speaking' && !codexPending}>{!liveSelected && codexPending ? '取消回答' : '停止朗读'}</button>
              <button type="button" onClick={() => void resetConversation()} disabled={voiceDraining}>清空</button>
            </div>}
          </div>

          {meetingMode ? <MeetingAssistPanel onBusy={setMeetingBusy} /> : <>
          <div className="agent-messages">
            {messages.map((message) => (
              <article key={message.id} className={`agent-message ${message.kind === 'tool' ? 'tool' : message.role}`}>
                <strong>{message.kind === 'tool' ? '工具' : message.role === 'user' ? '你' : liveSelected ? '艾米斯' : usingCodex ? 'Codex' : 'Agent'}</strong>
                <p>{message.content || '...'}</p>
                {message.codex && <small>{message.codex.model} · {message.codex.elapsed_sec.toFixed(1)} 秒 · {message.codex.usage ? `${message.codex.usage.total_tokens.toLocaleString()} tokens` : '用量暂不可用'}</small>}
              </article>
            ))}
          </div>

          <div className="agent-input-row">
            <button type="button" className={(liveSelected ? liveActive : usingCodex ? codexVoiceOpen && !voiceDraining : status === 'listening') ? 'primary record-button recording' : 'record-button'} onClick={() => void toggleVoice()} disabled={liveSelected ? liveVoiceState === 'connecting' || (!liveActive && !selectedLiveProviderReady) : usingCodex && (!canChat || voiceDraining || (!codexVoiceOpen && busy))}>
              <span aria-hidden="true">●</span>
              {liveSelected ? liveActive ? '结束全双工' : '开始全双工' : usingCodex ? voiceDraining ? '完成回答中' : codexVoiceOpen ? '结束语音' : '语音' : status === 'listening' ? '结束语音' : status === 'responding' || status === 'speaking' ? '打断' : '语音'}
            </button>
            <input
              value={draft}
              aria-label="对话消息"
              maxLength={liveSelected ? 2000 : 12000}
              disabled={liveSelected ? liveVoiceState === 'connecting' : usingCodex && (busy || codexVoiceOpen)}
              placeholder={liveSelected ? '开始全双工后，也可在此发送文字消息' : usingCodex ? '输入消息，或点击语音直接与 Codex 对话' : '输入消息，或点击语音自动填入 ASR 结果'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && (liveSelected ? liveActive && liveVoiceState !== 'connecting' : !busy)) void sendToAgent(draft)
              }}
            />
            <button type="button" className="primary" disabled={!draft.trim() || (liveSelected ? !liveActive || liveVoiceState === 'connecting' : busy || !canChat || codexVoiceOpen)} onClick={() => void sendToAgent(draft)}>发送</button>
          </div>
          {liveSelected ? <p className="agent-transcript">实时语音可边听边说，点击「停止朗读」只打断当前回复。{selectedLiveProviderReady ? '会话使用下方所选模型与音色。' : selectedLiveProvider?.unavailable_reason || '请配置所选服务商。'}</p> : usingCodex && <p className="agent-transcript">录音期间持续识别，点击「结束语音」后才发送给 Codex。</p>}
          {liveCapture && <p className="agent-transcript" aria-label="实时麦克风采集">输入 {Number.isFinite(liveCapture.level) ? liveCapture.level.toFixed(0) : '—'} dB · 已采集 {liveCapture.seconds.toFixed(1)} 秒{liveCapture.serverSeconds != null ? ` · 后端收到 ${liveCapture.serverSeconds.toFixed(1)} 秒` : ''}</p>}
          {aecStatus && <p className="agent-transcript">{aecStatus}</p>}
          {partialTranscript && <p className="agent-transcript">正在识别：{partialTranscript}</p>}
          {lastTranscript && <p className="agent-transcript">ASR：{lastTranscript}</p>}
          {toolLog[0] && <p className="agent-tool-log">工具：{toolLog[0].label}</p>}
          {error && <p className="error">{error}</p>}
          </>}
        </div>
      </section>

      <section className="agent-config panel">
        <div className="section-head compact">
          <h2>{liveSelected ? '实时语音设定' : 'Agent 设定'}</h2>
          {!liveSelected && <div className="agent-actions">
            <button type="button" onClick={() => void extractMemory()} disabled={memoryStatus === 'extracting' || !legacyReady || usingCodex} title={usingCodex ? '自动提取记忆暂需切换到原有 Agent；手动记忆可继续使用' : undefined}>
              {memoryStatus === 'extracting' ? '提取中' : memoryStatus === 'done' ? '已处理' : '提取记忆'}
            </button>
            <button type="button" onClick={() => setPage('models')}>模型管理</button>
          </div>}
        </div>
        <div className="agent-config-grid">
          <RealtimeVoiceConfig disabled={liveActive || busy || codexVoiceOpen || meetingBusy} onCatalog={setLiveCatalog} />
          {!liveSelected && <>
          <label>对话引擎
            <select aria-label="对话引擎" value={settings.agentBackend} disabled={busy || codexVoiceOpen} onChange={(event) => { updateSettings({ agentBackend: event.target.value as 'codex' | 'legacy' }); setError('') }}>
              <option value="codex">Codex</option><option value="legacy">原有 Agent</option>
            </select>
          </label>
          {usingCodex && <>
            <label>Codex 模型
              <select aria-label="Codex 模型" value={settings.codexModel} disabled={busy || codexVoiceOpen} onChange={(event) => updateSettings({ codexModel: event.target.value, codexEffort: codexCatalog?.models.find((item) => item.id === event.target.value)?.default_effort || 'low' })}>
                {!codexCatalog?.models.some((item) => item.id === settings.codexModel) && <option value={settings.codexModel}>{settings.codexModel || '正在读取模型…'}</option>}
                {codexCatalog?.models.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
            <label>推理强度
              <select aria-label="推理强度" value={settings.codexEffort} disabled={busy || codexVoiceOpen} onChange={(event) => updateSettings({ codexEffort: event.target.value })}>
                {(codexCatalog?.models.find((item) => item.id === settings.codexModel)?.efforts || ['low', 'medium', 'high', 'xhigh']).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
            <div className="wide agent-codex-usage" aria-label="Codex 用量">
              <p>{codexCatalogError || (codexCatalog ? `Codex 配置已读取 · ${codexCatalog.provider}` : backendReady ? '正在连接 Codex…' : '请在设置中确认后端地址')}</p>
              {backendReady && <button type="button" disabled={busy || codexVoiceOpen} onClick={() => { setError(''); setCodexConnectionRevision((value) => value + 1) }}>重新检查连接</button>}
              <p>本次对话：{codexUsage?.total_tokens.toLocaleString() ?? '—'} tokens · {codexUsage?.calls ?? 0} 次调用
                <button type="button" onClick={() => void refreshCodexUsage().catch(() => setError('用量刷新失败'))}>刷新用量</button></p>
              <small>输入 {codexUsage?.input_tokens.toLocaleString() ?? '—'}（含缓存 {codexUsage?.cached_input_tokens.toLocaleString() ?? '—'}） · 输出 {codexUsage?.output_tokens.toLocaleString() ?? '—'} · 本应用累计 {codexTotal?.total_tokens.toLocaleString() ?? '—'} tokens。用量不等于账单或剩余额度。</small>
              {codexTotal && !codexTotal.complete && <p>应用累计另有 {codexTotal.missing_usage} 次调用暂无用量。</p>}
              {codexUsage && !codexUsage.complete && <p>另有 {codexUsage.missing_usage} 次调用暂无用量，上方为已知小计。</p>}
            </div>
          </>}
          </>}

          <label className="wide">
            角色设定
            <textarea value={settings.agentPrompt} onChange={(event) => updateSettings({ agentPrompt: event.target.value })} rows={5} />
          </label>
          <label className="wide">
            记忆
            <textarea value={settings.agentMemory} onChange={(event) => updateSettings({ agentMemory: event.target.value })} rows={4} placeholder="写入用户偏好、角色设定、直播间规则或长期目标" />
          </label>
          {!liveSelected && <label className="check">
            <input type="checkbox" disabled={liveSelected} checked={settings.agentAutoSpeak} onChange={(event) => updateSettings({ agentAutoSpeak: event.target.checked })} />
            自动朗读回复
          </label>}
          {(!liveSelected || settings.agentRealtimeProvider === 'openai') && <label className="check wide">
            <input type="checkbox" checked={settings.agentWorkMode} onChange={(event) => updateSettings({ agentWorkMode: event.target.checked })} />
            允许全双工后台任务申请本机执行权限（每次执行前确认）
          </label>}
          <label className="check">
            <input type="checkbox" disabled={!window.electronAPI || navigator.platform !== 'Win32'} checked={settings.agentPetEnabled} onChange={(event) => updateSettings({ agentPetEnabled: event.target.checked })} />
            显示爱弥斯 3D 桌宠
          </label>
          {!liveSelected && <>
          <label className="check">
            <input type="checkbox" checked={settings.agentUseRuntimeContext} onChange={(event) => updateSettings({ agentUseRuntimeContext: event.target.checked })} />
            注入运行上下文
          </label>
          <label className="check">
            <input type="checkbox" disabled={usingCodex} title={usingCodex ? 'Codex 立绘跟随对话状态' : undefined} checked={settings.agentUseEmotionTags} onChange={(event) => updateSettings({ agentUseEmotionTags: event.target.checked })} />
            情绪驱动立绘
          </label>
          <label className="check">
            <input type="checkbox" disabled={usingCodex} title={usingCodex ? '当前 Codex 对话不执行本地工具' : undefined} checked={settings.agentUseLocalTools} onChange={(event) => updateSettings({ agentUseLocalTools: event.target.checked })} />
            本地工具指令
          </label>
          <label className="check">
            <input type="checkbox" disabled={liveSelected || voiceDraining || (usingCodex && !canChat)} checked={handsFreeStatus !== 'idle' && handsFreeStatus !== 'error'} onChange={() => void toggleHandsFree()} />
            {usingCodex ? '连续识别（手动结束）' : '免按键监听'}
          </label>
          <label className="check">
            <input type="checkbox" disabled={liveSelected} checked={settings.agentProactive} onChange={(event) => updateSettings({ agentProactive: event.target.checked })} />
            主动观察
          </label>
          <label>
            主动间隔（分钟）
            <input type="number" min="1" max="120" step="1" disabled={!settings.agentProactive} value={settings.agentProactiveIntervalMin} onChange={(event) => updateSettings({ agentProactiveIntervalMin: Number(event.target.value) || 5 })} />
          </label>
          <label>
            语音模式
            <select value={settings.agentVoiceMode} onChange={(event) => updateSettings({ agentVoiceMode: event.target.value as AgentVoiceMode })}>
              <option value="browser">浏览器朗读</option>
              <option value="server">服务端 TTS</option>
              <option value="gpt_sovits">GPT-SoVITS 克隆</option>
              <option value="voxcpm2">VoxCPM2</option>
            </select>
          </label>
          <label>
            TTS 模型
            <input value={settings.agentTtsModel} onChange={(event) => updateSettings({ agentTtsModel: event.target.value })} placeholder={settings.llmModel || '例如 tts-1'} />
          </label>
          <label>
            音色
            <input value={settings.agentTtsVoice} onChange={(event) => updateSettings({ agentTtsVoice: event.target.value })} placeholder="alloy" />
          </label>
          <label>
            格式
            <select value={settings.agentTtsFormat} onChange={(event) => updateSettings({ agentTtsFormat: event.target.value as typeof settings.agentTtsFormat })}>
              <option value="mp3">mp3</option>
              <option value="opus">opus</option>
              <option value="aac">aac</option>
              <option value="flac">flac</option>
              <option value="wav">wav</option>
              <option value="pcm">pcm</option>
            </select>
          </label>
          <label>
            语速
            <input type="number" min="0.25" max="4" step="0.05" value={settings.agentTtsSpeed} onChange={(event) => updateSettings({ agentTtsSpeed: Number(event.target.value) || 1 })} />
          </label>
          </>}
          <label>
            输入设备
            <input value={settings.audioInputDeviceId || '跟随系统'} readOnly />
          </label>
        </div>
        {!liveSelected && <><div className="agent-task-board">
          <div className="section-head compact">
            <h2>任务队列</h2>
            <button type="button" disabled={!settings.agentTasks.length} onClick={() => updateAgentTasks([])}>清空</button>
          </div>
          <div className="agent-task-list">
            {openTasks.length ? openTasks.map((task) => (
              <div key={task.id} className="agent-task-item">
                <span>{task.text}</span>
                <button type="button" onClick={() => {
                  const now = new Date().toISOString()
                  updateAgentTasks(settingsRef.current.agentTasks.map((item) =>
                    item.id === task.id ? { ...item, status: 'done', updatedAt: now } : item
                  ))
                }}>完成</button>
              </div>
            )) : <p>无未完成任务</p>}
          </div>
          {doneTasks.length > 0 && (
            <div className="agent-task-list done">
              {doneTasks.slice(-3).map((task) => (
                <div key={task.id} className="agent-task-item done">
                  <span>{task.text}</span>
                  <button type="button" onClick={() => {
                    const now = new Date().toISOString()
                    updateAgentTasks(settingsRef.current.agentTasks.map((item) =>
                      item.id === task.id ? { ...item, status: 'open', updatedAt: now } : item
                    ))
                  }}>恢复</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="agent-context-preview">
          <div className="section-head compact">
            <h2>本地上下文</h2>
            <button type="button" onClick={() => window.electronAPI?.textToClipboard(runtimeContext)}>复制</button>
          </div>
          <pre>{runtimeContext}</pre>
        </div>
        </>}
      </section>
    </div>
  )
}
