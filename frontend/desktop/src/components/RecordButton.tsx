import { useASRStore } from '@/store/useASRStore'

export function RecordButton({ onToggle }: { onToggle: () => void }) {
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const disabled = liveCaptionStatus !== 'idle'

  return (
    <button type="button" className={`record-button ${recordStatus}`} disabled={disabled} onClick={onToggle}>
      <span>{recordStatus === 'recording' ? '■' : '●'}</span>
      {recordStatus === 'recording' ? '停止并转写' : recordStatus === 'processing' ? '处理中' : '开始录音'}
    </button>
  )
}
