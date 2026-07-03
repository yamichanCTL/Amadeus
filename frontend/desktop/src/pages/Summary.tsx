import { useMemo } from 'react'
import { MarkdownContent } from '@/components/MarkdownContent'
import { PromptCardEditor } from '@/components/PromptCardEditor'
import { ASRApi } from '@/services/api'
import { saveText } from '@/services/export'
import { getProviderPreset } from '@/services/llmProviders'
import { saveSummaryToLocalLog, summaryLogFilename } from '@/services/summaryLog'
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
  return { startTime: '00:00', endTime: localTimeValue(date) }
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
  const { source, date, userId, category, startTime, endTime, maxInputChars, result, loading, error, saveMessage } = workspace

  const canRun = Boolean(settings.llmModel.trim() && settings.llmBaseUrl.trim() && settings.llmApiToken.trim())
  const localRecords = useMemo(() => buildLocalSummaryRecords(history, {
    date,
    category,
    startTime,
    endTime,
  }), [category, date, endTime, history, startTime])

  const runSummary = async () => {
    if (!canRun) {
      updateWorkspace({ error: '请先在模型管理的 LLM 设置中填写厂商、模型和 API Token' })
      return
    }
    updateWorkspace({ loading: true, error: '', saveMessage: '' })
    try {
      const summary = await api.summarizeArchive({
        date,
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
      })
      updateWorkspace({ result: summary, loading: false })
      try {
        const saved = await saveSummaryToLocalLog(summary, settings.archiveDir)
        updateWorkspace({
          saveMessage: saved ? `已自动保存总结日志：${saved.path}` : '总结已生成；浏览器环境未写入 Electron 日志目录',
        })
      } catch (saveError) {
        updateWorkspace({ error: saveError instanceof Error ? `总结已生成，但自动保存失败：${saveError.message}` : '总结已生成，但自动保存失败' })
      }
    } catch (summaryError) {
      updateWorkspace({
        loading: false,
        error: summaryError instanceof Error ? summaryError.message : '当日总结失败',
      })
    }
  }

  const saveAs = async () => {
    if (!result) return
    const ok = await saveText(result.summary, summaryLogFilename(result))
    if (ok) updateWorkspace({ saveMessage: '已另存为 Markdown 文件', error: '' })
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
              <select value={source} onChange={(event) => updateWorkspace({ source: event.target.value as typeof source, result: null })}>
                <option value="local">本机记录</option>
                <option value="server">服务端归档</option>
              </select>
            </label>
            <label>
              日期
              <input type="date" value={date} onChange={(event) => updateWorkspace({ date: event.target.value, result: null })} />
            </label>
            <label>
              用户
              <input value={userId} placeholder="留空为全部用户" onChange={(event) => updateWorkspace({ userId: event.target.value })} />
            </label>
            <label>
              总结类型
              <select value={category} onChange={(event) => updateWorkspace({ category: event.target.value, result: null })}>
                {SUMMARY_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              开始时间
              <input type="time" value={startTime} onChange={(event) => updateWorkspace({ startTime: event.target.value, result: null })} />
            </label>
            <label>
              结束时间
              <input type="time" value={endTime} onChange={(event) => updateWorkspace({ endTime: event.target.value, result: null })} />
            </label>
            <label>
              输入上限
              <input type="number" min={4000} max={120000} step={1000} value={maxInputChars} onChange={(event) => updateWorkspace({ maxInputChars: Number(event.target.value) })} />
            </label>
          </div>
          <PromptCardEditor
            title="总结 Prompt 卡片"
            description="点击卡片立即切换主动与被动总结使用的 Prompt。"
            cards={settings.summaryPromptCards}
            activeCardId={settings.activeSummaryPromptCardId}
            onChange={({ cards, activeCardId, prompt }) => updateSettings({ summaryPromptCards: cards, activeSummaryPromptCardId: activeCardId, summaryPrompt: prompt })}
          />
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
          <button type="button" className="primary summary-run" disabled={loading || !date} onClick={() => void runSummary()}>
            {loading ? '总结中' : '生成总结'}
          </button>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel summary-result">
          <div className="section-head compact">
            <h2>总结结果</h2>
            <div className="result-actions">
              <button type="button" disabled={!result} onClick={() => window.electronAPI?.textToClipboard(result?.summary || '')}>复制</button>
              <button type="button" disabled={!result} onClick={() => void saveAs()}>另存为</button>
            </div>
          </div>
          {saveMessage && <p className="status-message">{saveMessage}</p>}
          {result ? (
            <>
              <div className="summary-stats">
                <article><span>记录数</span><strong>{formatStat(result.source_count)}</strong></article>
                <article><span>估算输入</span><strong>{formatStat(result.estimated_input_tokens)}</strong></article>
                <article><span>分块</span><strong>{result.chunk_count}</strong></article>
                <article><span>范围</span><strong>{result.time_range || '全天'}</strong></article>
              </div>
              {result.truncated && <p className="summary-warning">输入已达到上限，结果只覆盖前 {formatStat(result.input_chars)} 字。</p>}
              <MarkdownContent content={result.summary} />
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
