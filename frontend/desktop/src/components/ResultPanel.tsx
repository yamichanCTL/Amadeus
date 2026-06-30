import { useEffect, useState } from 'react'
import { copyText, resultToJson, resultToTxt, saveResult, saveText, segmentsToSrt } from '@/services/export'
import type { LLMOperation, TranscribeResponse } from '@/services/api'
import { SegmentList } from './SegmentList'
import { TabBar } from './TabBar'

type ResultTab = 'text' | 'enhance' | 'segments' | 'json'

type ResultPanelProps = {
  result: TranscribeResponse | null
  onProcess?: (operation: LLMOperation) => void | Promise<void>
  processingOperation?: LLMOperation | 'idle'
}

export function ResultPanel({ result, onProcess, processingOperation = 'idle' }: ResultPanelProps) {
  const [tab, setTab] = useState<ResultTab>('text')
  const [copied, setCopied] = useState(false)

  useEffect(() => setCopied(false), [result?.task_id, tab])

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
  const activeText = tab === 'enhance' ? enhancedText : text
  const activeSuffix = tab === 'enhance' ? 'enhanced' : 'text'
  const canProcess = Boolean(onProcess && text.trim())
  const handleCopy = () => {
    if (!activeText) return
    setCopied(true)
    void copyText(activeText)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <section className="result-panel">
      <div className="result-head">
        <div>
          <h2>识别结果</h2>
          <p>{result.engine_used || 'unknown'} · {result.duration_sec ? `${result.duration_sec.toFixed(1)}s` : '时长未知'}</p>
        </div>
        <div className="result-actions">
          <button type="button" disabled={!canProcess || processingOperation !== 'idle'} onClick={() => onProcess?.('polish')}>
            {processingOperation !== 'idle' ? '处理中' : '润色/翻译'}
          </button>
          <button type="button" disabled={!activeText} onClick={handleCopy}>{copied ? '已复制' : '复制'}</button>
          <button type="button" disabled={!activeText} onClick={() => saveText(activeText, `${result.task_id}_${activeSuffix}.txt`)}>当前TXT</button>
          <button type="button" onClick={() => saveResult(result, `${result.task_id}.txt`, 'txt')}>TXT</button>
          <button type="button" onClick={() => saveResult(result, `${result.task_id}.srt`, 'srt')}>SRT</button>
          <button type="button" onClick={() => saveResult(result, `${result.task_id}.json`, 'json')}>JSON</button>
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
