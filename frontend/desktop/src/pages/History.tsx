import { useEffect, useMemo, useState } from 'react'
import { ResultPanel } from '@/components/ResultPanel'
import { AudioPlayer } from '@/components/AudioPlayer'
import { copyText, saveResult } from '@/services/export'
import { useASRStore, type HistoryItem } from '@/store/useASRStore'

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ]
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return `${parts.join('-')} ${time}`
}

export function HistoryPage() {
  const history = useASRStore((state) => state.history)
  const removeHistory = useASRStore((state) => state.removeHistory)
  const clearHistory = useASRStore((state) => state.clearHistory)
  const setCurrentResult = useASRStore((state) => state.setCurrentResult)
  const [selectedId, setSelectedId] = useState(history[0]?.id || '')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [copied, setCopied] = useState(false)
  const filteredHistory = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY
    return history.filter((item) => {
      const createdAt = new Date(item.created_at).getTime()
      const matchesText = !needle || `${item.filename} ${item.full_text} ${item.engine_used}`.toLocaleLowerCase().includes(needle)
      const matchesLanguage = language === 'all' || item.language === language
      const matchesDate = !fromDate && !toDate
        ? true
        : Number.isFinite(createdAt) && createdAt >= from && createdAt <= to
      return matchesText && matchesLanguage && matchesDate
    })
  }, [fromDate, history, language, query, toDate])
  const selected = useMemo(
    () => filteredHistory.find((item) => item.id === selectedId) || filteredHistory[0] || null,
    [filteredHistory, selectedId]
  )

  useEffect(() => {
    if (selected?.id && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  const select = (item: HistoryItem) => {
    setSelectedId(item.id)
    setCurrentResult(item)
  }

  const totalDuration = filteredHistory.reduce((sum, item) => sum + (item.duration_sec || 0), 0)
  const enhancedCount = filteredHistory.filter((item) => item.llm_outputs?.polish || item.llm_outputs?.translate).length
  const clearFilters = () => {
    setQuery('')
    setLanguage('all')
    setFromDate('')
    setToDate('')
  }
  const copySelected = () => {
    if (!selected?.full_text) return
    setCopied(true)
    void copyText(selected.full_text)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="page history-page">
      <header className="page-heading">
        <div>
          <h1>历史记录</h1>
          <p>查看转写结果、语音会话与导出记录。</p>
        </div>
        <div className="result-actions">
          <button type="button" disabled={!query && language === 'all' && !fromDate && !toDate} onClick={clearFilters}>清空筛选</button>
          <button type="button" className="danger" disabled={!history.length} onClick={clearHistory}>清空全部记录</button>
        </div>
      </header>

      <section className="history-stats">
        <article className="stat-card">
          <span>筛选结果</span>
          <strong>{filteredHistory.length}</strong>
          <small>共 {history.length} 条记录</small>
        </article>
        <article className="stat-card">
          <span>累计识别时长</span>
          <strong>{Math.round(totalDuration / 60)}<small>分</small></strong>
          <small>当前筛选范围</small>
        </article>
        <article className="stat-card">
          <span>大模型增强</span>
          <strong>{enhancedCount}</strong>
          <small>润色/翻译</small>
        </article>
        <article className="stat-card">
          <span>默认引擎</span>
          <strong>{filteredHistory[0]?.engine_used || 'ASR'}</strong>
          <small>当前结果</small>
        </article>
      </section>

      <div className="history-workspace">
        <section className="panel history-list">
          <div className="filter-row">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、内容或关键词..." />
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="all">全部语言</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
            <label className="date-filter">从 <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
            <label className="date-filter">到 <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
          </div>
          {filteredHistory.length === 0 && <p className="empty">当前条件下暂无历史记录。</p>}
          {filteredHistory.map((item) => (
            <button key={item.id} type="button" className={selected?.id === item.id ? 'history-item active' : 'history-item'} onClick={() => select(item)}>
              <span className="play-dot">▶</span>
              <time>{formatDateTime(item.created_at)}</time>
              <strong>{item.filename}</strong>
              <small>{item.full_text.slice(0, 72)}</small>
              <em>{item.llm_outputs?.translate || item.llm_outputs?.polish ? '润色/翻译' : item.engine_used}</em>
            </button>
          ))}
        </section>
        <section className="panel history-detail">
          {selected ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>{selected.filename}</h2>
                  <p>{formatDateTime(selected.created_at)} · 时长 {selected.duration_sec ? `${selected.duration_sec.toFixed(1)}s` : '未知'}</p>
                </div>
                <div className="result-actions">
                  <button type="button" onClick={copySelected}>{copied ? '已复制' : '复制'}</button>
                  <button type="button" onClick={() => saveResult(selected, `${selected.task_id}.txt`, 'txt')}>TXT</button>
                  <button type="button" onClick={() => saveResult(selected, `${selected.task_id}.srt`, 'srt')}>SRT</button>
                  <button type="button" className="danger" onClick={() => removeHistory(selected.id)}>删除</button>
                </div>
              </div>
              <AudioPlayer item={selected} />
              <ResultPanel result={selected} />
            </>
          ) : (
            <p className="empty">选择一条记录查看详情。</p>
          )}
        </section>
      </div>
    </div>
  )
}
