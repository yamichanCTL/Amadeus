import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownContent } from '@/components/MarkdownContent'
import { PromptCardEditor } from '@/components/PromptCardEditor'
import { ASRApi, type ArchiveSummaryResult } from '@/services/api'
import { saveText } from '@/services/export'
import { getProviderPreset } from '@/services/llmProviders'
import { loadLocalSummaryLogs, saveSummaryToLocalLog, summaryLogFilename } from '@/services/summaryLog'
import { buildLocalSummaryRecords } from '@/services/summaryRecords'
import { useASRStore } from '@/store/useASRStore'

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
  const setPage = useASRStore((state) => state.setPage)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const updateWorkspace = useASRStore((state) => state.updateSummaryWorkspace)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const providerPreset = getProviderPreset(settings.llmProvider)
  const { source, date, endDate, dateFollowsToday, userId, category, startTime, endTime, maxInputChars, result, loading, error, saveMessage } = workspace
  const [streamPreview, setStreamPreview] = useState<ArchiveSummaryResult | null>(null)
  const [streamStatus, setStreamStatus] = useState('')
  const [summaryLogs, setSummaryLogs] = useState<Awaited<ReturnType<typeof loadLocalSummaryLogs>>>([])
  const [selectedLogPath, setSelectedLogPath] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsRefresh, setLogsRefresh] = useState(0)
  const streamAbortRef = useRef<AbortController | null>(null)
  const visibleResult = streamPreview || result

  const canRun = Boolean(settings.llmModel.trim() && settings.llmBaseUrl.trim() && settings.llmApiToken.trim())
  const localRecords = useMemo(() => buildLocalSummaryRecords(history, {
    date,
    endDate,
    category,
    startTime,
    endTime,
  }), [category, date, endDate, endTime, history, startTime])

  useEffect(() => () => streamAbortRef.current?.abort(), [])

  useEffect(() => {
    if (!dateFollowsToday) return
    const syncToday = () => {
      const today = localDateValue()
      if (useASRStore.getState().summaryWorkspace.date !== today) {
        updateWorkspace({ date: today, endDate: today, result: null, error: '', saveMessage: '' })
      }
    }
    syncToday()
    const timer = window.setInterval(syncToday, 60_000)
    return () => window.clearInterval(timer)
  }, [dateFollowsToday, updateWorkspace])

  useEffect(() => {
    let alive = true
    setLogsLoading(true)
    loadLocalSummaryLogs(date, settings.archiveDir).then((logs) => {
      if (!alive) return
      setSummaryLogs(logs)
      setSelectedLogPath((current) => logs.some((item) => item.path === current) ? current : (logs[0]?.path || ''))
    }).catch((loadError) => {
      if (alive) updateWorkspace({ error: loadError instanceof Error ? `读取已生成总结失败：${loadError.message}` : '读取已生成总结失败' })
    }).finally(() => {
      if (alive) setLogsLoading(false)
    })
    return () => { alive = false }
  }, [date, logsRefresh, settings.archiveDir, updateWorkspace])

  useEffect(() => {
    const selected = summaryLogs.find((item) => item.path === selectedLogPath)
    if (!selected) return
    setStreamPreview(null)
    setStreamStatus('')
    updateWorkspace({
      result: summaryResultFromLog(selected.content, date),
      error: '',
      saveMessage: `已显示总结：${selected.path}`,
    })
  }, [date, selectedLogPath, summaryLogs, updateWorkspace])

  const runSummary = async () => {
    if (!canRun) {
      updateWorkspace({ error: '请先在模型管理的 LLM 设置中填写厂商、模型和 API Token' })
      return
    }
    updateWorkspace({ loading: true, error: '', saveMessage: '' })
    try {
      streamAbortRef.current?.abort()
      const controller = new AbortController()
      streamAbortRef.current = controller
      let streamedText = ''
      let preview: ArchiveSummaryResult = {
        summary: '',
        model: settings.llmModel,
        provider: settings.llmProvider,
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
        provider: settings.llmProvider,
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
        prompt: settings.summaryPrompt,
        style: settings.llmStyle || '工作纪要',
        max_input_chars: maxInputChars,
        records: source === 'local' ? localRecords : undefined,
      }, async (event) => {
        if (event.type === 'status') {
          setStreamStatus(event.message)
          return
        }
        if (event.type === 'meta') {
          preview = { ...preview, ...event }
          setStreamPreview(preview)
          return
        }
        if (event.type === 'delta') {
          setStreamStatus('正在流式生成总结')
          for (const character of Array.from(event.text)) {
            streamedText += character
            preview = { ...preview, summary: streamedText }
            setStreamPreview(preview)
            await new Promise((resolve) => window.setTimeout(resolve, 0))
          }
          return
        }
        if (event.type === 'done') {
          preview = event.result
          setStreamPreview(preview)
        }
      }, controller.signal)
      updateWorkspace({ result: summary, loading: false })
      setStreamPreview(null)
      setStreamStatus('总结完成')
      try {
        const saved = await saveSummaryToLocalLog(summary, settings.archiveDir)
        updateWorkspace({
          saveMessage: saved ? `已自动保存总结日志：${saved.path}` : '总结已生成；浏览器环境未写入 Electron 日志目录',
        })
        if (saved) {
          setSelectedLogPath(saved.path)
          setLogsRefresh((value) => value + 1)
        }
      } catch (saveError) {
        updateWorkspace({ error: saveError instanceof Error ? `总结已生成，但自动保存失败：${saveError.message}` : '总结已生成，但自动保存失败' })
      }
    } catch (summaryError) {
      updateWorkspace({
        loading: false,
        error: summaryError instanceof Error ? summaryError.message : '当日总结失败',
      })
      setStreamStatus('')
    } finally {
      streamAbortRef.current = null
    }
  }

  const saveAs = async () => {
    if (!visibleResult) return
    const ok = await saveText(visibleResult.summary, summaryLogFilename(visibleResult))
    if (ok) updateWorkspace({ saveMessage: '已另存为 Markdown 文件', error: '' })
  }

  const displayGeneratedSummary = (path: string) => {
    setSelectedLogPath(path)
  }

  return (
    <div className="page summary-page">
      <header className="page-heading">
        <div>
          <h1>当日总结</h1>
          <p>从本机记录或服务端归档提取指定时间段，返回 Markdown 总结。</p>
        </div>
        <button type="button" onClick={() => setPage('models')}>模型管理</button>
      </header>

      <div className="summary-workspace">
        <section className="panel summary-controls">
          <div className="section-head compact">
            <h2>范围</h2>
            <span className="soft-badge">{providerPreset.label}</span>
          </div>
          <div className="summary-form">
            <label>
              文本来源
              <select value={source} onChange={(event) => { setStreamPreview(null); updateWorkspace({ source: event.target.value as typeof source, result: null }) }}>
                <option value="local">本机记录</option>
                <option value="server">服务端归档</option>
              </select>
            </label>
            <label>
              开始日期
              <div className="inline-control">
                <input type="date" value={date} onChange={(event) => {
                  const nextDate = event.target.value
                  setStreamPreview(null)
                  updateWorkspace({ date: nextDate, endDate: endDate < nextDate ? nextDate : endDate, dateFollowsToday: false, result: null })
                }} />
                <button type="button" onClick={() => {
                  const today = localDateValue()
                  updateWorkspace({ date: today, endDate: today, dateFollowsToday: true, result: null })
                }}>今天</button>
              </div>
            </label>
            <label>
              结束日期
              <input type="date" value={endDate} min={date} onChange={(event) => { setStreamPreview(null); updateWorkspace({ endDate: event.target.value, dateFollowsToday: false, result: null }) }} />
            </label>
            <label>
              用户
              <input value={userId} placeholder="留空为全部用户" onChange={(event) => { setStreamPreview(null); updateWorkspace({ userId: event.target.value, result: null }) }} />
            </label>
            <label>
              总结类型
              <select value={category} onChange={(event) => { setStreamPreview(null); updateWorkspace({ category: event.target.value, result: null }) }}>
                {SUMMARY_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              开始时间
              <input type="time" value={startTime} onChange={(event) => { setStreamPreview(null); updateWorkspace({ startTime: event.target.value, result: null }) }} />
            </label>
            <label>
              结束时间
              <input type="time" value={endTime} onChange={(event) => { setStreamPreview(null); updateWorkspace({ endTime: event.target.value, result: null }) }} />
            </label>
            <label>
              输入上限
              <input type="number" min={4000} max={120000} step={1000} value={maxInputChars} onChange={(event) => updateWorkspace({ maxInputChars: Number(event.target.value) })} />
            </label>
          </div>
          <div className="summary-source-note">
            <span>{source === 'local' ? '本机记录' : '服务端归档'}</span>
            <strong>{source === 'local' ? `${localRecords.length} 条本机记录待发送` : '只查询服务端已经留存的归档'}</strong>
            <small>{source === 'local' ? '临时发送时间、类别和文本，不发送音频、路径或设备信息。' : '如果服务端从未保存过音频/JSON，请切换为“本机记录”。'}</small>
          </div>
          <div className="summary-provider">
            <span>模型</span>
            <strong>{settings.llmModel || providerPreset.modelPlaceholder}</strong>
            <small>{settings.llmBaseUrl || providerPreset.baseUrl}</small>
          </div>
          <button type="button" className="primary summary-run" disabled={loading || !date || !endDate} onClick={() => void runSummary()}>
            {loading ? '总结中' : '生成总结'}
          </button>
          {error && <p className="error">{error}</p>}
          <PromptCardEditor
            title="总结 Prompt 卡片"
            description="点击卡片立即切换主动与被动总结使用的 Prompt。"
            cards={settings.summaryPromptCards}
            activeCardId={settings.activeSummaryPromptCardId}
            onChange={({ cards, activeCardId, prompt }) => updateSettings({ summaryPromptCards: cards, activeSummaryPromptCardId: activeCardId, summaryPrompt: prompt })}
          />
        </section>

        <section className="panel summary-result">
          <div className="section-head compact">
            <h2>总结结果</h2>
            <div className="result-actions">
              <button type="button" disabled={!visibleResult} onClick={() => window.electronAPI?.textToClipboard(visibleResult?.summary || '')}>复制</button>
              <button type="button" disabled={!visibleResult} onClick={() => void saveAs()}>另存为</button>
            </div>
          </div>
          <div className="summary-log-toolbar">
            <div>
              <strong>已生成总结</strong>
              <small>{logsLoading ? '正在读取…' : `${summaryLogs.length} 份本机 Markdown`}</small>
            </div>
            <select aria-label="已生成总结" value={selectedLogPath} onChange={(event) => displayGeneratedSummary(event.target.value)}>
              {summaryLogs.length === 0 && <option value="">当前日期暂无总结</option>}
              {summaryLogs.map((log) => (
                <option key={log.path} value={log.path}>{new Date(log.modifiedAt).toLocaleString()} · {log.name}</option>
              ))}
            </select>
            <button type="button" title="刷新总结列表" onClick={() => setLogsRefresh((value) => value + 1)}>刷新</button>
          </div>
          {loading && <div className="summary-stream-status"><span aria-hidden="true" />{streamStatus || '正在连接大模型流'}</div>}
          {saveMessage && <p className="status-message">{saveMessage}</p>}
          {visibleResult ? (
            <>
              <div className="summary-stats">
                <article><span>记录数</span><strong>{formatStat(visibleResult.source_count)}</strong></article>
                <article><span>估算输入</span><strong>{formatStat(visibleResult.estimated_input_tokens)}</strong></article>
                <article><span>分块</span><strong>{visibleResult.chunk_count || '—'}</strong></article>
                <article><span>范围</span><strong>{visibleResult.time_range || '已保存结果'}</strong></article>
              </div>
              {visibleResult.truncated && <p className="summary-warning">输入已达到上限，结果只覆盖前 {formatStat(visibleResult.input_chars)} 字。</p>}
              <div className={loading ? 'summary-stream-output streaming' : 'summary-stream-output'}>
                <MarkdownContent content={visibleResult.summary || ' '} />
                {loading && <i className="stream-caret" aria-label="流式生成中" />}
              </div>
            </>
          ) : <p className="empty">选择日期后生成当日总结；切换页面不会丢失这里的状态。</p>}
        </section>
      </div>

      <section className="panel summary-passive-panel">
        <div className="section-head compact">
          <h2>被动总结</h2>
          <span className={settings.passiveSummaryEnabled ? 'soft-badge success' : 'soft-badge'}>{settings.passiveSummaryEnabled ? '已启用' : '未启用'}</span>
        </div>
        <div className="summary-form passive-summary-form">
          <label className="toggle-row">
            <input type="checkbox" checked={settings.passiveSummaryEnabled} onChange={(event) => updateSettings({ passiveSummaryEnabled: event.target.checked })} />
            启用被动总结
          </label>
          <label>
            频率（分钟）
            <input type="number" min={5} max={1440} step={5} value={settings.passiveSummaryFrequencyMin} onChange={(event) => updateSettings({ passiveSummaryFrequencyMin: Number(event.target.value) })} />
          </label>
          <label>
            用户
            <input value={settings.passiveSummaryUserId} onChange={(event) => updateSettings({ passiveSummaryUserId: event.target.value })} />
          </label>
          <label>
            总结类型
            <select value={settings.passiveSummaryCategory} onChange={(event) => updateSettings({ passiveSummaryCategory: event.target.value })}>
              {SUMMARY_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>
            文本来源
            <select value={settings.passiveSummarySource} onChange={(event) => updateSettings({ passiveSummarySource: event.target.value as typeof settings.passiveSummarySource })}>
              <option value="local">本机记录</option>
              <option value="server">服务端归档</option>
            </select>
          </label>
          <label>
            开始时间
            <input type="time" value={settings.passiveSummaryStartTime} onChange={(event) => updateSettings({ passiveSummaryStartTime: event.target.value })} />
          </label>
          <label>
            结束时间
            <input type="time" value={settings.passiveSummaryEndTime} onChange={(event) => updateSettings({ passiveSummaryEndTime: event.target.value })} />
          </label>
        </div>
        <p className="muted-note">每次总结完成后都会自动保存到本机总结日志。最近执行：{settings.passiveSummaryLastRunAt ? new Date(settings.passiveSummaryLastRunAt).toLocaleString() : '尚未执行'}</p>
      </section>
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
