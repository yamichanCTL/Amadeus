
export type CodexTokens = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  total_tokens: number
}
export type CodexReply = {
  call_id: string
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  text: string
  model: string
  usage: CodexTokens | null
  elapsed_sec: number
  error?: string
}
export type CodexCatalog = {
  configured_model: string | null
  configured_effort: string | null
  provider: string
  models: Array<{ id: string; name: string; efforts: string[]; default_effort: string }>
}
export type CodexAccounting = CodexTokens & { calls: number; missing_usage: number; complete: boolean }
export type CodexOptions = {
  session_id: string
  model?: string
  effort?: string
  context?: string
  timeout_sec?: number
}
export type CodexVoiceEvent = {
  type: string
  text?: string
  message?: string
  call_id?: string
  source_job_id?: string | number
  job_id?: string | number
  result?: CodexReply
}

export async function codexRequest<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  if (!base.trim()) throw new Error('请先在设置中确认后端地址。')
  const response = await fetch(`${base.replace(/\/$/, '')}/v1/agents/codex${path}`, init)
  const body = await response.json()
  if (!response.ok) {
    const detail = body.detail
    throw new Error(typeof detail === 'string' ? detail : detail?.message || `请求失败 (${response.status})`)
  }
  return body as T
}
