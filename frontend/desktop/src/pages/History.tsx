import { useEffect, useMemo, useState } from 'react'
import { ResultPanel } from '@/components/ResultPanel'
import { AudioPlayer } from '@/components/AudioPlayer'
import { useASRStore, type HistoryItem } from '@/store/useASRStore'
import './History.css'

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
  const setPage = useASRStore((state) => state.setPage)
  const [selectedId, setSelectedId] = useState(history[0]?.id || '')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [undo, setUndo] = useState<{ removed: HistoryItem[]; order: string[] } | null>(null)
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
  const removeSelected = () => {
    if (!selected) return
    setUndo({ removed: [selected], order: history.map(item => item.id) })
    removeHistory(selected.id)
  }
  const undoDelete = () => {
    if (!undo) return
    useASRStore.setState(state => {
      const current = new Map(state.history.map(item => [item.id, item]))
      undo.removed.forEach(item => { if (!current.has(item.id)) current.set(item.id, item) })
      const previous = new Set(undo.order)
      return { history: [...state.history.filter(item => !previous.has(item.id)), ...undo.order.flatMap(id => current.has(id) ? [current.get(id)!] : [])] }
    })
    setSelectedId(undo.removed[0]?.id || '')
    setUndo(null)
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
          <button type="button" className="danger" disabled={!history.length} onClick={() => setConfirmClear(true)}>清空全部记录</button>
        </div>
      </header>

      <div className="history-overview"><span>显示 <strong>{filteredHistory.length}</strong> / {history.length} 条</span><span>累计 {Math.round(totalDuration / 60)} 分钟</span><span>润色/翻译 {enhancedCount} 条</span></div>
      {confirmClear && <section className="history-confirm" role="alertdialog" aria-labelledby="history-clear-title" aria-describedby="history-clear-description">
        <div><strong id="history-clear-title">清空全部 {history.length} 条记录？</strong><p id="history-clear-description">这会清空本机历史列表，保留已经导出的文件。</p></div>
        <button type="button" onClick={() => setConfirmClear(false)}>取消</button>
        <button type="button" className="danger" onClick={() => { setUndo({ removed: history, order: history.map(item => item.id) }); clearHistory(); setConfirmClear(false) }}>确认清空</button>
      </section>}
      {undo && <div className="history-undo" role="status"><span>已删除 {undo.removed.length} 条记录</span><button type="button" onClick={undoDelete}>撤销删除</button></div>}

      <div className="history-workspace">
        <section className="panel history-list">
          <div className="filter-row">
            <input aria-label="搜索历史记录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、内容或引擎" />
            <select aria-label="筛选语言" value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="all">全部语言</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
            <label className="date-filter">从 <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
            <label className="date-filter">到 <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
          </div>
          {filteredHistory.length === 0 && <div className="empty"><p>{history.length ? '当前条件下暂无历史记录。' : '还没有记录，先完成一次录音或文件转写。'}</p>{history.length ? <button onClick={clearFilters}>重置筛选</button> : <button onClick={() => setPage('transcribe')}>开始语音识别</button>}</div>}
          {filteredHistory.map((item) => (
            <button key={item.id} type="button" className={selected?.id === item.id ? 'history-item active' : 'history-item'} onClick={() => select(item)}>
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
                  <button type="button" className="danger" onClick={removeSelected}>删除此记录</button>
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
