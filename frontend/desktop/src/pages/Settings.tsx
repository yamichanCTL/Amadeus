import { useEffect, useState } from 'react'
import { HotkeyCapture, TriggerCapture } from '@/components/TriggerCapture'
import { listAudioInputDevices } from '@/services/audio'
import { useASRStore } from '@/store/useASRStore'

export function SettingsPage() {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    listAudioInputDevices().then(setDevices).catch(() => setDevices([]))
  }, [])

  const chooseArchiveDir = async () => {
    const dir = await window.electronAPI?.openDirectoryDialog()
    if (dir) updateSettings({ archiveDir: dir })
  }

  return (
    <div className="page settings-page">
      <section className="panel settings-grid">
        <h1>设置</h1>
        <label>
          后端地址
          <input value={settings.serverUrl} onChange={(event) => updateSettings({ serverUrl: event.target.value })} />
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
          <select value={settings.audioInputDeviceId} onChange={(event) => updateSettings({ audioInputDeviceId: event.target.value })}>
            <option value="">默认设备</option>
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>
            ))}
          </select>
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
        <h2 className="wide">大模型</h2>
        <label>
          接口地址
          <input
            value={settings.llmBaseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => updateSettings({ llmBaseUrl: event.target.value })}
          />
        </label>
        <label>
          模型
          <input
            value={settings.llmModel}
            placeholder="填写 OpenAI 兼容模型名称"
            onChange={(event) => updateSettings({ llmModel: event.target.value })}
          />
        </label>
        <label>
          API Token
          <input
            type="password"
            value={settings.llmApiToken}
            placeholder="仅保存在本机"
            onChange={(event) => updateSettings({ llmApiToken: event.target.value })}
          />
        </label>
        <label>
          翻译目标语言
          <input
            value={settings.llmTargetLanguage}
            onChange={(event) => updateSettings({ llmTargetLanguage: event.target.value })}
          />
        </label>
        <label className="wide">
          润色风格
          <input
            value={settings.llmStyle}
            placeholder="例如：正式、简洁、会议纪要风格"
            onChange={(event) => updateSettings({ llmStyle: event.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.llmAutoPolish}
            onChange={(event) => updateSettings({ llmAutoPolish: event.target.checked })}
          />
          转写完成后自动润色
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.llmAutoTranslate}
            onChange={(event) => updateSettings({ llmAutoTranslate: event.target.checked })}
          />
          转写完成后自动翻译
        </label>
      </section>
    </div>
  )
}
