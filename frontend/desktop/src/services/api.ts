export type Segment = {
  start: number
  end: number
  text: string
  speaker?: string | null
  confidence?: number | null
}

export type EngineResult = {
  engine: string
  full_text: string
  segments?: Segment[]
  confidence?: number | null
  elapsed_sec?: number | null
  error?: string | null
}

export type LLMOperation = 'polish' | 'translate'

export type LLMTextResult = {
  operation: LLMOperation
  text: string
  model: string
  elapsed_sec?: number | null
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
  engine_results?: EngineResult[] | null
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

export type TranscribeOptions = {
  engines: string[]
  language?: string
  whisper_model?: string
  whisper_task?: 'transcribe' | 'translate'
  enable_punctuation?: boolean
  enable_diarize?: boolean
  merge_strategy?: 'first' | 'vote' | 'concat'
  allow_server_data_collection?: boolean
  archive_dir?: string
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

const DEFAULT_SERVER = 'http://112.124.13.120:18000'

function normalizeServerUrl(url: string) {
  return (url || DEFAULT_SERVER).replace(/\/+$/, '')
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

function withTimeout(ms: number) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  return { controller, timer }
}

export class ASRApi {
  constructor(private readonly serverUrl = DEFAULT_SERVER) {}

  private url(path: string) {
    return `${normalizeServerUrl(this.serverUrl)}${path}`
  }

  health() {
    return fetch(this.url('/v1/health')).then((res) => parseResponse<{ status: string; uptime_sec: number }>(res))
  }

  models() {
    const { controller, timer } = withTimeout(8000)
    return fetch(this.url('/v1/models'), { signal: controller.signal })
      .then((res) => parseResponse<ModelInfo[] | ModelsListResponse>(res))
      .then((data) => (Array.isArray(data) ? data : data.engines || []))
      .finally(() => window.clearTimeout(timer))
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

  transcribe(file: Blob, filename: string, options: TranscribeOptions) {
    const form = new FormData()
    form.append('file', file, filename)
    form.append('options', JSON.stringify(options))
    return fetch(this.url('/v1/transcribe'), { method: 'POST', body: form }).then((res) =>
      parseResponse<TranscribeResponse | AsyncResponse>(res)
    )
  }

  task(taskId: string) {
    return fetch(this.url(`/v1/tasks/${encodeURIComponent(taskId)}`))
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

  listLLMModels(payload: LLMModelsRequest) {
    return fetch(this.url('/v1/llm/models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => parseResponse<LLMModelsResult>(res))
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
}

export function isAsyncResponse(value: TranscribeResponse | AsyncResponse): value is AsyncResponse {
  return typeof (value as AsyncResponse).message === 'string'
}
