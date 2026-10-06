import { useASRStore } from '@/store/useASRStore'
export function StatusBar() {
  const record = useASRStore((s) => s.recordStatus)
  const live = useASRStore((s) => s.liveCaptionStatus)
  const modelLoading = useASRStore((s) => s.asrModelLoading)
  return <footer className="statusbar"><span>Amadeus · 语音工作台</span><span>{modelLoading ? '识别模型正在加载' : record === 'recording' ? '麦克风正在录音' : !['idle','error'].includes(live) ? '实时字幕正在使用音频输入' : '就绪'}</span></footer>
}
