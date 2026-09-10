
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


/** Read SSE incrementally, including UTF-8 characters split across network chunks. */
export async function streamCodexExplanation(
  base: string, body: object, signal: AbortSignal, onDelta: (text: string) => void,
): Promise<{ target: string; result: CodexReply }> {
  if (!base.trim()) throw new Error('请先在设置中确认后端地址。')
  const response = await fetch(`${base.replace(/\/$/, '')}/v1/agents/codex/explanations/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body), signal,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(typeof error.detail === 'string' ? error.detail : error.detail?.message || `请求失败 (${response.status})`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('后端未返回流式响应，请检查版本或连接。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const packet = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = packet.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const event = JSON.parse(data)
        if (event.type === 'agent.delta' && typeof event.text === 'string') onDelta(event.text)
        if (event.type === 'meeting.error') throw new Error(event.message || '解释失败')
        if (event.type === 'meeting.completed' && event.result) return { target: event.target, result: event.result }
      }
      if (buffer.length > 1000000) throw new Error('流式响应格式异常。')
      if (chunk.done) throw new Error('连接中断，解释尚未完成。')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
