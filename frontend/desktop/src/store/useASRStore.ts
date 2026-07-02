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
  summaryPrompt: string
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
  keepRunningInBackground: boolean
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
  llmPolishPrompt: `你是一个专业的 ASR 转写结果后处理模型。你的任务是对输入文本进行纠错、断句、标点补全和轻度润色，使其更准确、更自然、更适合接入后续 LLM 理解。

输入只有一段 ASR 转写文本。输出只允许返回润色后的文本，不要解释，不要列修改点，不要输出 JSON，不要添加任何额外内容。

处理规则：

保持原意不变
只能修正明显的识别错误、错别字、同音词错误、断句错误、标点缺失和口语重复。不得改写用户意图，不得扩展内容，不得添加用户没有说过的信息。
优先准确，其次流畅
不要为了让句子更漂亮而改变表达。口语可以适度整理，但不要过度书面化。
不确定时保守处理
如果某个词无法确定是否识别错误，优先保留原文，不要强行猜测。
处理口语冗余
可以删除无意义的语气词、停顿词和重复词，例如“嗯”“啊”“那个”“就是”“然后然后”等，但不要删除有实际语义的内容。
修正同音词和近音词
根据上下文修正明显不合理的词。例如：
“在带”可改为“再带”，“模型树”可改为“模型数”，“权限县”可改为“权限项”。
保留专业词汇
遇到技术词、产品名、模型名、英文缩写、接口名、路径、命令、端口、URL、IP 地址时，应尽量保持原样，不要擅自翻译或改写。例如：
ASR、TTS、LLM、CTC、CLAP、DASM、FastAPI、Electron、WebSocket、CUDA、NPU、GPU、Docker、uv、conda、127.0.0.1:8002。
处理中英混说和 code-switch
如果 ASR 将常见英文单词、技术词、品牌名、命令词或缩写识别成中文音译，应根据上下文转换为正确英文形式。
例如：
“哈喽”可改为“hello”；
“拜拜”可改为“bye”；
“欧喷 AI”可改为“OpenAI”；
“叉特 GPT”可改为“ChatGPT”；
“派森”可改为“Python”；
“贾瓦斯克瑞普特”可改为“JavaScript”；
“扣得”在编程上下文中可改为“code”；
“命令 line”可改为“command line”；
“GPU server”应保留为“GPU server”。

但不要强行把正常中文翻译成英文。只有当输入明显是英文音译、英文缩写或中英混说时，才进行转换。

规范数字和符号
可以将语音化数字转换为常见书面形式。例如：
“八零零二端口”改为“8002 端口”；
“一二七点零点零点一冒号八零零二”改为“127.0.0.1:8002”；
“二零二六年七月一号”改为“2026 年 7 月 1 日”。
问句和命令句要清晰
如果输入是问题，输出应保持为自然的问题句。
如果输入是命令，输出应保持为简洁明确的命令句。
不要把命令扩写成解释，不要把问题改成陈述。
代码、命令、路径谨慎处理
不要润色代码、命令、文件路径和参数。只有在明显是 ASR 识别错误时，才进行修正。例如：
“CUDA visible devices 等于七”可以改为“CUDA_VISIBLE_DEVICES=7”。
输出要求
只输出润色后的最终文本。不要输出解释、原因、编号、引号、Markdown、JSON 或任何额外说明。

输入文本：
`,
  summaryPrompt: `你是一个专业的语音工作流总结助手。你的任务是根据用户选择的一个时间段内的 ASR 文本记录，对这段语音内容进行结构化总结。

输入是一组 ASR 记录，每条记录可能包含以下字段：

text：原始 ASR 文本
ai：经过 ASR 后处理润色后的文本
real_time_start：该条语音开始时间
real_time_end：该条语音结束时间

请优先使用 ai 字段作为内容来源；如果 ai 为空、缺失或明显异常，则回退使用 text 字段。时间字段用于排序、合并和标注，不要忽略。

你的目标不是逐条复述，而是把这段时间内用户说过的内容，按“事情”整理清楚。

处理规则：

按时间顺序理解全部内容
先按照 real_time_start 从早到晚排序，再理解语义。不要只看单条文本，要结合前后语音判断用户在讨论的同一件事。
合并同类事项
如果多条语音都在说同一个问题、同一个任务、同一个项目或同一个 bug，应合并成一个事项，不要重复列出。
合并时保留关键时间范围，例如“22:12–22:18”。
按事情类别归纳
请根据内容自动归类。常见类别包括但不限于：
Bug / 问题修复
功能需求
调试排查
代码修改
模型 / 算法
数据 / 文件 / 路径
部署 / 服务 / 端口
实验结果
决策结论
待确认问题
其他

如果类别不明确，可以使用“其他”或根据内容创建更合适的类别。

区分 Todo、Done、Doing、Blocked
请根据语义判断每个事项的状态：
Todo：用户明确提出要做、要修复、要检查、要增加、要优化、需要处理的事情。
Done：用户明确表示已经完成、已经修好、已经验证、已经解决的事情。
Doing：用户正在排查、正在修改、正在验证，但没有明确完成。
Blocked：用户提到仍然不行、仍然报错、没有生效、缺少信息、被权限/环境/网络/接口阻塞。
Unknown：无法判断状态时使用。

不要把没有明确完成的事情标成 Done。
“仍然”“还是”“没有”“不行”“报错”“失败”“没记录”“没生效”通常表示问题未解决，应归入 Todo、Doing 或 Blocked。

提取行动项
从语音中提取可执行的待办事项。待办事项应具体、可操作，避免空泛描述。
例如：
不要写：“处理日志问题”
应写：“检查后端日志为什么没有记录 AI 润色后的 ASR 结果”
提取已完成事项
只记录用户明确表达已经完成或已经验证通过的内容。不要根据上下文猜测完成。
提取问题与风险
如果用户提到异常、失败、没生效、日志缺失、接口不通、结果不符合预期、模型效果不好等，应单独列为“问题与风险”。
提取决策和结论
如果用户明确做出了选择、确定了方案、排除了某个原因、确认了某个结论，应单独列为“决策 / 结论”。
保持事实准确
不要编造用户没有说过的事项、原因、结论、完成状态或技术细节。
如果只能推断，请使用“可能”“疑似”“需要确认”等表述。
保留关键技术词
保留 ASR、LLM、TTS、GPU、NPU、CUDA、Docker、FastAPI、Electron、WebSocket、端口号、路径、模型名、接口名、命令参数等技术词，不要随意翻译或改写。
输出语言
使用中文输出。技术词、变量名、接口名、路径、命令保持原样。

输出格式如下：

语音时间段总结
1. 总体概览

用 3 到 6 条 bullet 总结这段时间主要在讨论什么、推进了什么、卡在哪里。

2. 按事情类别整理
类别：<类别名称>
事项：<事项名称>
时间：<开始时间> ~ <结束时间>
状态：Todo / Done / Doing / Blocked / Unknown
摘要：<用 1 到 3 句话说明这件事>
关键信息：<关键日志、现象、路径、模型名、端口、接口名等；没有则写“无”>
下一步：<如果有明确待办，写具体动作；没有则写“无明确下一步”>

如果有多个类别，按重要性和时间顺序排列。

3. 时间线

按时间顺序列出关键事件，不要逐条复述无意义语音。

格式：

<时间>：<发生了什么 / 用户提出了什么 / 确认了什么>
4. Todo 待办

只列出需要继续处理的事项。

格式：

<具体待办事项>

来源时间：<时间>
优先级：高 / 中 / 低
说明：<为什么需要做>
5. Done 已完成

只列出明确完成的事项。

格式：

<已完成事项>

完成时间：<时间>
说明：<完成依据>

如果没有明确完成事项，写“暂无明确 Done 事项”。

6. 问题与风险

列出仍然存在的问题、异常、阻塞点和不确定点。

格式：

问题：<问题描述>
时间：<时间>
影响：<可能影响什么>
建议下一步：<建议如何排查或处理>
7. 决策 / 结论

列出用户明确确认的结论、方案选择或判断。

如果没有明确决策，写“暂无明确决策”。

输入数据：`,
  llmAutoPolish: false,
  llmAutoTranslate: false,
  translationProvider: 'deepseek',
  translationBaseUrl: 'https://api.deepseek.com',
  translationModel: '',
  translationApiToken: '',
  passiveSummaryEnabled: false,
  passiveSummaryFrequencyMin: 60,
  passiveSummaryUserId: 'dsm',
  passiveSummaryCategory: '实时转录',
  passiveSummaryStartTime: '00:00',
  passiveSummaryEndTime: new Date().toTimeString().slice(0, 5),
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
  autoLaunchEnabled: false,
  keepRunningInBackground: false
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
  if (!merged.offlineEngine?.trim()) merged.offlineEngine = DEFAULT_SETTINGS.offlineEngine
  if (!merged.streamingEngine?.trim()) merged.streamingEngine = DEFAULT_SETTINGS.streamingEngine
  const rawConfigs = merged.asrModelConfigs && typeof merged.asrModelConfigs === 'object' ? merged.asrModelConfigs : {}
  const configuredEngines = Array.from(new Set([
    ...Object.keys(DEFAULT_SETTINGS.asrModelConfigs),
    ...Object.keys(rawConfigs),
  ]))
  merged.asrModelConfigs = Object.fromEntries(configuredEngines.map((engine) => {
    const fallback = DEFAULT_SETTINGS.asrModelConfigs[engine] || {
      modelName: engine,
      device: 'cuda',
      computeType: '',
      extraJson: '{}',
    }
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
  merged.keepRunningInBackground = typeof merged.keepRunningInBackground === 'boolean' ? merged.keepRunningInBackground : false
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
  merged.summaryPrompt = typeof merged.summaryPrompt === 'string' && merged.summaryPrompt.trim()
    ? merged.summaryPrompt
    : DEFAULT_SETTINGS.summaryPrompt
  merged.passiveSummaryFrequencyMin = Math.min(1440, Math.max(5, Number(merged.passiveSummaryFrequencyMin) || 60))
  merged.passiveSummaryUserId = merged.passiveSummaryUserId ?? 'dsm'
  merged.passiveSummaryCategory = ['', '一段语音转写', '实时转录'].includes(merged.passiveSummaryCategory)
    ? merged.passiveSummaryCategory
    : '实时转录'
  merged.passiveSummaryStartTime = merged.passiveSummaryStartTime || '00:00'
  merged.passiveSummaryEndTime = merged.passiveSummaryEndTime || new Date().toTimeString().slice(0, 5)
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
      version: 35,
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
        if (version < 34 && settings.llmAutoTranslate && !settings.llmAutoPolish) {
          settings.llmProvider = settings.translationProvider || settings.llmProvider
          settings.llmBaseUrl = settings.translationBaseUrl || settings.llmBaseUrl
          settings.llmModel = settings.translationModel || settings.llmModel
          settings.llmApiToken = settings.translationApiToken || settings.llmApiToken
          settings.llmPolishPrompt = `请把以下语音识别结果翻译成${settings.llmTargetLanguage || 'English'}，保持原意和语气，只返回译文。`
          settings.llmAutoPolish = true
          settings.llmAutoTranslate = false
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
