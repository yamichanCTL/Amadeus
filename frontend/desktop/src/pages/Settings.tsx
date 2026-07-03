import { useEffect, useRef, useState } from 'react'
import { HotkeyCapture, TriggerCapture } from '@/components/TriggerCapture'
import { audioRelayMixer, captureSpeakerAudio, listAudioInputDevices, listAudioOutputDevices, testAudioInputDevice, testAudioOutputDevice } from '@/services/audio'
import { useASRStore } from '@/store/useASRStore'

export function SettingsPage() {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [microphoneTest, setMicrophoneTest] = useState('')
  const [testingMicrophone, setTestingMicrophone] = useState(false)
  const [routeStatus, setRouteStatus] = useState(audioRelayMixer.isActive() ? '音频中转已运行' : '音频中转未启用')
  const [userIdStatus, setUserIdStatus] = useState('')
  // 通路调试面板：真实麦克风 → 虚拟麦克风 → 默认扬声器
  const [monitoring, setMonitoring] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [monitorLevel, setMonitorLevel] = useState(0)
  const [monitorError, setMonitorError] = useState('')
  const rafRef = useRef(0)
  const levelTimerRef = useRef(0)
  const monitorActiveRef = useRef(false)  // source of truth for toggle gate
  // 后端地址采用「草稿 + 确认」交互：输入只改草稿，点「确认」才写入
  // settings.serverUrl 并触发通信。未确认时通信层拿到的是旧（或空）地址，
  // 满足「未设置不通信」。草稿随已确认地址初始化。
  const [draftServerUrl, setDraftServerUrl] = useState(settings.serverUrl)
  const [serverUrlStatus, setServerUrlStatus] = useState('')
  const [activeSection, setActiveSection] = useState<'general' | 'audio' | 'recognition' | 'privacy'>('general')
  const [captionPreviewOpen, setCaptionPreviewOpen] = useState(false)

  // 当已确认的后端地址在外部变化时（如迁移清空），同步草稿。
  useEffect(() => { setDraftServerUrl(settings.serverUrl) }, [settings.serverUrl])

  const confirmServerUrl = async () => {
    const trimmed = draftServerUrl.trim()
    if (trimmed && trimmed !== '/' && !/^https?:\/\//i.test(trimmed) && !/^\S+:\d+$/.test(trimmed)) {
      setServerUrlStatus('地址格式无效，请填写形如 http://host:port 的地址')
      return
    }
    updateSettings({ serverUrl: trimmed, backendConfirmed: Boolean(trimmed) })
    setServerUrlStatus(trimmed ? `已确认后端地址：${trimmed.replace(/\/+$/, '')}` : '已清空后端地址，未设置不进行通信')
  }

  useEffect(() => {
    void Promise.all([
      listAudioInputDevices().then(setDevices).catch(() => setDevices([])),
      listAudioOutputDevices().then(setOutputDevices).catch(() => setOutputDevices([])),
    ])
  }, [])

  // 当 relay 意外停止时复位监控状态
  useEffect(() => {
    if (!settings.audioRelayEnabled) {
      monitorActiveRef.current = false
      setMonitoring(false)
      setInputLevel(0)
      setMonitorLevel(0)
      setMonitorError('')
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    }
  }, [settings.audioRelayEnabled])

  // 电平计动画循环：监控中以 ~70ms 刷新两条电平；非监控中以 ~200ms 刷新输入电平
  useEffect(() => {
    let stopped = false
    const update = () => {
      if (stopped) return
      if (audioRelayMixer.isActive()) {
        const input = audioRelayMixer.getInputLevel()
        setInputLevel(input !== null ? input : 0)
        if (monitoring) {
          const monitor = audioRelayMixer.getMonitorLevel()
          setMonitorLevel(monitor !== null ? monitor : 0)
        }
      } else {
        setInputLevel(0)
        setMonitorLevel(0)
      }
      levelTimerRef.current = window.setTimeout(update, monitoring ? 70 : 200)
    }
    update()
    return () => {
      stopped = true
      if (levelTimerRef.current) { window.clearTimeout(levelTimerRef.current); levelTimerRef.current = 0 }
    }
  }, [monitoring])

  const toggleMonitor = () => {
    // Use ref as gate to avoid React state closure staleness on rapid double-click.
    if (monitorActiveRef.current) {
      audioRelayMixer.stopMonitor()
      monitorActiveRef.current = false
      setMonitoring(false)
      setMonitorLevel(0)
      setMonitorError('')
      return
    }
    if (!audioRelayMixer.isActive()) {
      setMonitorError('音频中转未启用，请先勾选上方的”常态透传”')
      return
    }
    setMonitorError('')
    monitorActiveRef.current = true
    setMonitoring(true)
    // Fire-and-forget: startMonitor(0) returns a Promise that only resolves
    // when stopMonitor() is called (no timeout). We must NOT await it here
    // because the resolution path (stopMonitor → monitoringRef → setMonitoring)
    // is driven by the next user click, not by this async completion.
    audioRelayMixer.startMonitor(0).then(
      () => {
        // Resolved by stopMonitor() — it already cleaned up; just sync UI.
        monitorActiveRef.current = false
        setMonitoring(false)
        setMonitorLevel(0)
      },
      (error: unknown) => {
        monitorActiveRef.current = false
        setMonitoring(false)
        setMonitorLevel(0)
        setMonitorError(error instanceof Error ? error.message : '通路监听启动失败')
      },
    )
  }

  const saveUserId = async () => {
    try {
      const result = await window.electronAPI?.saveUserId(settings.userId)
      setUserIdStatus(result ? `已保存到 ${result.path}` : '当前仅保存到应用设置')
    } catch (error) {
      setUserIdStatus(error instanceof Error ? `保存失败：${error.message}` : '用户 ID 保存失败')
    }
  }

  const changeOutputDevice = async (deviceId: string) => {
    updateSettings({ audioOutputDeviceId: deviceId })
    if (!audioRelayMixer.isActive()) return
    try {
      await audioRelayMixer.setOutputDevice(deviceId)
      setRouteStatus(deviceId ? '中转已切换到指定虚拟输出设备' : '中转已切换到系统默认输出')
    } catch (error) {
      setRouteStatus(error instanceof Error ? `切换失败：${error.message}` : '输出设备切换失败')
    }
  }

  const toggleAudioRelay = async () => {
    if (audioRelayMixer.isActive()) {
      audioRelayMixer.stop()
      updateSettings({ audioRelayEnabled: false })
      setRouteStatus('已停止：真实麦克风不再透传')
      return
    }
    if (settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__') {
      setRouteStatus('扬声器回环输入不能同时启用虚拟麦克风中转，请先选择真实麦克风')
      return
    }
    setRouteStatus('正在接管真实麦克风并建立混音总线…')
    try {
      const result = await audioRelayMixer.start({
        inputDeviceId: settings.audioInputDeviceId || undefined,
        outputDeviceId: settings.audioOutputDeviceId || undefined,
      })
      updateSettings({ audioRelayEnabled: true })
      setRouteStatus(settings.audioOutputDeviceId
        ? `已启用：麦克风、TTS、音效叠加到指定设备${result.sinkApplied ? '' : '（sink 未确认）'}`
        : '已启用：麦克风、TTS、音效叠加到系统默认输出')
    } catch (error) {
      audioRelayMixer.stop()
      updateSettings({ audioRelayEnabled: false })
      setRouteStatus(error instanceof Error ? `启动失败：${error.message}` : '音频中转启动失败')
    }
  }

  const previewCaption = () => setCaptionPreviewOpen(true)
  const hideCaptionPreview = () => {
    setCaptionPreviewOpen(false)
    window.electronAPI?.hideCaptionOverlay()
  }

  useEffect(() => {
    if (!captionPreviewOpen) return
    void window.electronAPI?.showCaptionOverlay('20:12:41  → 20:13:24\nAmadeus 字幕预览', {
      fontSize: settings.captionFontSize,
      color: settings.captionFontColor,
      backgroundOpacity: settings.captionBackgroundOpacity,
      width: settings.captionBoxWidth,
      height: settings.captionBoxHeight,
      x: settings.captionBoxX,
      y: settings.captionBoxY,
    })
  }, [
    captionPreviewOpen,
    settings.captionBackgroundOpacity,
    settings.captionBoxHeight,
    settings.captionBoxWidth,
    settings.captionBoxX,
    settings.captionBoxY,
    settings.captionFontColor,
    settings.captionFontSize,
  ])

  const chooseArchiveDir = async () => {
    const dir = await window.electronAPI?.openDirectoryDialog()
    if (dir) updateSettings({ archiveDir: dir })
  }

  const testMicrophone = async () => {
    setTestingMicrophone(true)
    const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
    setMicrophoneTest(useSpeaker ? '检测中，请播放一段系统声音…' : '检测中，请对着麦克风说话…')
    try {
      const speakerStream = useSpeaker ? await captureSpeakerAudio() : undefined
      const result = await testAudioInputDevice(
        useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
        1200,
        speakerStream,
      )
      const level = Math.round(result.peak * 100)
      const aec = result.echoCancellation === null ? 'AEC 状态未知' : result.echoCancellation ? 'AEC 已启用' : 'AEC 不可用'
      setMicrophoneTest(
        level >= 1
          ? `输入通路正常 · 峰值 ${level}% · ${result.sampleRate}Hz · ${aec}`
          : `已打开 ${result.label}，但未检测到明显声音 · ${aec}`
      )
      setDevices(await listAudioInputDevices().catch(() => devices))
    } catch (error) {
      setMicrophoneTest(error instanceof Error ? `输入测试失败：${error.message}` : '输入测试失败')
    } finally {
      setTestingMicrophone(false)
    }
  }

  const changeAudioInput = (deviceId: string) => {
    const useSpeaker = deviceId === '__speaker_loopback__'
    if (useSpeaker && audioRelayMixer.isActive()) audioRelayMixer.stop()
    updateSettings({
      audioInputDeviceId: deviceId,
      inputSource: useSpeaker ? 'speaker' : 'file',
      ...(useSpeaker ? { audioRelayEnabled: false } : {}),
    })
  }

  const levelBar = (label: string, value: number) => (
    <div className="audio-level-row">
      <small>{label}</small>
      <div><i style={{ width: `${Math.round(value * 100)}%` }} /></div>
      <small>{Math.round(value * 100)}%</small>
    </div>
  )

  return (
    <div className="page settings-page">
      <header className="page-heading">
        <div><h1>设置</h1><p>按功能分页管理应用、音频、识别字幕和数据隐私。</p></div>
      </header>
      <nav className="settings-tabs" aria-label="设置分类">
        {([
          ['general', '常规'],
          ['audio', '音频'],
          ['recognition', '识别与字幕'],
          ['privacy', '数据与隐私'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={activeSection === id ? 'active' : ''} onClick={() => setActiveSection(id)}>{label}</button>
        ))}
      </nav>

      {activeSection === 'general' && (
        <section className="panel settings-section">
          <div className="section-head"><div><h2>常规</h2><p>账户标识、后端入口和应用启动行为。</p></div></div>
          <div className="settings-section-grid">
            <label className="wide">用户 ID
              <div className="inline-control">
                <input value={settings.userId} maxLength={128} onChange={(event) => updateSettings({ userId: event.target.value, passiveSummaryUserId: event.target.value })} onBlur={() => void saveUserId()} placeholder="用于本机识别归档，例如 dsm" />
                <button type="button" onClick={() => void saveUserId()}>保存</button>
              </div>
              <small>{userIdStatus || '保存在本机应用数据目录，并用于本机记录归档。'}</small>
            </label>
            <label className="wide">后端地址
              <div className="inline-control">
                <input value={draftServerUrl} onChange={(event) => setDraftServerUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void confirmServerUrl() }} placeholder="http://your-server-ip:18000" />
                <button type="button" onClick={() => void confirmServerUrl()}>确认</button>
              </div>
              <small>{serverUrlStatus || '输入只保存为草稿；点击确认后才开始连接后端。'}</small>
              {settings.backendConfirmed && settings.serverUrl && <small className="soft-badge">已确认：{settings.serverUrl}</small>}
            </label>
            <label>主题
              <select value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as typeof settings.theme })}>
                <option value="windows">跟随 Windows</option><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </label>
            <div className="settings-toggle-stack">
              <label className="check"><input type="checkbox" checked={settings.autoLaunchEnabled} onChange={(event) => { const enabled = event.target.checked; updateSettings({ autoLaunchEnabled: enabled }); window.electronAPI?.setAutoLaunch(enabled) }} />开机自动启动 Amadeus</label>
              <label className="check"><input type="checkbox" checked={settings.keepRunningInBackground} onChange={(event) => updateSettings({ keepRunningInBackground: event.target.checked })} />关闭窗口后保留后台运行</label>
            </div>
          </div>
        </section>
      )}

      {activeSection === 'audio' && (
        <section className="panel settings-section">
          <div className="section-head"><div><h2>音频</h2><p>选择物理输入、系统回环和虚拟麦克风输出。</p></div></div>
          <div className="settings-section-grid">
            <label>音频输入
              <div className="inline-control">
                <select value={settings.audioInputDeviceId} onChange={(event) => changeAudioInput(event.target.value)}>
                  <option value="">跟随系统</option><option value="__speaker_loopback__">扬声器（系统音频输出）</option>
                  {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}
                </select>
                <button type="button" disabled={testingMicrophone} onClick={() => void testMicrophone()}>{testingMicrophone ? '测试中' : '测试输入'}</button>
              </div>
              <small>{microphoneTest || '影响实时字幕和快捷识别的音频来源。'}</small>
            </label>
            <label>虚拟麦克风输出 / TTS 叠加
              <div className="inline-control">
                <select value={settings.audioOutputDeviceId} onChange={(event) => void changeOutputDevice(event.target.value)}>
                  <option value="">系统默认输出</option>{outputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}
                </select>
                <button type="button" onClick={() => void listAudioOutputDevices().then(setOutputDevices)}>刷新</button>
                <button type="button" onClick={() => void testAudioOutputDevice(settings.audioOutputDeviceId || undefined).then(() => setRouteStatus('指定输出设备测试音播放完成')).catch((error) => setRouteStatus(error instanceof Error ? error.message : '输出测试失败'))}>测试</button>
              </div>
              <small>{routeStatus}</small>
            </label>
            <label className="wide check route-toggle"><input type="checkbox" checked={settings.audioRelayEnabled} onChange={() => void toggleAudioRelay()} />常态透传真实麦克风，并将 TTS / 音效叠加到同一个虚拟输出</label>
            {settings.audioRelayEnabled && <div className="wide audio-monitor-card">
              <strong>通路测试</strong>{levelBar('输入电平', inputLevel)}{levelBar('监听电平', monitorLevel)}
              <div className="inline-control"><button type="button" onClick={() => void toggleMonitor()}>{monitoring ? '停止监听' : '开始监听'}</button></div>
              {monitorError && <small className="error">{monitorError}</small>}
            </div>}
          </div>
        </section>
      )}

      {activeSection === 'recognition' && (
        <section className="panel settings-section">
          <div className="section-head"><div><h2>识别与字幕</h2><p>配置快捷识别输出和桌面字幕框。</p></div></div>
          <div className="settings-subgrid">
            <article className="settings-card"><h3>识别与触发</h3>
              <label>结果输出<select value={settings.injectMode} onChange={(event) => updateSettings({ injectMode: event.target.value as typeof settings.injectMode })}><option value="inject">自动粘贴</option><option value="copy">复制到剪贴板</option><option value="none">不输出</option></select></label>
              <label>触发类型<select value={settings.triggerType} onChange={(event) => updateSettings({ triggerType: event.target.value as typeof settings.triggerType })}><option value="mouse">鼠标按键</option><option value="keyboard">键盘快捷键</option></select></label>
              <label>触发键{settings.triggerType === 'mouse' ? <TriggerCapture value={settings.triggerKey} onChange={(value) => updateSettings({ triggerKey: value })} /> : <HotkeyCapture value={settings.triggerKey} onChange={(value) => updateSettings({ triggerKey: value })} />}</label>
              <label>超时秒数<input type="number" min={0} value={settings.timeoutSec} onChange={(event) => updateSettings({ timeoutSec: Number(event.target.value) })} /></label>
            </article>
            <article className="settings-card"><h3>桌面字幕</h3>
              <label className="check featured-toggle"><input type="checkbox" checked={settings.showDesktopCaptions} onChange={(event) => updateSettings({ showDesktopCaptions: event.target.checked })} />实时识别时显示桌面字幕框</label>
              <label>切片秒数<input type="number" min={2} max={15} value={settings.liveCaptionChunkSec} onChange={(event) => updateSettings({ liveCaptionChunkSec: Number(event.target.value) })} /></label>
              <label>字幕字号<input type="number" min={12} max={48} value={settings.captionFontSize} onChange={(event) => updateSettings({ captionFontSize: Number(event.target.value) })} /></label>
              <label>字幕颜色<input type="color" value={settings.captionFontColor} onChange={(event) => updateSettings({ captionFontColor: event.target.value })} /></label>
              <label>字幕宽度<input type="range" min={320} max={1200} step={10} value={settings.captionBoxWidth} onChange={(event) => updateSettings({ captionBoxWidth: Number(event.target.value) })} /><small>{settings.captionBoxWidth}px</small></label>
              <label>字幕高度<input type="range" min={96} max={500} step={4} value={settings.captionBoxHeight} onChange={(event) => updateSettings({ captionBoxHeight: Number(event.target.value) })} /><small>{settings.captionBoxHeight}px</small></label>
              <label>背景透明度<input type="range" min={0} max={1} step={0.01} value={settings.captionBackgroundOpacity} onChange={(event) => updateSettings({ captionBackgroundOpacity: Number(event.target.value) })} /></label>
              <div className="caption-settings-actions"><button type="button" onClick={previewCaption}>{captionPreviewOpen ? '预览已实时同步' : '预览字幕框'}</button><button type="button" onClick={hideCaptionPreview}>隐藏</button><button type="button" onClick={() => updateSettings({ captionBoxX: null, captionBoxY: null })}>恢复位置</button></div>
            </article>
          </div>
        </section>
      )}

      {activeSection === 'privacy' && (
        <section className="panel settings-section">
          <div className="section-head"><div><h2>数据与隐私</h2><p>本机目录与服务端留存是两个独立开关。</p></div></div>
          <div className="settings-section-grid">
            <label className="wide">本机数据保存目录
              <div className="path-picker"><input value={settings.archiveDir} readOnly placeholder="默认使用应用数据目录/archive" /><button type="button" onClick={chooseArchiveDir}>选择目录</button></div>
              <small>只能选择 Electron 本机保存目录。音频与 JSON 分别写入 `wav|json/识别类型/日期`，总结写入 `summary-logs/日期`；此路径不会发送给后端。</small>
            </label>
            <div className="wide privacy-card">
              <label className="check"><input type="checkbox" checked={settings.allowServerDataCollection} onChange={(event) => updateSettings({ allowServerDataCollection: event.target.checked })} />允许服务端保存调试数据</label>
              <p>{settings.allowServerDataCollection ? '服务端可以保存调试音频和 JSON；当日总结查询服务端归档。' : '服务端不留存调试数据；生成当日总结时仅临时发送本机记录中的时间、类别和文本。'}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
