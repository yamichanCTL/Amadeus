import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, HiggsAudioResult, HiggsTTSRequest } from '@/services/api'
import { VoiceTTSStreamingClient, listAudioOutputDevices, playAudioBlob } from '@/services/audio'
import { useASRStore } from '@/store/useASRStore'

type VoiceMode = 'voice' | 'text' | 'realtime'
type WorkStatus = 'idle' | 'recording' | 'processing' | 'streaming' | 'done' | 'error'

type TimingRow = {
  label: string
  value: number
  detail?: string
}

const modeLabels: Record<VoiceMode, string> = {
  voice: '语音转 TTS',
  text: '文字转 TTS',
  realtime: '实时 ASR + TTS'
}

function roundSec(value?: number) {
  if (!Number.isFinite(value || 0)) return 0
  return Math.round((value || 0) * 1000) / 1000
}

function formatSec(value: number) {
  return value > 0 ? `${roundSec(value).toFixed(3)}s` : '-'
}

export function VoiceChangerPage() {
  const settings = useASRStore((s) => s.settings)
  const updateSettings = useASRStore((s) => s.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const streamClientRef = useRef<VoiceTTSStreamingClient | null>(null)
  const playbackRef = useRef<HTMLAudioElement | null>(null)
  const playbackUrlRef = useRef('')
  const inputAudioUrlRef = useRef('')
  const outputAudioUrlRef = useRef('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [mode, setMode] = useState<VoiceMode>('voice')
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [ttsText, setTtsText] = useState('你好，这是 Higgs Audio v3 的桌面端 TTS 测试。')
  const [transcript, setTranscript] = useState('')
  const [partialText, setPartialText] = useState('')
  const [inputAudioUrl, setInputAudioUrl] = useState('')
  const [outputAudioUrl, setOutputAudioUrl] = useState('')
  const [status, setStatus] = useState<WorkStatus>('idle')
  const [statusText, setStatusText] = useState('等待输入')
  const [error, setError] = useState('')
  const [timings, setTimings] = useState<TimingRow[]>([])
  const [health, setHealth] = useState('')
  const [liveSegments, setLiveSegments] = useState<Array<{ text: string; timing: number }>>([])
  const [activeVoice, setActiveVoice] = useState(settings.higgsTtsVoice || 'default')

  useEffect(() => {
    setActiveVoice(settings.higgsTtsVoice || 'default')
  }, [settings.higgsTtsVoice])

  const commonPayload = useCallback((): Omit<HiggsTTSRequest, 'text'> => ({
    higgs_base_url: settings.higgsTtsBaseUrl,
    voice: activeVoice || settings.higgsTtsVoice || 'default',
    response_format: settings.higgsTtsFormat,
    speed: settings.higgsTtsSpeed,
    temperature: settings.higgsTtsTemperature,
    top_p: settings.higgsTtsTopP,
    top_k: settings.higgsTtsTopK,
    seed: settings.higgsTtsSeed,
    max_new_tokens: settings.higgsTtsMaxNewTokens,
    reference_audio: settings.higgsTtsReferenceAudioDataUrl,
    reference_url: settings.higgsTtsReferenceUrl,
    reference_text: settings.higgsTtsReferenceText,
    reference_codes_json: settings.higgsTtsReferenceCodesJson,
    emotion: settings.higgsTtsEmotion,
    style: settings.higgsTtsStyle,
    prosody_speed: settings.higgsTtsProsodySpeed,
    pitch: settings.higgsTtsPitch,
    expressiveness: settings.higgsTtsExpressiveness,
    initial_codec_chunk_frames: settings.higgsTtsInitialCodecChunkFrames,
    stream: false
  }), [
    settings.higgsTtsBaseUrl,
    activeVoice,
    settings.higgsTtsVoice,
    settings.higgsTtsFormat,
    settings.higgsTtsSpeed,
    settings.higgsTtsTemperature,
    settings.higgsTtsTopP,
    settings.higgsTtsTopK,
    settings.higgsTtsSeed,
    settings.higgsTtsMaxNewTokens,
    settings.higgsTtsReferenceAudioDataUrl,
    settings.higgsTtsReferenceUrl,
    settings.higgsTtsReferenceText,
    settings.higgsTtsReferenceCodesJson,
    settings.higgsTtsEmotion,
    settings.higgsTtsStyle,
    settings.higgsTtsProsodySpeed,
    settings.higgsTtsPitch,
    settings.higgsTtsExpressiveness,
    settings.higgsTtsInitialCodecChunkFrames
  ])

  const setOutputBlob = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    setOutputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [])

  const applyResult = useCallback((result: HiggsAudioResult, source: VoiceMode) => {
    setOutputBlob(result.audio)
    if (result.text && source !== 'realtime') setTranscript(result.text)
    setTimings([
      { label: 'ASR', value: roundSec(result.timing.asr_sec), detail: result.asr_engine || (source === 'text' ? '无需 ASR' : undefined) },
      { label: 'TTS', value: roundSec(result.timing.tts_sec), detail: activeVoice || settings.higgsTtsVoice || 'default' },
      { label: 'Higgs 网络', value: roundSec(result.timing.higgs_network_sec) },
      { label: '后端总计', value: roundSec(result.timing.total_sec) },
      { label: '前端端到端', value: roundSec(result.timing.client_total_sec) }
    ])
  }, [setOutputBlob, activeVoice, settings.higgsTtsVoice])

  const playResult = useCallback(async (blob?: Blob) => {
    const targetBlob = blob || (outputAudioUrl ? await fetch(outputAudioUrl).then((res) => res.blob()) : null)
    if (!targetBlob) return
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
    playbackRef.current?.pause()
    const playback = await playAudioBlob(targetBlob, settings.audioOutputDeviceId || undefined)
    playbackRef.current = playback.audio
    playbackUrlRef.current = playback.url
    playback.audio.onended = () => {
      URL.revokeObjectURL(playback.url)
      if (playbackUrlRef.current === playback.url) playbackUrlRef.current = ''
    }
  }, [outputAudioUrl, settings.audioOutputDeviceId])

  const refreshRuntime = useCallback(async () => {
    const devices = await listAudioOutputDevices().catch(() => [])
    setOutputDevices(devices)
    const result = await api.higgsHealth(settings.higgsTtsBaseUrl)
    setHealth(result.connected ? `Higgs 已连接 · ${formatSec(result.elapsed_sec)}` : `Higgs 未连接 · ${result.message || '检查失败'}`)
  }, [api, settings.higgsTtsBaseUrl])

  useEffect(() => {
    void refreshRuntime()
  }, [refreshRuntime])

  useEffect(() => {
    inputAudioUrlRef.current = inputAudioUrl
  }, [inputAudioUrl])

  useEffect(() => {
    outputAudioUrlRef.current = outputAudioUrl
  }, [outputAudioUrl])

  useEffect(() => () => {
    streamClientRef.current?.stop()
    playbackRef.current?.pause()
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
    if (inputAudioUrlRef.current) URL.revokeObjectURL(inputAudioUrlRef.current)
    if (outputAudioUrlRef.current) URL.revokeObjectURL(outputAudioUrlRef.current)
  }, [])

  const runTextTts = useCallback(async (text = ttsText, source: VoiceMode = 'text') => {
    const clean = text.trim()
    if (!clean) {
      setError('请输入要合成的文本')
      setStatus('error')
      return null
    }
    setStatus('processing')
    setStatusText('Higgs TTS 合成中')
    setError('')
    try {
      const result = await api.higgsSpeak({ ...commonPayload(), text: clean })
      applyResult(result, source)
      await playResult(result.audio)
      setStatus('done')
      setStatusText(`${modeLabels[source]} 完成`)
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : 'TTS 合成失败')
      setStatus('error')
      setStatusText('合成失败')
      return null
    }
  }, [api, applyResult, commonPayload, playResult, ttsText])

  const runAudioPipeline = useCallback(async (blob: Blob) => {
    setStatus('processing')
    setStatusText('ASR 识别后合成 TTS')
    setError('')
    setTranscript('')
    try {
      const result = await api.higgsAudioToSpeech(blob, {
        ...commonPayload(),
        engine: settings.defaultEngine,
        language: settings.defaultLanguage
      })
      applyResult(result, 'voice')
      await playResult(result.audio)
      setStatus('done')
      setStatusText('语音转 TTS 完成')
    } catch (err) {
      setError(err instanceof Error ? err.message : '语音转 TTS 失败')
      setStatus('error')
      setStatusText('处理失败')
    }
  }, [api, applyResult, commonPayload, playResult, settings.defaultEngine, settings.defaultLanguage])

  const streamConfig = useCallback(() => ({
    engine: 'sensevoice',
    finalEngine: settings.defaultEngine,
    language: settings.defaultLanguage,
    deviceId: settings.audioInputDeviceId || undefined,
    higgsBaseUrl: settings.higgsTtsBaseUrl,
    voice: activeVoice || settings.higgsTtsVoice || 'default',
    responseFormat: settings.higgsTtsFormat,
    speed: settings.higgsTtsSpeed,
    temperature: settings.higgsTtsTemperature,
    topP: settings.higgsTtsTopP,
    topK: settings.higgsTtsTopK,
    seed: settings.higgsTtsSeed,
    maxNewTokens: settings.higgsTtsMaxNewTokens,
    referenceAudio: settings.higgsTtsReferenceAudioDataUrl,
    referenceUrl: settings.higgsTtsReferenceUrl,
    referenceText: settings.higgsTtsReferenceText,
    referenceCodesJson: settings.higgsTtsReferenceCodesJson,
    emotion: settings.higgsTtsEmotion,
    style: settings.higgsTtsStyle,
    prosodySpeed: settings.higgsTtsProsodySpeed,
    pitch: settings.higgsTtsPitch,
    expressiveness: settings.higgsTtsExpressiveness,
    initialCodecChunkFrames: settings.higgsTtsInitialCodecChunkFrames
  }), [
    settings.audioInputDeviceId,
    settings.defaultEngine,
    settings.defaultLanguage,
    settings.higgsTtsBaseUrl,
    settings.higgsTtsFormat,
    settings.higgsTtsMaxNewTokens,
    settings.higgsTtsSeed,
    settings.higgsTtsSpeed,
    settings.higgsTtsTemperature,
    settings.higgsTtsTopK,
    settings.higgsTtsTopP,
    activeVoice,
    settings.higgsTtsVoice,
    settings.higgsTtsReferenceAudioDataUrl,
    settings.higgsTtsReferenceUrl,
    settings.higgsTtsReferenceText,
    settings.higgsTtsReferenceCodesJson,
    settings.higgsTtsEmotion,
    settings.higgsTtsStyle,
    settings.higgsTtsProsodySpeed,
    settings.higgsTtsPitch,
    settings.higgsTtsExpressiveness,
    settings.higgsTtsInitialCodecChunkFrames
  ])

  const handleRecord = useCallback(async () => {
    if (status === 'recording') {
      streamClientRef.current?.finishInput()
      setStatus('processing')
      setStatusText('录音已停止，等待 ASR + TTS 返回')
      setPartialText('')
      return
    }
    // Always clean up any stale client before starting
    if (streamClientRef.current) {
      streamClientRef.current.stop()
      streamClientRef.current = null
    }
    setMode('voice')
    setStatus('recording')
    setStatusText('后端 VAD 监听中')
    setError('')
    setTranscript('')
    setPartialText('')
    setInputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return ''
    })
    const client = new VoiceTTSStreamingClient(settings.serverUrl, (event) => {
      if (event.type === 'partial') {
        setPartialText(event.text)
      } else if (event.type === 'speech_start') {
        setStatusText('检测到语音')
      } else if (event.type === 'speech_end') {
        setStatusText('VAD 结束，正在识别')
      } else if (event.type === 'final') {
        setPartialText('')
        setTranscript(event.text)
        setStatus('processing')
        setStatusText('后端识别完成，正在合成 TTS')
      } else if (event.type === 'tts') {
        // Close after receiving TTS; stopping earlier would drop the response.
        streamClientRef.current?.close()
        streamClientRef.current = null
        const result: HiggsAudioResult = {
          audio: event.audio,
          text: event.text,
          sample_rate: event.sampleRate || undefined,
          asr_engine: settings.defaultEngine,
          language: settings.defaultLanguage,
          timing: {
            asr_sec: event.timing.asr_sec,
            tts_sec: event.timing.tts_sec,
            total_sec: event.timing.total_sec,
            higgs_network_sec: event.timing.higgs_network_sec,
            client_total_sec: event.timing.total_sec
          }
        }
        applyResult(result, 'voice')
        setStatus('done')
        setStatusText('后端 VAD 语音转 TTS 完成')
        // Small delay to let mic fully stop, then play result.
        setTimeout(() => {
          playResult(event.audio).catch((playError) => {
            setError(playError instanceof Error ? playError.message : '播放失败')
          })
        }, 300)
      } else if (event.type === 'error') {
        setError(event.message)
        setStatus('error')
        setStatusText('连接失败')
      } else if (event.type === 'closed') {
        setStatus((current) => {
          if (!event.intentional && (current === 'recording' || current === 'processing')) {
            setStatusText('连接已断开')
            return 'error'
          }
          return current
        })
      }
    })
    streamClientRef.current = client
    await client.start(streamConfig())
  }, [
    applyResult,
    playResult,
    settings.defaultEngine,
    settings.defaultLanguage,
    settings.serverUrl,
    status,
    streamConfig
  ])

  const handleFile = useCallback((file: File) => {
    setMode('voice')
    setInputAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
    void runAudioPipeline(file)
  }, [runAudioPipeline])

  const toggleRealtime = useCallback(async () => {
    if (status === 'streaming') {
      streamClientRef.current?.stop()
      streamClientRef.current = null
      setStatus('idle')
      setStatusText('实时流已停止')
      setPartialText('')
      return
    }

    setMode('realtime')
    setStatus('streaming')
    setStatusText('实时 ASR 监听中')
    setError('')
    setTranscript('')
    setLiveSegments([])
    const client = new VoiceTTSStreamingClient(settings.serverUrl, (event) => {
      if (event.type === 'partial') {
        setPartialText(event.text)
      } else if (event.type === 'final') {
        setPartialText('')
        setTranscript((prev) => [prev, event.text].filter(Boolean).join('\n'))
      } else if (event.type === 'tts') {
        const result: HiggsAudioResult = {
          audio: event.audio,
          text: event.text,
          sample_rate: event.sampleRate || undefined,
          asr_engine: settings.defaultEngine,
          language: settings.defaultLanguage,
          timing: {
            asr_sec: event.timing.asr_sec,
            tts_sec: event.timing.tts_sec,
            total_sec: event.timing.total_sec,
            higgs_network_sec: event.timing.higgs_network_sec,
            client_total_sec: event.timing.total_sec
          }
        }
        applyResult(result, 'realtime')
        setStatus('streaming')
        setStatusText('实时 ASR 监听中')
        playResult(event.audio).catch((playError) => {
          setError(playError instanceof Error ? playError.message : '播放失败')
          setStatusText('TTS 播放失败，实时监听仍在继续')
        })
        setLiveSegments((prev) => [
          { text: event.text, timing: roundSec(event.timing.total_sec) },
          ...prev
        ].slice(0, 6))
      } else if (event.type === 'speech_start') {
        setStatusText('检测到语音')
      } else if (event.type === 'speech_end') {
        setStatusText('语音结束，正在识别')
      } else if (event.type === 'error') {
        setError(event.message)
        setStatus('error')
      } else if (event.type === 'closed') {
        setStatus((current) => {
          if (current !== 'streaming') return current
          if (event.intentional) {
            setStatusText('实时流已停止')
            return 'idle'
          }
          setStatusText('实时流异常断开')
          return 'error'
        })
      }
    })
    streamClientRef.current = client
    await client.start(streamConfig())
  }, [
    applyResult,
    settings.defaultEngine,
    settings.defaultLanguage,
    settings.serverUrl,
    status,
    playResult,
    streamConfig
  ])

  const busy = status === 'processing'

  return (
    <div className="page voice-workbench-page">
      <div className="page-heading">
        <div>
          <h1>变声器 / TTS</h1>
          <p>支持语音转 TTS、文字 TTS 和实时 ASR+TTS。</p>
        </div>
        <span className={`soft-badge ${status === 'done' || status === 'streaming' ? 'success' : ''}`}>{statusText}</span>
      </div>

      <div className="voice-workbench">
        <section className="panel voice-control-panel">
          <div className="mode-switch">
            {(['voice', 'text', 'realtime'] as VoiceMode[]).map((item) => (
              <button key={item} type="button" className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                {modeLabels[item]}
              </button>
            ))}
          </div>

          <div className="voice-form">
            <div className="voice-runtime-card wide">
              <span>{health || '尚未检查服务'}</span>
              <button type="button" onClick={() => void refreshRuntime()}>检查</button>
            </div>
            <label className="wide">
              本次使用音色
              <select value={activeVoice} onChange={(event) => setActiveVoice(event.target.value)}>
                {Array.from(new Set(['default', ...settings.higgsTtsVoices, settings.higgsTtsVoice].filter(Boolean))).map((voice) => (
                  <option key={voice} value={voice}>{voice}</option>
                ))}
              </select>
            </label>
            <label className="wide">
              语音输出设备
              <div className="inline-control">
                <select value={settings.audioOutputDeviceId} onChange={(event) => updateSettings({ audioOutputDeviceId: event.target.value })}>
                  <option value="">系统默认输出</option>
                  {outputDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
                  ))}
                </select>
                <button type="button" onClick={() => void refreshRuntime()}>刷新</button>
              </div>
            </label>
          </div>
        </section>

        <section className="panel voice-action-panel">
          {mode === 'text' && (
            <div className="voice-mode-pane">
              <textarea value={ttsText} onChange={(event) => setTtsText(event.target.value)} rows={8} placeholder="输入要合成的文本" />
              <button type="button" className="primary voice-run-button" disabled={busy} onClick={() => void runTextTts()}>
                生成 TTS
              </button>
            </div>
          )}

          {mode === 'voice' && (
            <div className="voice-mode-pane">
              <div className="voice-capture-row">
                <button type="button" className={status === 'recording' ? 'record-button recording' : 'record-button primary'} disabled={busy} onClick={() => void handleRecord()}>
                  {status === 'recording' ? '停止并处理' : '录音'}
                </button>
                <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>上传音频</button>
                <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) handleFile(file)
                  event.currentTarget.value = ''
                }} />
              </div>
              {inputAudioUrl ? <audio controls src={inputAudioUrl} /> : <div className="empty voice-empty">录音走后端 VAD，一句话结束后自动识别并送入 Higgs TTS；上传音频会直接处理完整文件。</div>}
            </div>
          )}

          {mode === 'realtime' && (
            <div className="voice-mode-pane">
              <button type="button" className={status === 'streaming' ? 'record-button recording' : 'primary voice-run-button'} onClick={() => void toggleRealtime()}>
                {status === 'streaming' ? '停止实时模式' : '开始实时 ASR + TTS'}
              </button>
              <div className="live-text">
                {partialText || transcript || '实时最终识别片段会逐段触发 Higgs TTS。'}
              </div>
              <div className="live-segment-list">
                {liveSegments.map((item, index) => (
                  <article key={`${item.text}-${index}`}>
                    <span>{formatSec(item.timing)}</span>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </section>

        <section className="panel voice-output-panel">
          <div className="section-head compact">
            <div>
              <h2>输出</h2>
              <p>{settings.audioOutputDeviceId ? '播放按钮会输出到已选设备' : '播放按钮使用系统默认输出'}</p>
            </div>
            <button type="button" disabled={!outputAudioUrl} onClick={() => void playResult()}>播放到输出设备</button>
          </div>
          {outputAudioUrl ? <audio controls src={outputAudioUrl} /> : <div className="empty voice-empty">生成的 TTS 音频会显示在这里。</div>}
          {transcript && (
            <div className="voice-transcript">
              <strong>识别 / 合成文本</strong>
              <p>{transcript}</p>
            </div>
          )}
        </section>

        <section className="panel voice-latency-panel">
          <div className="section-head compact">
            <h2>延迟</h2>
          </div>
          <div className="latency-grid">
            {timings.length ? timings.map((item) => (
              <article key={item.label}>
                <span>{item.label}</span>
                <strong>{formatSec(item.value)}</strong>
                {item.detail && <small>{item.detail}</small>}
              </article>
            )) : (
              <div className="empty">完成一次合成后显示每个环节耗时。</div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
