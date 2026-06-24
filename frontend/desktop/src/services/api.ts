export type Segment = {
  start: number
  end: number
  text: string
  confidence?: number | null
}

export type LLMOperation = 'polish' | 'translate'

export type LLMTextResult = {
  operation: LLMOperation
  text: string
  model: string
  elapsed_sec?: number | null
}

export type LLMChatRole = 'system' | 'user' | 'assistant'

export type LLMChatTextPart = {
  type: 'text'
  text: string
}

export type LLMChatImagePart = {
  type: 'image_url'
  image_url: {
    url: string
  }
}

export type LLMChatContent = string | Array<LLMChatTextPart | LLMChatImagePart>

export type LLMChatMessage = {
  role: LLMChatRole
  content: LLMChatContent
}

export type LLMChatRequest = {
  messages: LLMChatMessage[]
  model: string
  base_url: string
  api_token: string
  provider?: string
  temperature?: number
}

export type LLMChatResult = {
  message: LLMChatMessage
  model: string
  provider?: string | null
  elapsed_sec?: number | null
}

export type LLMChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: LLMChatResult }
  | { type: 'error'; message: string }

export type LLMSpeechRequest = {
  text: string
  model: string
  voice: string
  base_url: string
  api_token: string
  provider?: string
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
  speed?: number
}

export type HiggsTTSRequest = {
  text: string
  higgs_base_url: string
  provider?: 'local' | 'boson'
  api_token?: string
  model?: string
  voice?: string
  response_format?: 'wav' | 'mp3' | 'flac' | 'opus' | 'aac' | 'pcm'
  speed?: number
  temperature?: number
  top_p?: number
  top_k?: number
  seed?: number
  max_new_tokens?: number
  reference_audio?: string
  reference_url?: string
  reference_text?: string
  reference_codes_json?: string
  emotion?: string
  style?: string
  prosody_speed?: string
  pitch?: string
  expressiveness?: string
  initial_codec_chunk_frames?: number
  stream?: boolean
}

export type HiggsTiming = {
  asr_sec: number
  tts_sec: number
  total_sec: number
  higgs_network_sec: number
  client_total_sec?: number
}

export type HiggsAudioResult = {
  audio: Blob
  timing: HiggsTiming
  text?: string
  asr_engine?: string
  language?: string
  confidence?: number | null
  sample_rate?: string
}

export type HiggsHealthResult = {
  connected: boolean
  base_url: string
  elapsed_sec: number
  data?: unknown
  message?: string
}

export type HiggsVoicesResult = {
  voices: string[]
  presets?: HiggsVoicePreset[]
  raw?: unknown
  message?: string
}

export type HiggsVoicePreset = {
  id?: string
  name: string
  higgs_base_url?: string
  reference_audio?: string
  reference_audio_path?: string
  reference_audio_name?: string
  reference_url?: string
  reference_text?: string
  reference_codes_json?: string
  created_at?: string
  updated_at?: string
}

export type HiggsVoicePresetRequest = {
  name: string
  higgs_base_url: string
  reference_audio?: string
  reference_url?: string
  reference_text?: string
  reference_codes_json?: string
}

export type HiggsVoicePresetsResult = {
  presets: HiggsVoicePreset[]
  voices: string[]
  path?: string
}

export type HiggsReferenceAsrResult = {
  text: string
  engine: string
  language?: string | null
  confidence?: number | null
  elapsed_sec?: number | null
}

// ── AgentCore types ─────────────────────────────────────────────────────

export type AgentChatRequest = {
  text: string
  session_id?: string
  persona?: string
  memory?: string
  llm_base_url?: string
  llm_api_token?: string
  llm_model?: string
  llm_provider?: string
  use_skills?: boolean
  use_emotions?: boolean
  use_context?: boolean
  context?: Record<string, string>
}

export type AgentChatResponse = {
  text: string
  emotion: string
  action: string
  tool_calls: Array<{ name: string; args: Record<string, string> }>
  tool_results: string[]
  error: string | null
  elapsed_sec: number
  session_id: string
}

export type AgentStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'state'; emotion: string; action: string }
  | { type: 'tool'; name: string; result: string }
  | { type: 'done'; turn: AgentChatResponse }
  | { type: 'error'; message: string }

export type AgentContextResponse = {
  session_id: string
  turn_count: number
  message_count: number
  task_count: number
  open_tasks: Array<{ id: string; text: string }>
  memory: string
  emotion: string
  action: string
}

// ── Delegate types ───────────────────────────────────────────────────────

export type AgentDelegateRequest = {
  agent?: 'codex' | 'claude' | 'claudecode'
  prompt: string
  cwd?: string
  model?: string
  sandbox?: 'read-only' | 'workspace-write'
  timeout_sec?: number
}

export type AgentDelegateResult = {
  agent: 'codex' | 'claude' | 'claudecode'
  cwd: string
  command: string[]
  exit_code: number | null
  timed_out: boolean
  stdout: string
  stderr: string
  final_message: string
  elapsed_sec: number
}

export type SkillParameter = {
  name: string
  type: string
  description: string
  required: boolean
  default?: unknown
}

export type SkillDefinition = {
  name: string
  description: string
  parameters: SkillParameter[]
  category: string
}

export type SkillListResponse = {
  skills: SkillDefinition[]
  total: number
}

export type SkillExecuteRequest = {
  skill: string
  parameters: Record<string, unknown>
}

export type SkillExecuteResult = {
  skill: string
  success: boolean
  output: string
  error: string | null
  metadata: Record<string, unknown>
}

export type LLMModelsRequest = {
  base_url: string
  api_token: string
  provider?: string
}

export type LLMModelsResult = {
  connected: boolean
  models: string[]
  provider?: string | null
  base_url: string
  status_code?: number | null
  message?: string | null
  elapsed_sec?: number | null
}

export type ArchiveSummaryRequest = {
  date: string
  user_id?: string
  category?: string
  start_time?: string
  end_time?: string
  provider?: string
  model: string
  base_url: string
  api_token: string
  style?: string
  max_input_chars?: number
}

export type ArchiveSummaryResult = {
  summary: string
  model: string
  provider?: string | null
  elapsed_sec?: number | null
  source_count: number
  input_chars: number
  estimated_input_tokens: number
  chunk_count: number
  truncated: boolean
  date: string
  time_range?: string | null
}

export type ArchiveSummarySaveRequest = {
  summary: ArchiveSummaryResult
  user_id?: string
  category?: string
}

export type ArchiveSummarySaveResult = {
  saved: boolean
  path: string
}

export type LLMOutputs = {
  polish?: LLMTextResult | null
  translate?: LLMTextResult | null
}

export type TranscribeResponse = {
  task_id: string
  status: string
  full_text: string
  segments: Segment[]
  language: string | null
  engine_used: string
  confidence: number | null
  duration_sec: number | null
  elapsed_sec: number | null
  timing?: Record<string, unknown> | null
  client_timing?: Record<string, unknown> | null
  llm_outputs?: LLMOutputs | null
  llm_error?: string | null
  audio_url?: string
  archived_audio?: string
}

export type AsyncResponse = {
  task_id: string
  status: string
  message: string
  timing?: Record<string, unknown> | null
}

export type ModelInfo = {
  engine: string
  model_name: string
  is_loaded: boolean
  device: string | null
  compute_type: string | null
  languages: string[]
  extra: Record<string, unknown>
}

export type ModelsListResponse = {
  engines: ModelInfo[]
  default_engine?: string
}

export type HotwordConfig = {
  enabled: boolean
  rule_enabled: boolean
  threshold: number
  similar_threshold: number
  hotwords: string
  rules: string
  hotword_count: number
  rule_count: number
  path?: string
}

export type TranscribeOptions = {
  engine: string
  timeout_sec?: number
  language?: string
  whisper_model?: string
  whisper_task?: 'transcribe' | 'translate'
  enable_punctuation?: boolean
  enable_hotwords?: boolean
  allow_server_data_collection?: boolean
  archive_dir?: string
  user_id?: string
  llm?: {
    enable_polish?: boolean
    enable_translate?: boolean
    target_language?: string
    provider?: string
    model?: string
    base_url?: string
    api_token?: string
    style?: string
  }
}

export type LLMProcessRequest = {
  text: string
  operation: LLMOperation
  model: string
  base_url: string
  api_token: string
  provider?: string
  target_language?: string
  style?: string
}

const DEFAULT_SERVER = 'http://localhost:8000'

function normalizeServerUrl(url: string) {
  // empty / '' / '/' → empty string. We intentionally do NOT fall back to
  // localhost:8000 anymore: the user must explicitly set and confirm a
  // backend address before any communication happens (Req: 未设置不通信).
  // In dev, same-origin requests are proxied by Vite, so '' is valid there.
  const trimmed = (url || '').trim()
  if (!trimmed || trimmed === '/') {
    // No backend configured. Return '' so callers can guard and refuse to
    // communicate. (In dev, '' resolves to same-origin via the Vite proxy.)
    return ''
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/** Whether a backend address has been configured and confirmed by the user. */
export function hasConfiguredServer(url: string): boolean {
  const normalized = normalizeServerUrl(url)
  return Boolean(normalized)
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message = data?.detail || data?.message || response.statusText
    throw new Error(message)
  }
  return data as T
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

export function describeRequestError(error: unknown, fallback: string) {
  if (error instanceof DOMException && error.name === 'TimeoutError') return error.message || '请求超时'
  if (error instanceof Error && error.name === 'TimeoutError') return error.message || '请求超时'
  if (isAbortError(error)) return '请求已取消'
  return error instanceof Error && error.message ? error.message : fallback
}

function headerNumber(headers: Headers, name: string) {
  const value = Number(headers.get(name) || 0)
  return Number.isFinite(value) ? value : 0
}

function decodeBase64Utf8(value: string | null) {
  if (!value) return ''
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

async function parseAudioResponse(response: Response, clientStartedAt: number): Promise<HiggsAudioResult> {
  if (!response.ok) {
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    throw new Error(data?.detail || data?.message || response.statusText)
  }
  const audio = await response.blob()
  const timing: HiggsTiming = {
    asr_sec: headerNumber(response.headers, 'x-timing-asr'),
    tts_sec: headerNumber(response.headers, 'x-timing-tts'),
    total_sec: headerNumber(response.headers, 'x-timing-total'),
    higgs_network_sec: headerNumber(response.headers, 'x-timing-higgs-network'),
    client_total_sec: (performance.now() - clientStartedAt) / 1000
  }
  const confidenceHeader = response.headers.get('x-asr-confidence')
  const confidence = confidenceHeader ? Number(confidenceHeader) : null
  return {
    audio,
    timing,
    text: decodeBase64Utf8(response.headers.get('x-asr-text-b64')),
    asr_engine: response.headers.get('x-asr-engine') || undefined,
    language: response.headers.get('x-asr-language') || undefined,
    confidence: Number.isFinite(confidence) ? confidence : null,
    sample_rate: response.headers.get('x-higgs-sample-rate') || undefined
  }
}

export class ASRApi {
  constructor(private readonly serverUrl = DEFAULT_SERVER) {}

  private url(path: string) {
    return `${normalizeServerUrl(this.serverUrl)}${path}`
  }

  private describeBackendTarget(path: string) {
    const baseUrl = normalizeServerUrl(this.serverUrl)
    return baseUrl ? `${baseUrl}${path}` : `${window.location.origin || '当前页面' }${path}`
  }

  health() {
    return fetch(this.url('/v1/health')).then((res) => parseResponse<{ status: string; uptime_sec: number }>(res))
  }

  async models(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 20_000
    const relayAbort = () => controller.abort(
      options.signal?.reason || new DOMException('模型列表刷新已取消', 'AbortError')
    )
    if (options.signal?.aborted) relayAbort()
    else options.signal?.addEventListener('abort', relayAbort, { once: true })
    const timer = window.setTimeout(() => controller.abort(
      new DOMException(`模型列表请求超过 ${Math.round(timeoutMs / 1000)} 秒，请检查后端状态`, 'TimeoutError')
    ), timeoutMs)
    try {
      const response = await fetch(this.url('/v1/models'), { signal: controller.signal })
      const data = await parseResponse<ModelInfo[] | ModelsListResponse>(response)
      return Array.isArray(data) ? data : data.engines || []
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason
      }
      throw error
    } finally {
      window.clearTimeout(timer)
      options.signal?.removeEventListener('abort', relayAbort)
    }
  }

  loadModel(engine: string, payload: Record<string, unknown>) {
    return fetch(this.url(`/v1/models/${encodeURIComponent(engine)}/load`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<ModelInfo | { ok: boolean }>(res))
  }

  unloadModel(engine: string) {
    return fetch(this.url(`/v1/models/${encodeURIComponent(engine)}/unload`), { method: 'POST' }).then((res) =>
      parseResponse<ModelInfo | { ok: boolean }>(res)
    )
  }

  hotwords() {
    return fetch(this.url('/v1/hotwords')).then((res) => parseResponse<HotwordConfig>(res))
  }

  saveHotwords(payload: Omit<HotwordConfig, 'hotword_count' | 'rule_count' | 'path'>) {
    return fetch(this.url('/v1/hotwords'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<HotwordConfig>(res))
  }

  previewHotwords(text: string) {
    return fetch(this.url('/v1/hotwords/preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then((res) => parseResponse<{ text: string; replacements: unknown[]; suggestions: unknown[] }>(res))
  }

  async transcribe(file: Blob, filename: string, options: TranscribeOptions, request: { signal?: AbortSignal } = {}) {
    const form = new FormData()
    form.append('file', file, filename)
    form.append('options', JSON.stringify(options))
    try {
      const response = await fetch(this.url('/v1/transcribe'), { method: 'POST', body: form, signal: request.signal })
      return await parseResponse<TranscribeResponse | AsyncResponse>(response)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (error instanceof TypeError) {
        throw new Error(
          `无法连接 ASR 后端 (${this.describeBackendTarget('/v1/transcribe')})：${error.message}。`
          + '请检查后端服务、后端地址、HTTPS/HTTP 混合内容和 CORS 配置。'
        )
      }
      throw error
    }
  }

  task(taskId: string, signal?: AbortSignal) {
    return fetch(this.url(`/v1/tasks/${encodeURIComponent(taskId)}`), { signal })
      .then((res) => parseResponse<TranscribeResponse & { id?: string }>(res))
      .then((data) => ({
        ...data,
        task_id: data.task_id || data.id || taskId,
        full_text: data.full_text || '',
        segments: data.segments || [],
        engine_used: data.engine_used || ''
      }))
  }

  tasks(limit = 50, offset = 0) {
    return fetch(this.url(`/v1/tasks?limit=${limit}&offset=${offset}`)).then((res) => parseResponse<TranscribeResponse[]>(res))
  }

  cancelTask(taskId: string) {
    return fetch(this.url(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`), { method: 'POST' }).then((res) =>
      parseResponse<{ ok: boolean }>(res)
    )
  }

  processText(payload: LLMProcessRequest) {
    return fetch(this.url('/v1/llm/process'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<LLMTextResult>(res))
  }

  chat(payload: LLMChatRequest) {
    return fetch(this.url('/v1/llm/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<LLMChatResult>(res))
  }

  async streamChat(payload: LLMChatRequest, onEvent: (event: LLMChatStreamEvent) => void, signal?: AbortSignal) {
    const response = await fetch(this.url('/v1/llm/chat/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    if (!response.ok) {
      const text = await response.text()
      const data = text ? JSON.parse(text) : null
      throw new Error(data?.detail || data?.message || response.statusText)
    }
    if (!response.body) throw new Error('当前运行环境不支持流式响应')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult: LLMChatResult | null = null

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const event = line.trim() ? JSON.parse(line) as LLMChatStreamEvent : null
        if (!event) continue
        onEvent(event)
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'done') finalResult = event.result
      }
    }

    const tail = buffer.trim()
    if (tail) {
      const event = JSON.parse(tail) as LLMChatStreamEvent
      onEvent(event)
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'done') finalResult = event.result
    }
    if (!finalResult) throw new Error('流式回复缺少完成事件')
    return finalResult
  }

  listLLMModels(payload: LLMModelsRequest) {
    return fetch(this.url('/v1/llm/models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<LLMModelsResult>(res))
  }

  async synthesizeSpeech(payload: LLMSpeechRequest) {
    const response = await fetch(this.url('/v1/llm/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) {
      const text = await response.text()
      const data = text ? JSON.parse(text) : null
      throw new Error(data?.detail || data?.message || response.statusText)
    }
    return response.blob()
  }

  delegateAgent(payload: AgentDelegateRequest) {
    return fetch(this.url('/v1/agents/delegate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<AgentDelegateResult>(res))
  }

  listSkills(category?: string) {
    const query = category ? `?category=${encodeURIComponent(category)}` : ''
    return fetch(this.url(`/v1/skills${query}`)).then((res) => parseResponse<SkillListResponse>(res))
  }

  executeSkill(payload: SkillExecuteRequest) {
    return fetch(this.url('/v1/skills/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<SkillExecuteResult>(res))
  }

  // ── AgentCore API ──────────────────────────────────────────────────────

  agentChat(payload: AgentChatRequest) {
    return fetch(this.url('/v1/agent/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<AgentChatResponse>(res))
  }

  async agentChatStream(payload: AgentChatRequest, onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal) {
    const response = await fetch(this.url('/v1/agent/chat/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    if (!response.ok) {
      const text = await response.text()
      const data = text ? JSON.parse(text) : null
      throw new Error(data?.detail || data?.message || response.statusText)
    }
    if (!response.body) throw new Error('Streaming not supported')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as AgentStreamEvent
          onEvent(event)
          if (event.type === 'error') throw new Error(event.message)
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
    if (buffer.trim()) {
      try { onEvent(JSON.parse(buffer)) } catch { /* ignore tail */ }
    }
  }

  agentContext(sessionId: string = 'default') {
    return fetch(this.url(`/v1/agent/context?session_id=${encodeURIComponent(sessionId)}`))
      .then((res) => parseResponse<AgentContextResponse>(res))
  }

  agentReset(sessionId: string = 'default') {
    return fetch(this.url(`/v1/agent/reset?session_id=${encodeURIComponent(sessionId)}`), { method: 'POST' })
      .then((res) => parseResponse<{ ok: boolean }>(res))
  }

  summarizeArchive(payload: ArchiveSummaryRequest) {
    return fetch(this.url('/v1/llm/archive-summary'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<ArchiveSummaryResult>(res))
  }

  saveArchiveSummary(payload: ArchiveSummarySaveRequest) {
    return fetch(this.url('/v1/llm/archive-summary/save'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<ArchiveSummarySaveResult>(res))
  }

  // ── GPT-SoVITS TTS ──────────────────────────────────────────────────────

  async ttsSpeak(text: string, textLang: string = 'zh', speed: number = 1.0, engine: string = 'gpt_sovits'): Promise<Blob> {
    const response = await fetch(this.url('/v1/tts/speak'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, text_lang: textLang, speed, engine }),
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(err ? JSON.parse(err).detail || err : `TTS failed: ${response.status}`)
    }
    return response.blob()
  }

  higgsHealth(higgsBaseUrl: string) {
    const query = new URLSearchParams({ higgs_base_url: higgsBaseUrl }).toString()
    return fetch(this.url(`/v1/tts/higgs/health?${query}`)).then((res) => parseResponse<HiggsHealthResult>(res))
  }

  higgsConnection(payload: { provider: 'local' | 'boson'; base_url: string; api_token?: string }) {
    return fetch(this.url('/v1/tts/higgs/connection'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<HiggsHealthResult>(res))
  }

  higgsVoices(higgsBaseUrl: string) {
    const query = new URLSearchParams({ higgs_base_url: higgsBaseUrl }).toString()
    return fetch(this.url(`/v1/tts/higgs/voices?${query}`)).then((res) => parseResponse<HiggsVoicesResult>(res))
  }

  higgsVoicePresets() {
    return fetch(this.url('/v1/tts/higgs/voice-presets')).then((res) => parseResponse<HiggsVoicePresetsResult>(res))
  }

  saveHiggsVoicePreset(payload: HiggsVoicePresetRequest) {
    return fetch(this.url('/v1/tts/higgs/voice-presets'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<HiggsVoicePresetsResult & { preset: HiggsVoicePreset }>(res))
  }

  referenceAudioAsr(audioBlob: Blob, engine = 'sensevoice', language = 'zh') {
    const form = new FormData()
    form.append('audio', audioBlob, 'reference_audio.wav')
    form.append('engine', engine)
    form.append('language', language)
    const path = '/v1/tts/higgs/reference-asr'
    const target = this.url(path)
    return fetch(target, {
      method: 'POST',
      body: form,
    })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`参考音频 ASR 请求失败：${detail}。请求地址：${this.describeBackendTarget(path)}。请确认后端已启动、后端地址配置正确，公网访问时后端 CORS 已允许当前前端来源。`)
      })
      .then((res) => parseResponse<HiggsReferenceAsrResult>(res))
  }

  async higgsSpeak(payload: HiggsTTSRequest): Promise<HiggsAudioResult> {
    const startedAt = performance.now()
    const response = await fetch(this.url('/v1/tts/higgs/speak'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return parseAudioResponse(response, startedAt)
  }

  async higgsAudioToSpeech(audioBlob: Blob, payload: Omit<HiggsTTSRequest, 'text'> & { engine?: string; language?: string }): Promise<HiggsAudioResult> {
    const startedAt = performance.now()
    const form = new FormData()
    form.append('audio', audioBlob, 'voice_input.webm')
    form.append('higgs_base_url', payload.higgs_base_url)
    form.append('provider', payload.provider || 'local')
    form.append('api_token', payload.api_token || '')
    form.append('model', payload.model || 'higgs-audio-v3-tts')
    form.append('voice', payload.voice || 'Elysia')
    form.append('response_format', payload.response_format || 'wav')
    form.append('speed', String(payload.speed ?? 1))
    form.append('temperature', String(payload.temperature ?? 0.7))
    form.append('top_p', String(payload.top_p ?? 0.95))
    form.append('top_k', String(payload.top_k ?? 50))
    form.append('seed', String(payload.seed ?? -1))
    form.append('max_new_tokens', String(payload.max_new_tokens ?? 2048))
    form.append('reference_audio', payload.reference_audio || '')
    form.append('reference_url', payload.reference_url || '')
    form.append('reference_text', payload.reference_text || '')
    form.append('reference_codes_json', payload.reference_codes_json || '')
    form.append('emotion', payload.emotion || '')
    form.append('style', payload.style || '')
    form.append('prosody_speed', payload.prosody_speed || '')
    form.append('pitch', payload.pitch || '')
    form.append('expressiveness', payload.expressiveness || '')
    form.append('initial_codec_chunk_frames', String(payload.initial_codec_chunk_frames ?? 1))
    form.append('engine', payload.engine || 'fireredasr2')
    form.append('language', payload.language || 'zh')
    const response = await fetch(this.url('/v1/tts/higgs/audio-to-speech'), {
      method: 'POST',
      body: form,
    })
    return parseAudioResponse(response, startedAt)
  }

  async ttsPipeline(audioBlob: Blob, task: string = '', agent: string = ''): Promise<Blob> {
    const form = new FormData()
    form.append('audio', audioBlob, 'voice_input.wav')
    form.append('task', task)
    form.append('agent', agent)
    const response = await fetch(this.url('/v1/tts/pipeline'), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(err ? JSON.parse(err).detail || err : `Pipeline failed: ${response.status}`)
    }
    return response.blob()
  }

  // ── Voice Conversion ────────────────────────────────────────────────────

  async listVoices(): Promise<{ voices: Array<{ id: string; name: string; description: string; prompt_lang: string }> }> {
    return fetch(this.url('/v1/voice/voices')).then((res) => parseResponse<any>(res))
  }

  async convertVoice(audioBlob: Blob, voiceId: string = 'elysia', speed: number = 1.0): Promise<Blob> {
    const form = new FormData()
    form.append('audio', audioBlob, 'input.wav')
    form.append('voice_id', voiceId)
    form.append('speed', String(speed))
    const response = await fetch(this.url('/v1/voice/convert'), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(err ? JSON.parse(err).detail || err : `Voice convert failed: ${response.status}`)
    }
    return response.blob()
  }
}

export function isAsyncResponse(value: TranscribeResponse | AsyncResponse): value is AsyncResponse {
  return typeof (value as AsyncResponse).message === 'string'
}
