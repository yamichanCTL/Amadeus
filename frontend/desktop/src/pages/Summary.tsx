import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownContent } from '@/components/MarkdownContent'
import { PromptCardEditor } from '@/components/PromptCardEditor'
import { TaskModelSettings } from '@/components/TaskModelSettings'
import { ASRApi, type ArchiveSummaryResult } from '@/services/api'
import { copyText, saveText } from '@/services/export'
import { getProviderPreset } from '@/services/llmProviders'
import { loadLocalSummaryLogs, saveSummaryToLocalLog, summaryLogFilename } from '@/services/summaryLog'
import { buildLocalSummaryRecords } from '@/services/summaryRecords'
import { useASRStore } from '@/store/useASRStore'
import { resolveTaskLLM } from '@/services/taskModels'
import { useActivityTask } from '@/services/activity'
import './Summary.css'

function localDateValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

export function localTimeValue(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function defaultSummaryTimeRange(date = new Date()) {
  void date
  return { startTime: '00:00', endTime: '23:59' }
}

export const SUMMARY_CATEGORY_OPTIONS = [
  { value: '', label: 'Both / 所有类型' },
  { value: '一段语音转写', label: '离线识别' },
  { value: '实时转录', label: '实时识别' },
] as const

function formatStat(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : '0'
}

export function SummaryPage() {
  const settings = useASRStore((state) => state.settings)
  const history = useASRStore((state) => state.history)
  const workspace = useASRStore((state) => state.summaryWorkspace)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const updateWorkspace = useASRStore((state) => state.updateSummaryWorkspace)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const summaryModel = resolveTaskLLM(settings, 'summary')
  const providerPreset = getProviderPreset(summaryModel.provider)
  const { source, date, endDate, dateFollowsToday, userId, category, startTime, endTime, maxInputChars, result, loading, error, saveMessage } = workspace
  const [streamPreview, setStreamPreview] = useState<ArchiveSummaryResult | null>(null)
  const [streamStatus, setStreamStatus] = useState('')
  const [summaryLogs, setSummaryLogs] = useState<Awaited<ReturnType<typeof loadLocalSummaryLogs>>>([])
  const [selectedLogPath, setSelectedLogPath] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsRefresh, setLogsRefresh] = useState(0)
  const [view, setView] = useState<'generate' | 'saved' | 'automatic'>('generate')
  const [savedDate, setSavedDate] = useState(date)
  const [logsError, setLogsError] = useState('')
  const [logMessage, setLogMessage] = useState('')
  const [modelConfigOpen, setModelConfigOpen] = useState(false)
  const [runContext, setRunContext] = useState('')
  const streamAbortRef = useRef<AbortController | null>(null)
  const draftRef = useRef<ArchiveSummaryResult | null>(null)
  const selectedLog = summaryLogs.find(item => item.path === selectedLogPath)
  const visibleResult = view === 'saved' ? selectedLog ? summaryResultFromLog(selectedLog.content, savedDate) : null : streamPreview || result

  const canRun = Boolean(summaryModel.model.trim() && summaryModel.baseUrl.trim() && summaryModel.apiToken.trim())
  const localRecords = useMemo(() => buildLocalSummaryRecords(history, {
    date,
    endDate,
    category,
    startTime,
    endTime,
  }), [category, date, endDate, endTime, history, startTime])

  const stopSummary = useCallback(() => {
    const controller = streamAbortRef.current
    if (!controller || controller.signal.aborted) return
    controller.abort()
    updateWorkspace({ loading: false, result: draftRef.current, error: '', saveMessage: '已停止生成，已输出的草稿保留在此页，可复制或另存为。' })
    setStreamStatus('已停止生成')
  }, [updateWorkspace])

  useActivityTask('summary-generation', loading ? { label: '正在生成总结', detail: runContext, page: 'summary', onStop: stopSummary } : null)
  useEffect(() => () => stopSummary(), [stopSummary])

  useEffect(() => {
    if (!dateFollowsToday) return
    const syncToday = () => {
      const today = localDateValue()
      if (!useASRStore.getState().summaryWorkspace.loading && useASRStore.getState().summaryWorkspace.date !== today) {
        updateWorkspace({ date: today, endDate: today })
      }
    }
    syncToday()
    const timer = window.setInterval(syncToday, 60_000)
    return () => window.clearInterval(timer)
  }, [dateFollowsToday, updateWorkspace])

  useEffect(() => {
    let alive = true
    setLogsLoading(true)
    setLogsError('')
    loadLocalSummaryLogs(savedDate, settings.archiveDir).then((logs) => {
      if (!alive) return
      setSummaryLogs(logs)
      setSelectedLogPath((current) => logs.some((item) => item.path === current) ? current : (logs[0]?.path || ''))
    }).catch((loadError) => {
      if (alive) setLogsError(loadError instanceof Error ? `读取已生成总结失败：${loadError.message}` : '读取已生成总结失败')
    }).finally(() => {
      if (alive) setLogsLoading(false)
    })
    return () => { alive = false }
  }, [savedDate, logsRefresh, settings.archiveDir])

  const runSummary = async () => {
    if (streamAbortRef.current && !streamAbortRef.current.signal.aborted) return
    if (!canRun) {
      updateWorkspace({ error: '请在本页的总结模型配置中选择服务连接和模型。' })
      setModelConfigOpen(true)
      return
    }
    if (!date || !endDate || endDate < date || (startTime && endTime && startTime > endTime)) {
      updateWorkspace({ error: '请检查开始与结束日期、时间。' })
      return
    }
    const controller = new AbortController()
    streamAbortRef.current = controller
    setRunContext(`${source === 'local' ? '本机记录' : '服务端归档'} · ${summaryRangeLabel(date, endDate, startTime, endTime)} · ${summaryModel.model}`)
    updateWorkspace({ loading: true, error: '', saveMessage: '' })
    try {
      let streamedText = ''
      let preview: ArchiveSummaryResult = {
        summary: '',
        model: summaryModel.model,
        provider: summaryModel.provider,
        source_count: 0,
        input_chars: 0,
        estimated_input_tokens: 0,
        chunk_count: 0,
        truncated: false,
        date,
        start_date: date,
        end_date: endDate,
        time_range: summaryRangeLabel(date, endDate, startTime, endTime),
      }
      draftRef.current = preview
      updateWorkspace({ result: preview })
      setStreamPreview(preview)
      setStreamStatus('正在读取归档记录')
      const summary = await api.streamArchiveSummary({
        date,
        start_date: date,
        end_date: endDate,
        user_id: userId.trim() || undefined,
        category: category.trim() || undefined,
        start_time: startTime || undefined,
        end_time: endTime || undefined,
        provider: summaryModel.provider,
        model: summaryModel.model,
        base_url: summaryModel.baseUrl,
        api_token: summaryModel.apiToken,
        prompt: settings.summaryPrompt,
        style: settings.llmStyle || '工作纪要',
        max_input_chars: maxInputChars,
        records: source === 'local' ? localRecords : undefined,
      }, async (event) => {
        if (controller.signal.aborted || streamAbortRef.current !== controller) return
        if (event.type === 'status') {
          setStreamStatus(event.message)
          return
        }
        if (event.type === 'meta') {
          preview = { ...preview, ...event }
          draftRef.current = preview
          updateWorkspace({ result: preview })
          setStreamPreview(preview)
          return
        }
        if (event.type === 'delta') {
          setStreamStatus('正在流式生成总结')
          for (const character of Array.from(event.text)) {
            if (controller.signal.aborted || streamAbortRef.current !== controller) return
            streamedText += character
            preview = { ...preview, summary: streamedText }
            draftRef.current = preview
            setStreamPreview(preview)
            await new Promise((resolve) => window.setTimeout(resolve, 0))
          }
          updateWorkspace({ result: preview })
          return
        }
        if (event.type === 'done') {
          preview = event.result
          draftRef.current = preview
          setStreamPreview(preview)
        }
      }, controller.signal)
      if (controller.signal.aborted || streamAbortRef.current !== controller) return
      draftRef.current = summary
      streamAbortRef.current = null
      updateWorkspace({ result: summary, loading: false })
      setStreamPreview(null)
      setStreamStatus('总结完成')
      try {
        const saved = await saveSummaryToLocalLog(summary, settings.archiveDir)
        if (draftRef.current === summary) updateWorkspace({
          saveMessage: saved ? `已自动保存总结日志：${saved.path}` : '总结已生成；浏览器环境未写入 Electron 日志目录',
        })
        if (saved) {
          setSavedDate(summary.start_date || summary.date)
          setSelectedLogPath(saved.path)
          setLogsRefresh((value) => value + 1)
        }
      } catch (saveError) {
        if (draftRef.current === summary) updateWorkspace({ error: saveError instanceof Error ? `总结已生成，但自动保存失败：${saveError.message}` : '总结已生成，但自动保存失败' })
      }
    } catch (summaryError) {
      if (controller.signal.aborted || streamAbortRef.current !== controller) return
      updateWorkspace({
        loading: false,
        result: draftRef.current,
        error: summaryError instanceof Error ? summaryError.message : '当日总结失败',
      })
      setStreamStatus('')
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
    }
  }

  const saveAs = async () => {
    if (!visibleResult) return
    try {
      const ok = await saveText(visibleResult.summary, summaryLogFilename(visibleResult))
      if (ok) {
        if (view === 'saved') setLogMessage('已另存为 Markdown 文件')
        else updateWorkspace({ saveMessage: '已另存为 Markdown 文件', error: '' })
      }
    } catch {
      if (view === 'saved') setLogsError('另存为失败，请重试。')
      else updateWorkspace({ error: '另存为失败，请重试。' })
    }
  }

  const displayGeneratedSummary = (path: string) => {
    setSelectedLogPath(path)
    setLogMessage('')
  }

  return (
    <div className="page summary-page">
      <header className="page-heading"><div><h1>当日总结</h1><p>选择记录范围，生成并保存总结。</p></div></header>
      <nav className="summary-navigation" aria-label="总结功能">
        <button type="button" className={view === 'generate' ? 'active' : ''} aria-current={view === 'generate' ? 'page' : undefined} onClick={() => setView('generate')}>生成</button>
        <button type="button" className={view === 'saved' ? 'active' : ''} aria-current={view === 'saved' ? 'page' : undefined} onClick={() => setView('saved')}>已保存</button>
        <button type="button" className={view === 'automatic' ? 'active' : ''} aria-current={view === 'automatic' ? 'page' : undefined} onClick={() => setView('automatic')}>自动总结</button>
      </nav>
      {loading && <div className="summary-running" role="status">
        <div><strong>{streamStatus || '正在连接大模型流'}</strong><span>本次生成：{runContext}</span></div>
        <button type="button" onClick={stopSummary}>停止生成</button>
      </div>}

      {view !== 'automatic' && <div className={`summary-workspace${view === 'saved' ? ' summary-saved-workspace' : ''}`}>
        {view === 'generate' && <section className="panel summary-controls">
          <h2>生成总结</h2>
          <fieldset disabled={loading} className="summary-fields">
            <div className="summary-form">
              <label className="summary-wide">文本来源<select value={source} onChange={event => updateWorkspace({ source: event.target.value as typeof source })}><option value="local">本机记录</option><option value="server">服务端归档</option></select></label>
              <label>开始日期<input type="date" value={date} onChange={event => { const nextDate = event.target.value; updateWorkspace({ date: nextDate, endDate: endDate < nextDate ? nextDate : endDate, dateFollowsToday: false }) }} /></label>
              <label>结束日期<input type="date" value={endDate} min={date} onChange={event => updateWorkspace({ endDate: event.target.value, dateFollowsToday: false })} /></label>
            </div>
            <button type="button" className="summary-today" onClick={() => { const today = localDateValue(); updateWorkspace({ date: today, endDate: today, dateFollowsToday: true }) }}>今天</button>
            <details className="summary-advanced"><summary>时间、类型与输入范围</summary><div className="summary-form">
              <label>总结类型<select value={category} onChange={event => updateWorkspace({ category: event.target.value })}>{SUMMARY_CATEGORY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label>用户<input value={userId} placeholder="留空为全部用户" onChange={event => updateWorkspace({ userId: event.target.value })} /></label>
              <label>开始时间<input type="time" value={startTime} onChange={event => updateWorkspace({ startTime: event.target.value })} /></label>
              <label>结束时间<input type="time" value={endTime} onChange={event => updateWorkspace({ endTime: event.target.value })} /></label>
              <label className="summary-wide">输入上限<input type="number" min={4000} max={120000} step={1000} value={maxInputChars} onChange={event => updateWorkspace({ maxInputChars: Number(event.target.value) })} /></label>
            </div></details>
          </fieldset>
          <p className="summary-selection-note">{source === 'local' ? `${localRecords.length} 条本机记录待总结` : '查询服务端已留存的归档'} · {startTime}–{endTime}</p>
          <p className="summary-model-note">模型：{summaryModel.model || '尚未配置'} <span>{providerPreset.label}</span></p>
          <button type="button" className="primary summary-run" disabled={loading || !date || !endDate} onClick={() => void runSummary()}>{loading ? '总结中' : '生成总结'}</button>
          {error && <p className="error" role="alert">{error}</p>}
          <details className="summary-advanced" open={modelConfigOpen} onToggle={event => setModelConfigOpen(event.currentTarget.open)}>
            <summary>模型与总结模板</summary>
            <fieldset disabled={loading} className="summary-fields">
              <TaskModelSettings task="summary" disabled={loading} />
              <PromptCardEditor title="总结 Prompt 卡片" description="选择生成总结与自动总结共用的模板。" cards={settings.summaryPromptCards} activeCardId={settings.activeSummaryPromptCardId} onChange={({ cards, activeCardId, prompt }) => updateSettings({ summaryPromptCards: cards, activeSummaryPromptCardId: activeCardId, summaryPrompt: prompt })} />
            </fieldset>
          </details>
          <details className="summary-advanced"><summary>记录发送与保存说明</summary><p>{source === 'local' ? '仅发送时间、类别和文本，不发送音频、路径或设备信息。' : '如果服务端未留存记录，请切换为本机记录。'}生成完成后会自动保存到本机总结日志。</p></details>
        </section>}

        <section className="panel summary-result">
          {view === 'saved' && <div className="summary-log-toolbar">
            <label>日志日期<input type="date" value={savedDate} onChange={event => { setSavedDate(event.target.value); setLogMessage('') }} /></label>
            <label>已生成总结<select aria-label="已生成总结" value={selectedLogPath} onChange={event => displayGeneratedSummary(event.target.value)}>
              {summaryLogs.length === 0 && <option value="">当前日期暂无总结</option>}
              {summaryLogs.map(log => <option key={log.path} value={log.path}>{new Date(log.modifiedAt).toLocaleString()} · {log.name}</option>)}
            </select></label>
            <button type="button" title="刷新总结列表" onClick={() => setLogsRefresh(value => value + 1)}>{logsLoading ? '读取中…' : '刷新'}</button>
          </div>}
          <div className="section-head compact"><h2>{view === 'saved' ? '已保存总结' : loading ? '正在生成的草稿' : '总结结果'}</h2><div className="result-actions">
            <button type="button" disabled={!visibleResult?.summary} onClick={() => void copyText(visibleResult?.summary || '').then(() => view === 'saved' ? setLogMessage('已复制') : updateWorkspace({ saveMessage: '已复制' })).catch(() => view === 'saved' ? setLogMessage('复制失败，请重试。') : updateWorkspace({ error: '复制失败，请重试。' }))}>复制</button>
            <button type="button" disabled={!visibleResult?.summary} onClick={() => void saveAs()}>另存为</button>
          </div></div>
          {view === 'saved' && logsError && <p className="error" role="alert">{logsError}</p>}
          {(view === 'saved' ? logMessage : saveMessage) && <p className="status-message" role="status">{view === 'saved' ? logMessage : saveMessage}</p>}
          {visibleResult ? <>
            <div className="summary-result-meta"><span>{visibleResult.time_range || '已保存结果'}</span>{view === 'generate' && <><span>{formatStat(visibleResult.source_count)} 条记录</span><span>约 {formatStat(visibleResult.estimated_input_tokens)} 输入 tokens</span><span>{visibleResult.chunk_count || '—'} 个分块</span></>}</div>
            {visibleResult.truncated && <p className="summary-warning">输入已达到上限，结果只覆盖前 {formatStat(visibleResult.input_chars)} 字。</p>}
            <div className={loading && view === 'generate' ? 'summary-stream-output streaming' : 'summary-stream-output'}><MarkdownContent content={visibleResult.summary || ' '} />{loading && view === 'generate' && <i className="stream-caret" aria-label="流式生成中" />}</div>
          </> : <p className="empty">{view === 'saved' ? '当前日期暂无保存的总结。' : '选择范围后生成总结；已有结果会保留，直到开始下一次生成。'}</p>}
        </section>
      </div>}

      {view === 'automatic' && <section className="panel summary-passive-panel">
        <div className="section-head compact"><div><h2>自动总结</h2><p>按设定频率总结记录，每次完成后自动保存到本机日志。</p></div><span className={settings.passiveSummaryEnabled ? 'soft-badge success' : 'soft-badge'}>{settings.passiveSummaryEnabled ? '已启用' : '未启用'}</span></div>
        <div className="summary-form passive-summary-form">
          <label className="toggle-row"><input type="checkbox" checked={settings.passiveSummaryEnabled} onChange={event => updateSettings({ passiveSummaryEnabled: event.target.checked })} />启用自动总结</label>
          <label>频率（分钟）<input type="number" min={5} max={1440} step={5} value={settings.passiveSummaryFrequencyMin} onChange={event => updateSettings({ passiveSummaryFrequencyMin: Number(event.target.value) })} /></label>
          <label>文本来源<select value={settings.passiveSummarySource} onChange={event => updateSettings({ passiveSummarySource: event.target.value as typeof settings.passiveSummarySource })}><option value="local">本机记录</option><option value="server">服务端归档</option></select></label>
          <label>总结类型<select value={settings.passiveSummaryCategory} onChange={event => updateSettings({ passiveSummaryCategory: event.target.value })}>{SUMMARY_CATEGORY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>开始时间<input type="time" value={settings.passiveSummaryStartTime} onChange={event => updateSettings({ passiveSummaryStartTime: event.target.value })} /></label>
          <label>结束时间<input type="time" value={settings.passiveSummaryEndTime} onChange={event => updateSettings({ passiveSummaryEndTime: event.target.value })} /></label>
          <label>用户<input value={settings.passiveSummaryUserId} onChange={event => updateSettings({ passiveSummaryUserId: event.target.value })} /></label>
        </div>
        <p className="muted-note">最近执行：{settings.passiveSummaryLastRunAt ? new Date(settings.passiveSummaryLastRunAt).toLocaleString() : '尚未执行'}。模型与模板在“生成”中设置。</p>
      </section>}
    </div>
  )
}

export { localDateValue }

function summaryResultFromLog(content: string, date: string): ArchiveSummaryResult {
  return {
    summary: content,
    model: '本机总结日志',
    provider: 'local',
    source_count: 0,
    input_chars: content.length,
    estimated_input_tokens: 0,
    chunk_count: 0,
    truncated: false,
    date,
    start_date: date,
    end_date: date,
    time_range: null,
  }
}

function summaryRangeLabel(date: string, endDate: string, startTime: string, endTime: string) {
  const day = date === endDate ? date : `${date} 至 ${endDate}`
  const clock = [startTime, endTime].filter(Boolean).join('-') || '全天'
  return `${day} ${clock}`
}
