import { useMemo, useState } from 'react'
import { ResultPanel } from '@/components/ResultPanel'
import { copyText, saveResult } from '@/services/export'
import { useASRStore, type HistoryItem } from '@/store/useASRStore'

export function HistoryPage() {
  const history = useASRStore((state) => state.history)
  const removeHistory = useASRStore((state) => state.removeHistory)
  const clearHistory = useASRStore((state) => state.clearHistory)
  const setCurrentResult = useASRStore((state) => state.setCurrentResult)
  const [selectedId, setSelectedId] = useState(history[0]?.id || '')
  const selected = useMemo(() => history.find((item) => item.id === selectedId) || history[0] || null, [history, selectedId])

  const select = (item: HistoryItem) => {
    setSelectedId(item.id)
    setCurrentResult(item)
  }

  const totalDuration = history.reduce((sum, item) => sum + (item.duration_sec || 0), 0)
  const enhancedCount = history.filter((item) => item.llm_outputs?.polish || item.llm_outputs?.translate).length

  return (
    <div className="page history-page">
      <header className="page-heading">
        <div>
          <h1>历史记录</h1>
          <p>查看转写结果、语音会话与导出记录。</p>
        </div>
        <button type="button" className="danger" disabled={!history.length} onClick={clearHistory}>清空筛选</button>
      </header>

      <section className="history-stats">
        <article className="stat-card">
          <span>本周转写次数</span>
          <strong>{history.length}</strong>
          <small>较上周 ↑ 16%</small>
        </article>
        <article className="stat-card">
          <span>累计识别时长</span>
          <strong>{Math.max(1, Math.round(totalDuration / 60))}<small>分</small></strong>
          <small>自动归档</small>
        </article>
        <article className="stat-card">
          <span>大模型增强</span>
          <strong>{enhancedCount}</strong>
          <small>润色 / 翻译</small>
        </article>
        <article className="stat-card">
          <span>默认引擎</span>
          <strong>{history[0]?.engine_used || 'ASR'}</strong>
          <small>当前会话</small>
        </article>
      </section>

      <div className="history-workspace">
        <section className="panel history-list">
          <div className="filter-row">
            <input placeholder="搜索标题、内容或关键词..." />
            <select defaultValue="all">
              <option value="all">全部语言</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
          </div>
          {history.length === 0 && <p className="empty">暂无历史记录。</p>}
          {history.map((item) => (
            <button key={item.id} type="button" className={selected?.id === item.id ? 'history-item active' : 'history-item'} onClick={() => select(item)}>
              <span className="play-dot">▶</span>
              <time>{new Date(item.created_at).toLocaleDateString()}</time>
              <strong>{item.filename}</strong>
              <small>{item.full_text.slice(0, 72)}</small>
              <em>{item.llm_outputs?.translate ? '翻译' : item.llm_outputs?.polish ? '润色' : item.engine_used}</em>
            </button>
          ))}
        </section>
        <section className="panel history-detail">
          {selected ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>{selected.filename}</h2>
                  <p>{new Date(selected.created_at).toLocaleString()} · 时长 {selected.duration_sec ? `${selected.duration_sec.toFixed(1)}s` : '未知'}</p>
                </div>
                <div className="result-actions">
                  <button type="button" onClick={() => copyText(selected.full_text)}>复制</button>
                  <button type="button" onClick={() => saveResult(selected, `${selected.task_id}.txt`, 'txt')}>TXT</button>
                  <button type="button" onClick={() => saveResult(selected, `${selected.task_id}.srt`, 'srt')}>SRT</button>
                  <button type="button" className="danger" onClick={() => removeHistory(selected.id)}>删除</button>
                </div>
              </div>
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
