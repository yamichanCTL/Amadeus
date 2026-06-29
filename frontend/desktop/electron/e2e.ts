import { app, BrowserWindow, clipboard, screen } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

type CaptionOptions = {
  fontSize: number
  color: string
  backgroundOpacity: number
  width: number
  height: number
  x: number | null
  y: number | null
}

type Harness = {
  mainWindow: BrowserWindow
  showStatusOverlay: (status: string, level?: number, message?: string) => Promise<boolean>
  getStatusOverlay: () => BrowserWindow | null
  showCaptionOverlay: (text: string, options: CaptionOptions) => Promise<boolean>
  getCaptionOverlay: () => BrowserWindow | null
  captureTextTarget: () => Promise<boolean>
  injectText: (text: string) => Promise<boolean>
  waitTextInjectReady: () => Promise<boolean>
  getTextInjectDebugEvents: () => string[]
  writeUserId: (userId: string) => Promise<{ userId: string; path: string }>
  readUserId: () => Promise<string>
  getCaptionRequestCounts: () => { close: number; settings: number }
}

type TestResult = {
  passed: boolean
  value?: unknown
  error?: string
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errorText(error: unknown) {
  return error instanceof Error ? error.stack || error.message : String(error)
}

async function capture(window: BrowserWindow | null, target: string) {
  if (!window || window.isDestroyed()) throw new Error(`无法捕获已销毁窗口: ${path.basename(target)}`)
  const image = await window.webContents.capturePage()
  await fs.writeFile(target, image.toPNG())
  return { path: target, width: image.getSize().width, height: image.getSize().height }
}

async function runTest<T>(runner: () => Promise<T>): Promise<TestResult> {
  try {
    const value = await runner()
    const explicit = value && typeof value === 'object' && 'passed' in value
      ? Boolean((value as { passed?: unknown }).passed)
      : true
    return { passed: explicit, value }
  } catch (error) {
    return { passed: false, error: errorText(error) }
  }
}

function inputWindowHtml() {
  return `
    <!doctype html><html><head><meta charset="utf-8"><title>Amadeus E2E Input</title>
    <style>body{font-family:Segoe UI,sans-serif;padding:24px;background:#eef4ff}textarea{width:100%;height:120px;font-size:18px}</style>
    </head><body><h1>Amadeus 文本注入隔离测试</h1><textarea id="target" autofocus></textarea></body></html>`
}

export async function runAmadeusWindowsE2E(harness: Harness) {
  const outputDir = path.join(app.getPath('userData'), 'e2e')
  await fs.mkdir(outputDir, { recursive: true })
  const tests: Record<string, TestResult> = {}

  try {
    tests.textInjectWarmup = await runTest(async () => {
      const startedAt = performance.now()
      const ready = await harness.waitTextInjectReady()
      return { passed: ready, ready, elapsedMs: performance.now() - startedAt }
    })

    tests.brand = await runTest(async () => {
      const value = await harness.mainWindow.webContents.executeJavaScript(`({
        title: document.title,
        brand: document.querySelector('.brand-block strong')?.textContent || '',
        hasSettings: Boolean(document.querySelector('.sidebar'))
      })`)
      return { passed: value.title === 'Amadeus' && value.brand === 'Amadeus' && value.hasSettings, ...value }
    })

    tests.userId = await runTest(async () => {
      const marker = `amadeus-e2e-${Date.now()}`
      const saved = await harness.writeUserId(marker)
      const read = await harness.readUserId()
      return { passed: read === marker && saved.path.endsWith(path.join('archive', 'userid')), marker, saved, read }
    })

    tests.responsive = await runTest(async () => {
      harness.mainWindow.setSize(720, 520)
      await delay(350)
      const value = await harness.mainWindow.webContents.executeJavaScript(`({
        innerWidth,
        innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        shellColumns: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns
      })`)
      const screenshot = await capture(harness.mainWindow, path.join(outputDir, 'responsive-720x520.png'))
      harness.mainWindow.setSize(1100, 720)
      return {
        passed: value.innerWidth === 720 && value.documentScrollWidth === 720 && value.bodyScrollWidth === 720,
        ...value,
        screenshot
      }
    })

    tests.textInjection = await runTest(async () => {
      const marker = `Amadeus-Codex-E2E-${Date.now()}`
      const inputWindow = new BrowserWindow({ width: 620, height: 320, show: false, title: 'Amadeus E2E Input' })
      try {
        await inputWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(inputWindowHtml())}`)
        inputWindow.show()
        inputWindow.focus()
        inputWindow.webContents.focus()
        await inputWindow.webContents.executeJavaScript(`document.getElementById('target').focus(); document.getElementById('target').value = ''`)
        await delay(250)
        const captured = await harness.captureTextTarget()
        if (!captured) throw new Error('未能捕获隔离 textarea 窗口')
        inputWindow.focus()
        inputWindow.webContents.focus()
        await inputWindow.webContents.executeJavaScript(`document.getElementById('target').focus()`)
        await delay(100)
        const injected = await harness.injectText(marker)
        await delay(550)
        const value = await inputWindow.webContents.executeJavaScript(`document.getElementById('target').value`)
        const screenshot = await capture(inputWindow, path.join(outputDir, 'text-injection.png'))
        return { passed: injected && value === marker, injected, marker, value, screenshot }
      } finally {
        if (!inputWindow.isDestroyed()) inputWindow.close()
      }
    })

    tests.consecutiveTextInjection = await runTest(async () => {
      const first = `连续注入一-${Date.now()}`
      const second = `连续注入二-${Date.now()}`
      const inputWindow = new BrowserWindow({ width: 620, height: 320, show: false, title: 'Amadeus Consecutive Input E2E' })
      try {
        await inputWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(inputWindowHtml())}`)
        inputWindow.show()
        inputWindow.focus()
        inputWindow.webContents.focus()
        await inputWindow.webContents.executeJavaScript(`document.getElementById('target').focus(); document.getElementById('target').value = ''`)
        await delay(250)
        const captured = await harness.captureTextTarget()
        if (!captured) throw new Error('未能捕获连续注入 textarea 窗口')
        inputWindow.focus()
        inputWindow.webContents.focus()
        await inputWindow.webContents.executeJavaScript(`document.getElementById('target').focus()`)
        await delay(100)
        const firstStartedAt = performance.now()
        const firstPromise = harness.injectText(first)
        await delay(300)
        const secondStartedAt = performance.now()
        const secondPromise = harness.injectText(second)
        const [firstResult, secondResult] = await Promise.allSettled([firstPromise, secondPromise])
        const secondCompletedAt = performance.now()
        await delay(100)
        const value = await inputWindow.webContents.executeJavaScript(`document.getElementById('target').value`)
        const secondLatencyMs = secondCompletedAt - secondStartedAt
        const firstInjected = firstResult.status === 'fulfilled' && firstResult.value
        const secondInjected = secondResult.status === 'fulfilled' && secondResult.value
        return {
          passed: secondInjected && (value === second || value === `${first}${second}`) && secondLatencyMs < 500,
          firstInjected,
          secondInjected,
          value,
          firstLatencyMs: secondCompletedAt - firstStartedAt,
          secondLatencyMs,
          thresholdMs: 500
        }
      } finally {
        if (!inputWindow.isDestroyed()) inputWindow.close()
      }
    })

    tests.statusOverlay = await runTest(async () => {
      await harness.showStatusOverlay('recording', 0.46)
      await delay(200)
      const recordingWindow = harness.getStatusOverlay()
      const recording = await recordingWindow?.webContents.executeJavaScript(`({
        title: document.getElementById('title')?.textContent || '',
        detail: document.getElementById('detail')?.textContent || '',
        level: Number.parseFloat(document.querySelector('#wave i:last-child')?.style.height || '0')
      })`)
      const bounds = recordingWindow?.getBounds()
      const workArea = recordingWindow ? screen.getPrimaryDisplay().workArea : null
      const recordingScreenshot = await capture(recordingWindow || null, path.join(outputDir, 'status-recording.png'))
      await harness.showStatusOverlay('thinking', 0, '正在识别并整理文本')
      await delay(1000)
      const thinking = await recordingWindow?.webContents.executeJavaScript(`document.getElementById('title')?.textContent || ''`)
      const thinkingScreenshot = await capture(recordingWindow || null, path.join(outputDir, 'status-thinking.png'))
      const resultMarker = `覆盖层结果-${Date.now()}`
      await harness.showStatusOverlay('result', 0, resultMarker)
      await delay(200)
      const result = await recordingWindow?.webContents.executeJavaScript(`({
        text: document.getElementById('resultText')?.textContent || '',
        copyButton: document.getElementById('btnCopy')?.textContent || '',
        closeButton: document.getElementById('btnClose')?.textContent || ''
      })`)
      const resultScreenshot = await capture(recordingWindow || null, path.join(outputDir, 'status-result.png'))
      await recordingWindow?.webContents.executeJavaScript(`document.getElementById('btnCopy').click()`)
      await delay(200)
      const copied = clipboard.readText()
      await harness.showStatusOverlay('result', 0, resultMarker)
      await recordingWindow?.webContents.executeJavaScript(`document.getElementById('btnClose').click()`)
      await delay(200)
      const centered = Boolean(bounds && workArea
        && Math.abs(bounds.x + bounds.width / 2 - (workArea.x + workArea.width / 2)) <= 2
        && bounds.y > workArea.y + workArea.height / 2)
      return {
        passed: recording?.title === '语音输入中'
          && recording?.detail === ''
          && Number(recording?.level) > 3
          && /^thinking\.{1,3}$/.test(thinking)
          && result?.text === resultMarker
          && result.copyButton.includes('复制')
          && Boolean(result.closeButton)
          && copied === resultMarker
          && !recordingWindow?.isVisible()
          && bounds?.width === 200
          && bounds?.height === 32
          && centered,
        recording,
        thinking,
        result,
        copied,
        bounds,
        workArea,
        centered,
        screenshots: [recordingScreenshot, thinkingScreenshot, resultScreenshot]
      }
    })

    tests.captionOverlay = await runTest(async () => {
      const before = harness.getCaptionRequestCounts()
      await harness.showCaptionOverlay('20:12:41  → 20:13:24\n好啊', {
        fontSize: 22,
        color: '#ffffff',
        backgroundOpacity: 0.82,
        width: 720,
        height: 150,
        x: null,
        y: null
      })
      await delay(250)
      const window = harness.getCaptionOverlay()
      const content = await window?.webContents.executeJavaScript(`({
        text: document.getElementById('text')?.textContent || '',
        settingsButton: Boolean(document.getElementById('settings')),
        closeButton: Boolean(document.getElementById('close'))
      })`)
      const screenshot = await capture(window || null, path.join(outputDir, 'caption-overlay.png'))
      await window?.webContents.executeJavaScript(`document.getElementById('settings').click()`)
      await delay(350)
      const settingsVisible = await harness.mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.settings-page'))`)
      window?.showInactive()
      await window?.webContents.executeJavaScript(`document.getElementById('close').click()`)
      await delay(250)
      const after = harness.getCaptionRequestCounts()
      return {
        passed: content?.text === '20:12:41  → 20:13:24\n好啊'
          && content.settingsButton
          && content.closeButton
          && settingsVisible
          && after.settings === before.settings + 1
          && after.close === before.close + 1
          && !window?.isVisible(),
        content,
        settingsVisible,
        visibleAfterClose: window?.isVisible(),
        before,
        after,
        screenshot
      }
    })

    tests.audioRelay = await runTest(async () => {
      const available = await harness.mainWindow.webContents.executeJavaScript(`typeof window.__amadeusE2EAudio === 'function'`)
      if (!available) throw new Error('renderer 未注册 __amadeusE2EAudio')
      const value = await harness.mainWindow.webContents.executeJavaScript(`window.__amadeusE2EAudio()`, true)
      await fs.writeFile(path.join(outputDir, 'audio-relay.json'), JSON.stringify(value, null, 2), 'utf8')
      return value
    })
  } finally {
    harness.getStatusOverlay()?.hide()
    harness.getCaptionOverlay()?.hide()
  }

  const passed = Object.values(tests).every((test) => test.passed)
  const report = {
    passed,
    startedWith: process.argv,
    platform: process.platform,
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    completedAt: new Date().toISOString(),
    textInjectDebugEvents: harness.getTextInjectDebugEvents(),
    tests
  }
  const reportPath = path.join(outputDir, 'result.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  return { reportPath, report }
}
