import { useEffect, useState } from 'react'
import { copyText, resultToJson, resultToTxt, saveResult, saveText, segmentsToSrt } from '@/services/export'
import type { LLMOperation, TranscribeResponse } from '@/services/api'
import { SegmentList } from './SegmentList'
import { TabBar } from './TabBar'
import './ResultPanel.css'

type ResultTab = 'text' | 'enhance' | 'segments' | 'json'

type ResultPanelProps = {
  result: TranscribeResponse | null
  onProcess?: (operation: LLMOperation) => void | Promise<void>
  processingOperation?: LLMOperation | 'idle'
}

export function ResultPanel({ result, onProcess, processingOperation = 'idle' }: ResultPanelProps) {
  const [tab, setTab] = useState<ResultTab>('text')
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => { setCopied(false); setActionError('') }, [result?.task_id, tab])

  if (!result) {
    return (
      <section className="result-panel empty-panel">
        <p>转写结果会显示在这里。</p>
      </section>
    )
  }

  const text = resultToTxt(result)
  const polishedText = result.llm_outputs?.polish?.text || ''
  const translatedText = result.llm_outputs?.translate?.text || ''
  const enhancedText = polishedText || translatedText
  const activeText = tab === 'enhance' ? enhancedText : tab === 'json' ? resultToJson(result) : tab === 'segments' ? segmentsToSrt(result.segments) : text
  const activeSuffix = tab === 'enhance' ? 'enhanced' : tab === 'segments' ? 'segments' : tab === 'json' ? 'result' : 'text'
  const activeLabel = tab === 'enhance' ? '润色/翻译' : tab === 'segments' ? '分段字幕' : tab === 'json' ? 'JSON' : '原文'
  const canProcess = Boolean(onProcess && text.trim())
  const handleCopy = async () => {
    if (!activeText) return
    try {
      await copyText(activeText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch { setActionError('复制失败，请重试。') }
  }

  return (
    <section className="result-panel">
      <div className="result-head">
        <div>
          <h2>识别结果</h2>
          <p>{result.engine_used || 'unknown'} · {result.duration_sec ? `${result.duration_sec.toFixed(1)}s` : '时长未知'}</p>
        </div>
        <div className="result-actions">
          {onProcess && <button type="button" disabled={!canProcess || processingOperation !== 'idle'} onClick={() => onProcess?.('polish')}>
            {processingOperation !== 'idle' ? '处理中' : '润色/翻译'}
          </button>}
          <button type="button" disabled={!activeText} onClick={() => void handleCopy()}>{copied ? '已复制' : '复制当前'}</button>
          <details className="result-export-menu">
            <summary>导出</summary>
            <div>
              <button type="button" disabled={!activeText} onClick={() => void saveText(activeText, `${result.task_id}_${activeSuffix}.${tab === 'json' ? 'json' : tab === 'segments' ? 'srt' : 'txt'}`)}>当前{activeLabel}</button>
              <button type="button" onClick={() => void saveResult(result, `${result.task_id}.txt`, 'txt')}>原文 TXT</button>
              <button type="button" onClick={() => void saveResult(result, `${result.task_id}.srt`, 'srt')}>字幕 SRT</button>
              <button type="button" onClick={() => void saveResult(result, `${result.task_id}.json`, 'json')}>完整 JSON</button>
            </div>
          </details>
        </div>
      </div>
      <TabBar
        value={tab}
        onChange={setTab}
        items={[
          { value: 'text', label: '原文' },
          { value: 'enhance', label: enhancedText ? '润色/翻译' : '润色/翻译+' },
          { value: 'segments', label: '分段' },
          { value: 'json', label: 'JSON' }
        ]}
      />
      <p className="result-current-label">复制当前内容：{activeLabel}</p>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {tab === 'text' && <pre className="result-text">{text}</pre>}
      {tab === 'enhance' && (
        enhancedText ? <pre className="result-text">{enhancedText}</pre> : <p className="empty">暂无润色/翻译结果。</p>
      )}
      {result.llm_error && <p className="error">{result.llm_error}</p>}
      {tab === 'segments' && <SegmentList segments={result.segments} />}
      {tab === 'json' && <pre className="result-text">{resultToJson(result)}</pre>}
    </section>
  )
}
