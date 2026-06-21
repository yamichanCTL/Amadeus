import { useEffect, useState } from 'react'
import { HotkeyCapture, TriggerCapture } from '@/components/TriggerCapture'
import { listAudioInputDevices, testAudioInputDevice } from '@/services/audio'
import { useASRStore } from '@/store/useASRStore'

export function SettingsPage() {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [microphoneTest, setMicrophoneTest] = useState('')
  const [testingMicrophone, setTestingMicrophone] = useState(false)

  useEffect(() => {
    listAudioInputDevices().then(setDevices).catch(() => setDevices([]))
  }, [])

  const chooseArchiveDir = async () => {
    const dir = await window.electronAPI?.openDirectoryDialog()
    if (dir) updateSettings({ archiveDir: dir })
  }

  const testMicrophone = async () => {
    setTestingMicrophone(true)
    setMicrophoneTest('检测中，请对着麦克风说话…')
    try {
      const result = await testAudioInputDevice(settings.audioInputDeviceId || undefined)
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

  return (
    <div className="page settings-page">
      <section className="panel settings-grid">
        <h1>设置</h1>
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
        <label>
          麦克风
          <div className="inline-control">
            <select value={settings.audioInputDeviceId} onChange={(event) => updateSettings({ audioInputDeviceId: event.target.value })}>
              <option value="">跟随系统</option>
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
          实时字幕来源
          <select value={settings.inputSource} onChange={(event) => updateSettings({ inputSource: event.target.value as typeof settings.inputSource })}>
            <option value="file">麦克风</option>
            <option value="speaker">扬声器</option>
          </select>
        </label>
        <label>
          切片秒数
          <input type="number" min={2} max={15} value={settings.liveCaptionChunkSec} onChange={(event) => updateSettings({ liveCaptionChunkSec: Number(event.target.value) })} />
        </label>
        <label>
          字幕字号
          <input type="number" min={12} max={48} value={settings.captionFontSize} onChange={(event) => updateSettings({ captionFontSize: Number(event.target.value) })} />
        </label>
        <label>
          字幕颜色
          <input type="color" value={settings.captionFontColor} onChange={(event) => updateSettings({ captionFontColor: event.target.value })} />
        </label>
        <label>
          背景透明度
          <input type="range" min={0} max={1} step={0.01} value={settings.captionBackgroundOpacity} onChange={(event) => updateSettings({ captionBackgroundOpacity: Number(event.target.value) })} />
        </label>
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
