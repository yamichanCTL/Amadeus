import { useEffect, useRef, useState } from 'react'
import { StreamingASRClient, captureSpeakerAudio } from '@/services/audio'
import { streamCodexExplanation, type CodexReply } from '@/services/codex'
import { latestMeetingExcerpt, meetingKeyword, selectMeetingExcerpt, MeetingTimeline, readMeetingPreferences, MEETING_PREFERENCES_KEY, shortcutFromEvent, shortcutLabel, type MeetingPreferences, type MeetingExcerpt } from '@/services/meeting'
import { useASRStore } from '@/store/useASRStore'

export function MeetingAssistPanel({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const settings = useASRStore((state) => state.settings)
  const [listening, setListening] = useState(false)
  const [starting, setStarting] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [excerpt, setExcerpt] = useState<MeetingExcerpt>({ target: '', preceding: '' })
  const [selected, setSelected] = useState<MeetingExcerpt | null>(null)
  const [preferences, setPreferences] = useState(readMeetingPreferences)
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const shortcutCaptureRef = useRef(false)
  const timeline = useRef(new MeetingTimeline())
  const savePreferences = (next: MeetingPreferences) => {
    preferencesRef.current = next
    setPreferences(next)
    try { localStorage.setItem(MEETING_PREFERENCES_KEY, JSON.stringify(next)) } catch { /* unavailable storage */ }
  }
  const updatePreference = <K extends keyof MeetingPreferences>(key: K, value: MeetingPreferences[K]) => {
    const next = { ...readMeetingPreferences(), [key]: value }
    next.recentSeconds = Math.min(next.recentSeconds, next.lookbackSeconds)
    savePreferences(next)
  }
  useEffect(() => {
    // Fast Refresh retains useState values. Read persisted settings again instead
    // of writing an old render's settings over a newly migrated version.
    setPreferences(readMeetingPreferences())
    const changed = (event: StorageEvent) => {
      if (event.key === MEETING_PREFERENCES_KEY || event.key === null) setPreferences(readMeetingPreferences())
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const [explaining, setExplaining] = useState(false)
  const [answer, setAnswer] = useState<{ target: string; context: string; result: CodexReply | null; text: string; streaming: boolean } | null>(null)
  const [error, setError] = useState('')
  const [captureStatus, setCaptureStatus] = useState('')
  const streamRef = useRef<StreamingASRClient | null>(null)
  const transcriptRef = useRef('')
  const keywordCount = useRef(0)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const requestRef = useRef<AbortController | null>(null)
  const explainRef = useRef<(snapshot: MeetingExcerpt) => void>(() => {})
  const recentSnapshot = () => timeline.current.excerpt(performance.now(), preferencesRef.current, undefined,
    preferencesRef.current.keywordEnabled ? preferencesRef.current.keyword : '')

  useEffect(() => { onBusy(listening || starting || explaining) }, [listening, starting, explaining, onBusy])
  useEffect(() => {
    alive.current = true
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return
      if (shortcutCaptureRef.current) {
        event.preventDefault(); event.stopPropagation()
        if (event.code === 'Escape') { shortcutCaptureRef.current = false; setRecordingShortcut(false); return }
        const shortcut = shortcutFromEvent(event)
        if (shortcut) {
          savePreferences({ ...readMeetingPreferences(), shortcut })
          shortcutCaptureRef.current = false; setRecordingShortcut(false)
        }
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const current = preferencesRef.current
      if (current.shortcutEnabled && shortcutFromEvent(event) === current.shortcut) {
        event.preventDefault()
        explainRef.current(recentSnapshot())
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      alive.current = false
      streamRef.current?.stop(); streamRef.current = null
      requestRef.current?.abort()
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  const explain = async (snapshot: MeetingExcerpt) => {
    if (busyRef.current) return
    if (!snapshot.target.trim()) { setError('所选回看时段内还没有可解释的原话。请先旁听，再触发。'); return }
    const frozen = { ...snapshot }
    const current = { ...preferencesRef.current }
    const context = current.useContext ? frozen.preceding : ''
    busyRef.current = true; setExplaining(true); setError(''); setExcerpt(frozen)
    setAnswer({ target: frozen.target, context, result: null, text: '', streaming: true })
    const controller = new AbortController(); requestRef.current = controller
    try {
      const response = await streamCodexExplanation(settings.serverUrl, {
        target: frozen.target, preceding_context: context, recent_excerpt: frozen.recent || '',
        focus: frozen.focus || 'target', preset_prompt: current.presetPrompt, focus_points: current.focusPoints,
        lookback_seconds: current.lookbackSeconds, recent_seconds: current.recentSeconds, recent_weight: current.recentWeight,
        model: settings.codexModel || undefined, effort: settings.codexEffort || undefined,
      }, controller.signal, (text) => {
        if (alive.current) setAnswer((previous) => previous ? { ...previous, text: (previous.text + text).slice(-64000) } : previous)
      })
      if (!alive.current) return
      setAnswer((previous) => ({ ...response, context, text: response.result.text || previous?.text || '', streaming: false }))
      if (response.result.status !== 'completed') setError(response.result.error || '解释未完成，请重试。')
    } catch (cause) {
      if (alive.current) {
        setAnswer((previous) => previous ? { ...previous, streaming: false } : previous)
        setError(controller.signal.aborted ? '已停止生成，已收到的文字保留。' : cause instanceof Error ? cause.message : '解释失败')
      }
    } finally {
      busyRef.current = false
      if (alive.current) setExplaining(false)
    }
  }
  explainRef.current = (snapshot) => { void explain(snapshot) }
  const stop = () => {
    const stream = streamRef.current; streamRef.current = null
    stream?.stop(); setListening(false); setStarting(false)
  }
  const start = async () => {
    if (streamRef.current || starting) return
    setError(''); setStarting(true); setTranscript(''); transcriptRef.current = ''; keywordCount.current = 0
    setSelected(null); setCaptureStatus(''); setExcerpt({ target: '', preceding: '' }); timeline.current = new MeetingTimeline()
    const stream = new StreamingASRClient(settings.serverUrl, (event) => {
      if (!alive.current || streamRef.current !== stream) return
      if (event.type === 'configured') { setStarting(false); setListening(true) }
      if (event.type === 'partial' || event.type === 'final') {
        const now = performance.now()
        timeline.current.update(event.text, now)
        const text = timeline.current.text
        transcriptRef.current = text; setTranscript(text)
        const current = preferencesRef.current
        if (current.keywordEnabled) {
          const found = meetingKeyword(event.text, current.keyword)
          if (found && found.count > keywordCount.current) {
            keywordCount.current = found.count
            if (busyRef.current) setError('正在解释上一段；这次口令未提交，可稍后选择原文解释。')
            else explainRef.current(timeline.current.excerpt(now, current, Math.max(0, found.start - timeline.current.offset), current.keyword))
          }
        }
      }
      if (event.type === 'error') { setError(event.message); stop() }
      if (event.type === 'closed') {
        streamRef.current = null; setListening(false); setStarting(false)
        if (!event.intentional) setError('会议音频连接已断开，点击开始旁听重试。')
      }
    })
    streamRef.current = stream
    try {
      const speaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      const inputStream = speaker ? await captureSpeakerAudio() : undefined
      if (!alive.current || streamRef.current !== stream) { inputStream?.getTracks().forEach((track) => track.stop()); return }
      await stream.start({
        engine: settings.streamingEngine, language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
        deviceId: speaker ? undefined : settings.audioInputDeviceId || undefined, inputStream,
        userId: settings.userId || undefined, archive: false, recordAudio: false,
        endpointing: 'manual', echoCancellation: !speaker,
        onCaptureSettings: (state) => { if (alive.current && streamRef.current === stream) setCaptureStatus(`麦克风回声消除：${state.mode === 'all' || state.mode === 'browser' ? '已启用' : '设备未确认启用'}`) },
      })
    } catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : '旁听启动失败'); stop() } }
  }

  return <div className="meeting-assist">
    <div className="agent-actions">
      <button type="button" disabled={!settings.backendConfirmed} onClick={() => listening || starting ? stop() : void start()}>{starting ? '取消启动' : listening ? '停止旁听' : '开始旁听'}</button>
      <span role="status">{listening ? '持续旁听中' : starting ? '正在连接音频…' : '旁听已停止'}{explaining ? ' · 正在解释，识别继续' : ''}</span>
    </div>
    <p>触发时回看之前 {preferences.lookbackSeconds} 秒的会议内容，立即交给 Agent 总结和解释。回答以流式文字显示，旁听不中断。</p>
    <p>{preferences.shortcutEnabled ? `快捷键：${shortcutLabel(preferences.shortcut)}（页面有焦点且未编辑文本时）` : '快捷键已关闭'}</p>
    <p>音源沿用设置中的输入设备。ASR 可能修订文字或缺少标点，可选中原文或编辑截取结果。</p>
    {captureStatus && <small>{captureStatus}</small>}
    <label>会议实时转写
      <textarea aria-label="会议实时转写" readOnly value={transcript} rows={5} onSelect={(event) => {
        const el = event.currentTarget
        if (el.selectionEnd > el.selectionStart) setSelected(selectMeetingExcerpt(el.value, el.selectionStart, el.selectionEnd))
      }} />
    </label>
    <div className="agent-actions">
      <button type="button" disabled={!transcript.trim() || explaining || !settings.backendConfirmed} onClick={() => void explain(recentSnapshot())}>解释最近一段</button>
      <button type="button" disabled={!transcript.trim() || explaining} onClick={() => setExcerpt(latestMeetingExcerpt(transcriptRef.current))}>截取最近一句</button>
      <button type="button" disabled={!selected?.target || explaining} onClick={() => selected && void explain(selected)}>解释选中内容</button>
    </div>
    {selected && <small>选中原文：{selected.target}</small>}
    <label>本次解释原文（可修改）<textarea aria-label="本次解释原文" value={excerpt.target} rows={4} maxLength={96000} disabled={explaining} onChange={(event) => setExcerpt((current) => ({ ...current, target: event.target.value, focus: undefined, recent: undefined }))} /></label>
    {excerpt.focus === 'recent_window' && <details><summary>查看临近触发的重点片段</summary><p>{excerpt.recent || '所设末尾时段内没有新内容，将参考整段。'}</p></details>}
    {preferences.useContext && <details><summary>查看将附带的前文</summary><p>{excerpt.preceding || '无前文'}</p></details>}
    <button type="button" className="primary" disabled={!excerpt.target.trim() || explaining || !settings.backendConfirmed} onClick={() => void explain(excerpt)}>{explaining ? '正在解释…' : '解释这段原话'}</button>
    {excerpt.truncated && <p role="status">所选时段的文本超过保留上限，本次仅包含最近 96,000 字符。</p>}
    {explaining && <button type="button" onClick={() => requestRef.current?.abort()}>停止生成</button>}
    {answer && <article className="agent-message assistant meeting-answer"><strong>针对这段原话的解释</strong><blockquote>{answer.target}</blockquote><p data-testid="meeting-stream-output" aria-live="polite">{answer.text || answer.result?.text || answer.result?.error || (answer.streaming ? '等待 Agent 输出…' : '暂无输出')}</p>{answer.streaming && <small>正在流式生成…</small>}<small>{answer.context ? '本次附带了前文' : '本次仅解释原文'} · {answer.result?.usage ? `${answer.result.usage.total_tokens} tokens` : '用量暂不可用'}</small></article>}
    <fieldset className="meeting-preferences">
      <legend>解释与触发设置（自动保存在本机）</legend>
      <div className="meeting-preference-grid">
        <label>回看时长（秒）<input aria-label="回看时长（秒）" type="number" min={10} max={3600} value={preferences.lookbackSeconds} onChange={(e) => updatePreference('lookbackSeconds', Math.max(10, Math.min(3600, Math.round(Number(e.target.value)) || 3600)))} /></label>
        <label>重点关注末尾（秒）<input aria-label="重点关注末尾（秒）" type="number" min={5} max={preferences.lookbackSeconds} value={preferences.recentSeconds} onChange={(e) => updatePreference('recentSeconds', Math.max(5, Math.min(preferences.lookbackSeconds, Math.round(Number(e.target.value)) || 60)))} /></label>
        <label>末尾关注程度<select aria-label="末尾关注程度" value={preferences.recentWeight} onChange={(e) => updatePreference('recentWeight', Number(e.target.value))}>
          <option value={1}>1 · 均衡关注整段</option><option value={2}>2 · 略偏重末尾</option><option value={3}>3 · 优先末尾</option><option value={4}>4 · 明显偏重末尾</option><option value={5}>5 · 主要解释末尾</option>
        </select></label>
      </div>
      <small>回看按 ASR 文字首次出现时间近似截取，原文最多 96,000 字符；末尾重点最多 8,000 字符。关注程度会写入 Agent 提示，不是精确的模型权重。</small>
      <label>预置提示词<textarea aria-label="预置提示词" rows={3} maxLength={4000} value={preferences.presetPrompt} placeholder="例如：我了解后端开发，但不熟悉金融。请解释会议中的金融术语，并联系软件系统举例。" onChange={(e) => updatePreference('presetPrompt', e.target.value)} /></label>
      <label>关注要点<textarea aria-label="关注要点" rows={3} maxLength={2000} value={preferences.focusPoints} placeholder="每行一个关注点，例如：业务含义、技术取舍、对我的任务有何影响。" onChange={(e) => updatePreference('focusPoints', e.target.value)} /></label>
      <label className="meeting-inline"><input type="checkbox" checked={preferences.useContext} onChange={(e) => updatePreference('useContext', e.target.checked)} />附带会议前文帮助 Agent 理解（最多 8,000 字符）</label>
      <label className="meeting-inline"><input type="checkbox" checked={preferences.shortcutEnabled} onChange={(e) => updatePreference('shortcutEnabled', e.target.checked)} />启用解释快捷键</label>
      <button type="button" disabled={!preferences.shortcutEnabled} onClick={() => { shortcutCaptureRef.current = !shortcutCaptureRef.current; setRecordingShortcut(shortcutCaptureRef.current) }}>{recordingShortcut ? '取消快捷键录制' : `设置快捷键：${shortcutLabel(preferences.shortcut)}`}</button>
      {recordingShortcut && <p role="status">请按新组合键，需含 Ctrl、Alt 或 Meta 加字母、数字或功能键；Esc 取消。浏览器或系统保留的快捷键可能无法使用。</p>}
      <label className="meeting-inline"><input type="checkbox" checked={preferences.keywordEnabled} disabled={listening || starting} onChange={(e) => updatePreference('keywordEnabled', e.target.checked)} />语音口令触发</label>
      {preferences.keywordEnabled && <><input aria-label="解释口令" value={preferences.keyword} maxLength={60} disabled={listening || starting} onChange={(e) => updatePreference('keyword', e.target.value)} /><small>匹配忽略标点、空格、大小写和全半角；只总结口令前的内容，口令及其后话语不进入本次请求。任何被采集的说话人都可能触发。</small></>}
    </fieldset>

    {error && <p className="error">{error}</p>}
  </div>
}
