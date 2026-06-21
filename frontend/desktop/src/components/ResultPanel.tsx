import { useState } from 'react'
import { copyText, resultToJson, resultToTxt, saveResult, saveText, segmentsToSrt } from '@/services/export'
import type { LLMOperation, TranscribeResponse } from '@/services/api'
import { SegmentList } from './SegmentList'
import { TabBar } from './TabBar'

type ResultTab = 'text' | 'polish' | 'translate' | 'segments' | 'json'

type ResultPanelProps = {
  result: TranscribeResponse | null
  onProcess?: (operation: LLMOperation) => void | Promise<void>
  processingOperation?: LLMOperation | 'idle'
}

export function ResultPanel({ result, onProcess, processingOperation = 'idle' }: ResultPanelProps) {
  const [tab, setTab] = useState<ResultTab>('text')

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
  const activeText = tab === 'polish' ? polishedText : tab === 'translate' ? translatedText : text
  const activeSuffix = tab === 'polish' ? 'polished' : tab === 'translate' ? 'translated' : 'text'
  const canProcess = Boolean(onProcess && text.trim())

  return (
    <section className="result-panel">
      <div className="result-head">
        <div>
          <h2>识别结果</h2>
          <p>{result.engine_used || 'unknown'} · {result.duration_sec ? `${result.duration_sec.toFixed(1)}s` : '时长未知'}</p>
        </div>
        <div className="result-actions">
          <button type="button" disabled={!canProcess || processingOperation !== 'idle'} onClick={() => onProcess?.('polish')}>
            {processingOperation === 'polish' ? '润色中' : '润色'}
          </button>
          <button type="button" disabled={!canProcess || processingOperation !== 'idle'} onClick={() => onProcess?.('translate')}>
            {processingOperation === 'translate' ? '翻译中' : '翻译'}
          </button>
          <button type="button" disabled={!activeText} onClick={() => copyText(activeText)}>复制</button>
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
          { value: 'polish', label: polishedText ? '润色' : '润色+' },
          { value: 'translate', label: translatedText ? '翻译' : '翻译+' },
          { value: 'segments', label: '分段' },
          { value: 'json', label: 'JSON' }
        ]}
      />
      {tab === 'text' && <pre className="result-text">{text}</pre>}
      {tab === 'polish' && (
        polishedText ? <pre className="result-text">{polishedText}</pre> : <p className="empty">暂无润色结果。</p>
      )}
      {tab === 'translate' && (
        translatedText ? <pre className="result-text">{translatedText}</pre> : <p className="empty">暂无翻译结果。</p>
      )}
      {result.llm_error && <p className="error">{result.llm_error}</p>}
      {tab === 'segments' && <SegmentList segments={result.segments} />}
      {tab === 'json' && <pre className="result-text">{resultToJson(result)}</pre>}
    </section>
  )
}
