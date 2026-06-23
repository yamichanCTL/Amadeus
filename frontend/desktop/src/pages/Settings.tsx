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

  const previewCaption = () => window.electronAPI?.showCaptionOverlay('20:12:41  → 20:13:24\nAmadeus 字幕预览', {
    fontSize: settings.captionFontSize,
    color: settings.captionFontColor,
    backgroundOpacity: settings.captionBackgroundOpacity,
    width: settings.captionBoxWidth,
    height: settings.captionBoxHeight,
    x: settings.captionBoxX,
    y: settings.captionBoxY,
  })

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

  const changeInputSource = (inputSource: typeof settings.inputSource) => {
    const useSpeaker = inputSource === 'speaker'
    if (useSpeaker && audioRelayMixer.isActive()) audioRelayMixer.stop()
    updateSettings({
      inputSource,
      audioInputDeviceId: useSpeaker
        ? '__speaker_loopback__'
        : settings.audioInputDeviceId === '__speaker_loopback__' ? '' : settings.audioInputDeviceId,
      ...(useSpeaker ? { audioRelayEnabled: false } : {}),
    })
  }

  return (
    <div className="page settings-page">
      <section className="panel settings-grid">
        <h1>设置</h1>
        <label className="wide">
          用户 ID
          <div className="inline-control">
            <input value={settings.userId} maxLength={128} onChange={(event) => updateSettings({ userId: event.target.value, passiveSummaryUserId: event.target.value })} onBlur={() => void saveUserId()} placeholder="用于本机识别归档，例如 dsm" />
            <button type="button" onClick={() => void saveUserId()}>保存</button>
          </div>
          <small>{userIdStatus || '保存在 Electron 应用数据目录的 archive/userid，并用于文件和实时识别归档。'}</small>
        </label>
        <label>
          后端地址
          <input value={settings.serverUrl} onChange={(event) => updateSettings({ serverUrl: event.target.value })} placeholder="http://112.124.13.120:18000" />
          <small>浏览器直连的公网后端。实时 ASR+TTS 的 WebSocket 也连向此地址的 /v1/tts/higgs/stream 路由，由后端内部转发给 TTS。</small>
        </label>
        <label>
          Higgs TTS 地址
          <input value={settings.higgsTtsBaseUrl} onChange={(event) => updateSettings({ higgsTtsBaseUrl: event.target.value })} placeholder="http://127.0.0.1:8002" />
          <small>浏览器不直连 TTS。此地址随 WebSocket config 发送给后端，后端在服务器内部调用 127.0.0.1:TTS端口 完成语音合成。</small>
        </label>
        <label>
          主题
          <select value={settings.theme} onChange={(event) => updateSettings({ theme: event.target.value as typeof settings.theme })}>
            <option value="windows">跟随 Windows</option>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.autoLaunchEnabled}
            onChange={(event) => {
              const enabled = event.target.checked
              updateSettings({ autoLaunchEnabled: enabled })
              window.electronAPI?.setAutoLaunch(enabled)
            }}
          />
          开机自动启动 Amadeus
        </label>
        <label>
          音频输入
          <div className="inline-control">
            <select value={settings.audioInputDeviceId} onChange={(event) => changeAudioInput(event.target.value)}>
              <option value="">跟随系统</option>
              <option value="__speaker_loopback__">扬声器（系统音频输出）</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
              ))}
            </select>
            <button type="button" disabled={testingMicrophone} onClick={() => void testMicrophone()}>
              {testingMicrophone ? '测试中' : '测试输入'}
            </button>
          </div>
          {microphoneTest && <small>{microphoneTest}</small>}
        </label>
        <label className="wide">
          虚拟麦克风输出 / TTS 叠加
          <div className="inline-control">
            <select value={settings.audioOutputDeviceId} onChange={(event) => void changeOutputDevice(event.target.value)}>
              <option value="">系统默认输出</option>
              {outputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
              ))}
            </select>
            <button type="button" onClick={() => void listAudioOutputDevices().then(setOutputDevices)}>刷新</button>
            <button type="button" onClick={() => void testAudioOutputDevice(settings.audioOutputDeviceId || undefined).then(() => setRouteStatus('指定输出设备测试音播放完成')).catch((error) => setRouteStatus(error instanceof Error ? error.message : '输出测试失败'))}>测试</button>
          </div>
          <small>VB-Audio 用法：这里选择播放端点 CABLE Input；Windows 默认麦克风选择录音端点 CABLE Output。{routeStatus}</small>
        </label>
        <label className="wide check route-toggle">
          <input type="checkbox" checked={settings.audioRelayEnabled} onChange={() => void toggleAudioRelay()} />
          常态透传已选真实麦克风；播放 TTS 或音效时叠加到同一个虚拟输出
        </label>
        {settings.audioRelayEnabled && (
          <label className="wide debug-monitor-label">
            <div className="field-header">
              <span>🔊 通路测试：真实麦克风 → 虚拟麦克风 → 默认扬声器</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <small style={{ minWidth: 56 }}>输入电平</small>
                <div style={{
                  flex: 1, height: 10, borderRadius: 4,
                  background: `var(--bg-subtle, #e5e7eb)`,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    width: `${Math.round(inputLevel * 100)}%`,
                    background: inputLevel > 0.8 ? '#ef4444' : inputLevel > 0.3 ? '#22c55e' : '#3b82f6',
                    transition: 'width 60ms linear',
                  }} />
                </div>
                <small style={{ minWidth: 36, textAlign: 'right' }}>{Math.round(inputLevel * 100)}%</small>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <small style={{ minWidth: 56 }}>监听电平</small>
                <div style={{
                  flex: 1, height: 10, borderRadius: 4,
                  background: `var(--bg-subtle, #e5e7eb)`,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 4,
                    width: `${Math.round(monitorLevel * 100)}%`,
                    background: monitorLevel > 0.8 ? '#ef4444' : monitorLevel > 0.3 ? '#22c55e' : '#3b82f6',
                    transition: 'width 60ms linear',
                  }} />
                </div>
                <small style={{ minWidth: 36, textAlign: 'right' }}>{Math.round(monitorLevel * 100)}%</small>
              </div>
              <div className="inline-control">
                <button type="button" onClick={() => void toggleMonitor()}>
                  {monitoring ? '停止监听' : '开始监听'}
                </button>
              </div>
              {monitorError && <small style={{ color: '#ef4444' }}>{monitorError}</small>}
              <small>
                点击"开始监听"后，真实麦克风的声音会从默认扬声器持续播出，用于验证通路是否正常。
                再次点击"停止监听"结束。虚拟麦克风输出不受影响。请确保 Windows 默认播放设备是真实扬声器而非 CABLE Input，避免反馈。
              </small>
            </div>
          </label>
        )}
        <label>
          结果输出
          <select value={settings.injectMode} onChange={(event) => updateSettings({ injectMode: event.target.value as typeof settings.injectMode })}>
            <option value="inject">自动粘贴</option>
            <option value="copy">复制到剪贴板</option>
            <option value="none">不输出</option>
          </select>
        </label>
        <label>
          触发类型
          <select value={settings.triggerType} onChange={(event) => updateSettings({ triggerType: event.target.value as typeof settings.triggerType })}>
            <option value="mouse">鼠标按键</option>
            <option value="keyboard">键盘快捷键</option>
          </select>
        </label>
        <label>
          触发键
          {settings.triggerType === 'mouse' ? (
            <TriggerCapture value={settings.triggerKey} onChange={(value) => updateSettings({ triggerKey: value })} />
          ) : (
            <HotkeyCapture value={settings.triggerKey} onChange={(value) => updateSettings({ triggerKey: value })} />
          )}
          {settings.triggerType === 'keyboard' && settings.triggerKey === 'AltRight' && <small>默认：右 Alt；Windows 支持全局触发，其他平台需保持应用获得键盘事件。</small>}
        </label>
        <label>
          音频输入来源
          <select value={settings.inputSource} onChange={(event) => changeInputSource(event.target.value as typeof settings.inputSource)}>
            <option value="file">麦克风</option>
            <option value="speaker">扬声器（系统音频输出）</option>
          </select>
          <small>同时影响实时字幕和快捷识别（右 Alt）的音频来源。选择扬声器可录制系统播放的声音。</small>
        </label>
        <label>
          切片秒数
          <input type="number" min={2} max={15} value={settings.liveCaptionChunkSec} onChange={(event) => updateSettings({ liveCaptionChunkSec: Number(event.target.value) })} />
        </label>
        <label>
          字幕字号
          <input type="number" min={12} max={48} value={settings.captionFontSize} onChange={(event) => updateSettings({ captionFontSize: Number(event.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.showDesktopCaptions} onChange={(event) => updateSettings({ showDesktopCaptions: event.target.checked })} />
          实时识别时显示桌面字幕框
        </label>
        <label>
          字幕宽度
          <input type="range" min={320} max={1200} step={10} value={settings.captionBoxWidth} onChange={(event) => updateSettings({ captionBoxWidth: Number(event.target.value) })} />
          <small>{settings.captionBoxWidth}px</small>
        </label>
        <label>
          字幕高度
          <input type="range" min={96} max={500} step={4} value={settings.captionBoxHeight} onChange={(event) => updateSettings({ captionBoxHeight: Number(event.target.value) })} />
          <small>{settings.captionBoxHeight}px</small>
        </label>
        <label>
          字幕颜色
          <input type="color" value={settings.captionFontColor} onChange={(event) => updateSettings({ captionFontColor: event.target.value })} />
        </label>
        <label>
          背景透明度
          <input type="range" min={0} max={1} step={0.01} value={settings.captionBackgroundOpacity} onChange={(event) => updateSettings({ captionBackgroundOpacity: Number(event.target.value) })} />
        </label>
        <div className="wide caption-settings-actions">
          <button type="button" onClick={() => void previewCaption()}>预览字幕框</button>
          <button type="button" onClick={() => window.electronAPI?.hideCaptionOverlay()}>隐藏字幕框</button>
          <button type="button" onClick={() => updateSettings({ captionBoxX: null, captionBoxY: null })}>恢复默认位置</button>
        </div>
        <label>
          超时秒数
          <input type="number" min={0} value={settings.timeoutSec} onChange={(event) => updateSettings({ timeoutSec: Number(event.target.value) })} />
        </label>
        <label className="wide">
          归档目录
          <div className="path-picker">
            <input value={settings.archiveDir} placeholder="默认使用应用数据目录/archive" onChange={(event) => updateSettings({ archiveDir: event.target.value })} />
            <button type="button" onClick={chooseArchiveDir}>选择</button>
          </div>
        </label>
        <label className="check wide">
          <input
            type="checkbox"
            checked={settings.allowServerDataCollection}
            onChange={(event) => updateSettings({ allowServerDataCollection: event.target.checked })}
          />
          允许服务端保存调试数据
        </label>
      </section>
    </div>
  )
}
