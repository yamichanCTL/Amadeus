import { useASRStore } from '@/store/useASRStore'

export function StatusBar() {
  const settings = useASRStore((state) => state.settings)
  const transcribeStatus = useASRStore((state) => state.transcribeStatus)
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)

  return (
    <footer className="statusbar">
      <span>{settings.serverUrl}</span>
      <span>转写：{transcribeStatus}</span>
      <span>录音：{recordStatus}</span>
      <span>字幕：{liveCaptionStatus}</span>
    </footer>
  )
}
