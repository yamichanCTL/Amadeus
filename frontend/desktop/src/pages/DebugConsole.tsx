import { useCallback, useMemo, useSyncExternalStore, useState } from 'react'
import { clearTelemetry, subscribeTelemetry, telemetrySnapshot, type TelemetryCategory, type TelemetryEvent } from '@/services/telemetry'

const categories: Array<'all' | TelemetryCategory> = ['all', 'http', 'websocket', 'asr', 'tts', 'ui']

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

type TraceGroup = {
  id: string
  name: string
  category: TelemetryCategory
  stages: TelemetryEvent[]
  totalMs: number
  timestamp: number
  stageCount: number
  errorCount: number
}

export function DebugConsolePage() {
  const events = useSyncExternalStore(subscribeTelemetry, telemetrySnapshot, telemetrySnapshot)
  const [category, setCategory] = useState<'all' | TelemetryCategory>('all')
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set())
  const [showUntraced, setShowUntraced] = useState(false)

  const filtered = category === 'all' ? events : events.filter((event) => event.category === category)

  const durations = useMemo(() => filtered.map((event) => event.durationMs).filter((value): value is number => typeof value === 'number'), [filtered])

  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0

  const { traces, untraced } = useMemo(() => {
    const grouped = new Map<string, TelemetryEvent[]>()
    const orphans: TelemetryEvent[] = []
    for (const event of filtered) {
      if (event.traceId) {
        grouped.set(event.traceId, [...(grouped.get(event.traceId) || []), event])
      } else {
        orphans.push(event)
      }
    }
    const traceList: TraceGroup[] = Array.from(grouped.entries()).map(([id, traceEvents]) => {
      const stages = [...traceEvents].sort((a, b) => (a.offsetMs || 0) - (b.offsetMs || 0))
      return {
        id,
        name: stages[0]?.traceName || stages[0]?.operation || '任务',
        category: stages[0]?.category || 'ui',
        stages,
        totalMs: Math.max(1, ...stages.map((e) => e.offsetMs || 0)),
        timestamp: Math.max(...stages.map((e) => Date.parse(e.timestamp))),
        stageCount: stages.length,
        errorCount: stages.filter((e) => e.status === 'error').length,
      }
    }).sort((a, b) => b.timestamp - a.timestamp)
    // Sort orphans newest first
    orphans.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    return { traces: traceList, untraced: orphans }
  }, [events, filtered])

  const toggleTrace = useCallback((traceId: string) => {
    setExpandedTraces((prev) => {
      const next = new Set(prev)
      if (next.has(traceId)) next.delete(traceId)
      else next.add(traceId)
      return next
    })
  }, [])

  const exportEvents = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `asrapp-telemetry-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page debug-page">
      <section className="panel">
        <div className="section-head">
          <div>
            <h1>开发调试台</h1>
            <p>HTTP、WebSocket、ASR 首字/最终结果和 TTS 首包/总耗时实时汇总，最多保留 500 条。点击任务展开查看各阶段耗时。</p>
          </div>
          <div className="debug-actions">
            <button type="button" onClick={exportEvents} disabled={!events.length}>导出 JSON</button>
            <button type="button" onClick={clearTelemetry} disabled={!events.length}>清空</button>
          </div>
        </div>
        <div className="debug-summary-grid">
          <article><span>事件</span><strong>{filtered.length}</strong></article>
          <article><span>任务链路</span><strong>{traces.length}</strong></article>
          <article><span>平均延时</span><strong>{average.toFixed(1)} ms</strong></article>
          <article><span>P95 延时</span><strong>{percentile(durations, 0.95).toFixed(1)} ms</strong></article>
          <article><span>错误</span><strong>{filtered.filter((event) => event.status === 'error').length}</strong></article>
        </div>
        <div className="debug-filters">
          {categories.map((item) => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}
        </div>

        {/* Trace groups */}
        <div className="trace-list">
          {traces.map((trace) => {
            const expanded = expandedTraces.has(trace.id)
            return (
              <article className={`trace-card ${expanded ? 'expanded' : ''}`} key={trace.id}>
                <header onClick={() => toggleTrace(trace.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleTrace(trace.id) }}>
                  <span className={`trace-chevron ${expanded ? 'open' : ''}`}>{expanded ? '▼' : '▶'}</span>
                  <div className="trace-meta">
                    <strong>{trace.name}</strong>
                    <span>{trace.category} · {new Date(trace.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="trace-summary">
                    <span>{trace.stageCount} 阶段</span>
                    {trace.errorCount > 0 && <span className="trace-error-count">{trace.errorCount} 错误</span>}
                    <strong>{trace.totalMs.toFixed(1)} ms</strong>
                  </div>
                </header>
                {expanded && (
                  <div className="trace-detail">
                    <div className="trace-axis"><span>0</span><span>{(trace.totalMs / 2).toFixed(0)} ms</span><span>{trace.totalMs.toFixed(0)} ms</span></div>
                    <div className="trace-stages">
                      {trace.stages.map((stage) => {
                        const duration = stage.durationMs || 0
                        const offset = stage.offsetMs || 0
                        const left = Math.max(0, ((offset - duration) / trace.totalMs) * 100)
                        const width = Math.max(0.8, (duration / trace.totalMs) * 100)
                        return (
                          <div className="trace-stage" key={stage.id}>
                            <span>{stage.stage || stage.operation}</span>
                            <div><i className={stage.status} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} /></div>
                            <strong>{duration.toFixed(1)} ms</strong>
                            <small>{stage.detail || ''}</small>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </article>
            )
          })}
          {!traces.length && !untraced.length && <p className="empty">暂无事件。开始一次语音识别或实时 ASR→TTS 后将显示任务链路。</p>}
        </div>

        {/* Untraced events (e.g. periodic health checks) */}
        {untraced.length > 0 && (
          <section className="untraced-section">
            <header
              className="untraced-header"
              onClick={() => setShowUntraced((prev) => !prev)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowUntraced((prev) => !prev) }}
            >
              <span className={`trace-chevron ${showUntraced ? 'open' : ''}`}>{showUntraced ? '▼' : '▶'}</span>
              <strong>其他事件</strong>
              <span className="untraced-count">{untraced.length} 条</span>
            </header>
            {showUntraced && (
              <div className="debug-table">
                <div className="debug-row debug-head"><span>时间</span><span>类别</span><strong>操作</strong><span>端到端</span><span>后端</span><span>状态 / 详情</span></div>
                {untraced.map((event) => (
                  <article className={`debug-row ${event.status}`} key={event.id}>
                    <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                    <span>{event.category}</span>
                    <strong>{event.operation}</strong>
                    <span>{event.durationMs === undefined ? '—' : `${event.durationMs.toFixed(1)} ms`}</span>
                    <span>{event.backendMs === undefined ? '—' : `${event.backendMs.toFixed(1)} ms`}</span>
                    <span>{event.status} · {event.detail || '—'}</span>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </section>
    </div>
  )
}
