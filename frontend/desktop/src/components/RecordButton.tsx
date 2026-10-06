import { useASRStore } from '@/store/useASRStore'

export function RecordButton({ onToggle }: { onToggle: () => void }) {
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const transcribeStatus = useASRStore((state) => state.transcribeStatus)
  const fileBatchRunning = useASRStore((state) => state.fileBatchRunning)
  const modelLoading = useASRStore((state) => state.asrModelLoading)
  const disabled = modelLoading || liveCaptionStatus !== 'idle' || recordStatus === 'processing' || fileBatchRunning
    || ['uploading', 'processing', 'polling'].includes(transcribeStatus)

  return (
    <button type="button" className={`record-button ${recordStatus}`} disabled={disabled} onClick={onToggle}>
      <span>{recordStatus === 'recording' ? '■' : '●'}</span>
      {recordStatus === 'recording' ? '停止并转写' : recordStatus === 'processing' ? '处理中' : '开始录音'}
    </button>
  )
}
