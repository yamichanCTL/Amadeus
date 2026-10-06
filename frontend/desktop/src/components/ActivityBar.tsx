import { useState } from 'react'
import { useActivityStore, type ActivityTask } from '@/services/activity'
import { useASRStore } from '@/store/useASRStore'
import { recordingService } from '@/services/recordingService'
import { liveCaptionService } from '@/services/liveCaption'
import { audioRelayMixer } from '@/services/audio'

function ActivityItem({ task }: { task: ActivityTask }) {
  const setPage = useASRStore((s) => s.setPage)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    if (!task.onStop || stopping) return
    setStopping(true); setError('')
    try { await task.onStop() } catch (e) { setError(e instanceof Error ? e.message : '停止失败，请重试') }
    finally { setStopping(false) }
  }
  return <div className="activity-item"><span className="activity-dot" /><div><strong>{task.label}</strong>{task.detail && <small>{task.detail}</small>}{error && <small role="alert">{error}</small>}</div>
    {task.page && <button onClick={() => setPage(task.page!)}>查看</button>}
    {task.onStop && <button onClick={() => void stop()} disabled={stopping}>{stopping ? '正在停止' : '停止'}</button>}
  </div>
}
export function ActivityBar() {
  const tasks = useActivityStore((s) => s.tasks)
  const record = useASRStore((s) => s.recordStatus)
  const transcribe = useASRStore((s) => s.transcribeStatus)
  const live = useASRStore((s) => s.liveCaptionStatus)
  const batch = useASRStore((s) => s.fileBatchRunning)
  const relay = useASRStore((s) => s.settings.audioRelayEnabled)
  const asrBusy = record === 'recording' || record === 'processing' || ['uploading','processing','polling'].includes(transcribe) || batch
  const entries: Array<[string, ActivityTask]> = Object.entries(tasks)
  if (asrBusy) entries.push(['asr-global', { label: record === 'recording' ? '正在录音' : batch ? '正在批量转写' : '正在识别语音', page: 'transcribe', detail: '切换页面后任务继续', onStop: () => recordingService.forceStop() }])
  if (!['idle','error'].includes(live)) entries.push(['caption-global', { label: live === 'connecting' ? '正在连接实时字幕' : live === 'stopping' ? '正在停止字幕' : '实时字幕已开启', page: 'transcribe', onStop: () => liveCaptionService.stop() }])
  if (relay && !tasks['voice-relay']) entries.push(['relay-global', { label: '麦克风中转已开启', detail: '音频正在发送到所选输出设备', page: 'settings', onStop: () => { audioRelayMixer.stop(); useASRStore.getState().updateSettings({ audioRelayEnabled: false }) } }])
  if (!entries.length) return null
  return <section className="activity-bar" aria-label="正在运行的任务">{entries.map(([id,task]) => <ActivityItem key={id} task={task} />)}</section>
}
