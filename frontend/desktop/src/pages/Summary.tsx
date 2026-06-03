import { useMemo, useState } from 'react'
import { ASRApi, type ArchiveSummaryResult } from '@/services/api'
import { saveText } from '@/services/export'
import { getProviderPreset } from '@/services/llmProviders'
import { useASRStore } from '@/store/useASRStore'

function localDateValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

function formatStat(value: number) {
  return Number.isFinite(value) ? value.toLocaleString() : '0'
}

export function SummaryPage() {
  const settings = useASRStore((state) => state.settings)
  const setPage = useASRStore((state) => state.setPage)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [date, setDate] = useState(localDateValue())
  const [userId, setUserId] = useState('dsm')
  const [category, setCategory] = useState('实时转写')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [maxInputChars, setMaxInputChars] = useState(24000)
  const [summary, setSummary] = useState<ArchiveSummaryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const providerPreset = getProviderPreset(settings.llmProvider)

  const canRun = Boolean(settings.llmModel.trim() && settings.llmBaseUrl.trim() && settings.llmApiToken.trim())

  const runSummary = async () => {
    if (!canRun) {
      setError('请先在模型管理中填写大模型厂商、模型和 API Token')
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await api.summarizeArchive({
        date,
        user_id: userId.trim() || undefined,
        category: category.trim() || undefined,
        start_time: startTime || undefined,
        end_time: endTime || undefined,
        provider: settings.llmProvider,
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
        style: settings.llmStyle || '工作纪要',
        max_input_chars: maxInputChars
      })
      setSummary(result)
      setSaveMessage('')
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : '当日总结失败')
    } finally {
      setLoading(false)
    }
  }

  const summaryFilename = () => `summary_${date}_${startTime || 'start'}_${endTime || 'end'}.md`

  const saveLocal = async () => {
    if (!summary) return
    const ok = await saveText(summary.summary, summaryFilename())
    if (ok) setSaveMessage('已保存到本地')
  }

  const saveCloud = async () => {
    if (!summary) return
    setError('')
    try {
      const result = await api.saveArchiveSummary({
        summary,
        user_id: userId.trim() || undefined,
        category: '当日总结'
      })
      setSaveMessage(`云端已保存：${result.path}`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '云端保存失败')
    }
  }

  return (
    <div className="page summary-page">
      <header className="page-heading">
        <div>
          <h1>当日总结</h1>
          <p>按日期、用户与时间段汇总归档 ASR 文本。</p>
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
              日期
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              用户
              <input value={userId} placeholder="留空为全部用户" onChange={(event) => setUserId(event.target.value)} />
            </label>
            <label>
              类别
              <input value={category} placeholder="留空为全部类别" onChange={(event) => setCategory(event.target.value)} />
            </label>
            <label>
              开始时间
              <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
            </label>
            <label>
              结束时间
              <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
            </label>
            <label>
              输入上限
              <input
                type="number"
                min={4000}
                max={120000}
                step={1000}
                value={maxInputChars}
                onChange={(event) => setMaxInputChars(Number(event.target.value))}
              />
            </label>
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
              <button type="button" disabled={!summary} onClick={() => window.electronAPI?.textToClipboard(summary?.summary || '')}>复制</button>
              <button type="button" disabled={!summary} onClick={() => void saveLocal()}>本地保存</button>
              <button type="button" disabled={!summary} onClick={() => void saveCloud()}>云端保存</button>
            </div>
          </div>
          {saveMessage && <p className="status-message">{saveMessage}</p>}
          {summary ? (
            <>
              <div className="summary-stats">
                <article>
                  <span>记录数</span>
                  <strong>{formatStat(summary.source_count)}</strong>
                </article>
                <article>
                  <span>估算输入</span>
                  <strong>{formatStat(summary.estimated_input_tokens)}</strong>
                </article>
                <article>
                  <span>分块</span>
                  <strong>{summary.chunk_count}</strong>
                </article>
                <article>
                  <span>范围</span>
                  <strong>{summary.time_range || '全天'}</strong>
                </article>
              </div>
              {summary.truncated && <p className="summary-warning">输入已达到上限，结果只覆盖前 {formatStat(summary.input_chars)} 字。</p>}
              <pre className="summary-markdown">{summary.summary}</pre>
            </>
          ) : (
            <p className="empty">选择日期后生成当日归档总结。</p>
          )}
        </section>
      </div>

      <section className="panel summary-passive-panel">
        <div className="section-head compact">
          <h2>被动总结</h2>
          <span className={settings.passiveSummaryEnabled ? 'soft-badge success' : 'soft-badge'}>{settings.passiveSummaryEnabled ? '已启用' : '未启用'}</span>
        </div>
        <div className="summary-form passive-summary-form">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.passiveSummaryEnabled}
              onChange={(event) => updateSettings({ passiveSummaryEnabled: event.target.checked })}
            />
            自动按频率总结当日归档
          </label>
          <label>
            频率（分钟）
            <input
              type="number"
              min={5}
              max={1440}
              step={5}
              value={settings.passiveSummaryFrequencyMin}
              onChange={(event) => updateSettings({ passiveSummaryFrequencyMin: Number(event.target.value) })}
            />
          </label>
          <label>
            用户
            <input value={settings.passiveSummaryUserId} onChange={(event) => updateSettings({ passiveSummaryUserId: event.target.value })} />
          </label>
          <label>
            类别
            <input value={settings.passiveSummaryCategory} onChange={(event) => updateSettings({ passiveSummaryCategory: event.target.value })} />
          </label>
          <label>
            开始时间
            <input type="time" value={settings.passiveSummaryStartTime} onChange={(event) => updateSettings({ passiveSummaryStartTime: event.target.value })} />
          </label>
          <label>
            结束时间
            <input type="time" value={settings.passiveSummaryEndTime} onChange={(event) => updateSettings({ passiveSummaryEndTime: event.target.value })} />
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.passiveSummaryAutoCloudSave}
              onChange={(event) => updateSettings({ passiveSummaryAutoCloudSave: event.target.checked })}
            />
            自动云端保存
          </label>
        </div>
        <p className="muted-note">
          最近执行：{settings.passiveSummaryLastRunAt ? new Date(settings.passiveSummaryLastRunAt).toLocaleString() : '尚未执行'}
        </p>
      </section>
    </div>
  )
}
