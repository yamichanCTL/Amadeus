export type TelemetryCategory = 'http' | 'websocket' | 'asr' | 'tts' | 'ui'

export type TelemetryEvent = {
  id: string
  timestamp: string
  category: TelemetryCategory
  operation: string
  durationMs?: number
  backendMs?: number
  status: 'ok' | 'error' | 'info'
  detail?: string
  traceId?: string
  traceName?: string
  stage?: string
  offsetMs?: number
}

export type TelemetryTrace = {
  id: string
  name: string
  category: TelemetryCategory
  startedAt: number
  lastAt: number
}

const MAX_EVENTS = 500
let events: TelemetryEvent[] = []
const listeners = new Set<() => void>()
let fetchInstalled = false

export function recordTelemetry(event: Omit<TelemetryEvent, 'id' | 'timestamp'>) {
  events = [{
    ...event,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString()
  }, ...events].slice(0, MAX_EVENTS)
  listeners.forEach((listener) => listener())
}

export function startTelemetryTrace(category: TelemetryCategory, name: string, detail?: string): TelemetryTrace {
  const now = performance.now()
  const trace = {
    id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    category,
    startedAt: now,
    lastAt: now,
  }
  recordTelemetry({
    category,
    operation: name,
    stage: '任务开始',
    durationMs: 0,
    offsetMs: 0,
    traceId: trace.id,
    traceName: name,
    status: 'info',
    detail,
  })
  return trace
}

export function recordTelemetryStage(
  trace: TelemetryTrace,
  stage: string,
  options: { durationMs?: number; backendMs?: number; status?: TelemetryEvent['status']; detail?: string; offsetMs?: number } = {},
) {
  const now = performance.now()
  const durationMs = options.durationMs ?? Math.max(0, now - trace.lastAt)
  const offsetMs = options.offsetMs ?? Math.max(0, now - trace.startedAt)
  trace.lastAt = now
  recordTelemetry({
    category: trace.category,
    operation: `${trace.name} / ${stage}`,
    stage,
    durationMs,
    backendMs: options.backendMs,
    offsetMs,
    traceId: trace.id,
    traceName: trace.name,
    status: options.status || 'ok',
    detail: options.detail,
  })
}

export function finishTelemetryTrace(trace: TelemetryTrace, detail?: string, status: TelemetryEvent['status'] = 'ok') {
  recordTelemetryStage(trace, status === 'error' ? '任务失败' : '任务完成', {
    status,
    detail,
  })
}

export function telemetrySnapshot() {
  return events
}

export function subscribeTelemetry(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearTelemetry() {
  events = []
  listeners.forEach((listener) => listener())
}

export function installFetchTelemetry() {
  if (fetchInstalled || typeof window === 'undefined') return
  fetchInstalled = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    let operation = url
    try { operation = new URL(url, window.location.href).pathname } catch { /* retain safe URL */ }
    try {
      const response = await originalFetch(input, init)
      const backendSeconds = Number(response.headers.get('x-process-time') || 0)
      recordTelemetry({
        category: 'http',
        operation: `${method.toUpperCase()} ${operation}`,
        durationMs: performance.now() - started,
        backendMs: Number.isFinite(backendSeconds) ? backendSeconds * 1000 : undefined,
        status: response.ok ? 'ok' : 'error',
        detail: `HTTP ${response.status}`
      })
      return response
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError'
      recordTelemetry({
        category: 'http',
        operation: `${method.toUpperCase()} ${operation}`,
        durationMs: performance.now() - started,
        status: cancelled ? 'info' : 'error',
        detail: cancelled ? '请求被后续刷新或页面卸载取消' : error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }
}
