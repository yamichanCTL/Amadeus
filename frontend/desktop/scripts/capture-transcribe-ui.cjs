let electron
try {
  electron = require('electron/main')
} catch {
  electron = require('electron')
}
const app = electron.app || electron.default?.app
const BrowserWindow = electron.BrowserWindow || electron.default?.BrowserWindow
const fs = require('node:fs/promises')
const path = require('node:path')

const targetIndex = process.argv.findIndex((arg) => /^https?:\/\//.test(arg))
const target = targetIndex >= 0 ? process.argv[targetIndex] : 'http://127.0.0.1:5174/'
const outDir = targetIndex >= 0 && process.argv[targetIndex + 1]
  ? process.argv[targetIndex + 1]
  : path.resolve(process.cwd(), '../../tmp/ui-screenshots')
let sharedWindow = null

async function capture(width, height, name, pageIndex = 2) {
  const win = sharedWindow || new BrowserWindow({
    width: 1366,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  if (!sharedWindow) {
    sharedWindow = win
    await win.loadURL(target)
    await win.webContents.executeJavaScript(`
    localStorage.setItem('asr-desktop-store', JSON.stringify({
      state: {
        settings: {
          serverUrl: '',
          backendConfirmed: false,
          offlineEngine: 'sensevoice',
          streamingEngine: 'x-asr',
          defaultLanguage: 'zh',
          whisperModel: 'base',
          enablePunctuation: false,
          theme: 'windows',
          inputSource: 'file',
          liveCaptionEnabled: false,
          showDesktopCaptions: true,
          liveCaptionChunkSec: 4,
          captionFontSize: 20,
          captionFontColor: '#ffffff',
          captionBackgroundOpacity: 0.86,
          captionBoxWidth: 760,
          captionBoxHeight: 150,
          captionBoxX: null,
          captionBoxY: null,
          triggerType: 'keyboard',
          triggerKey: 'AltRight',
          injectMode: 'inject',
          timeoutSec: 20,
          allowServerDataCollection: false,
          archiveDir: '',
          audioInputDeviceId: '',
          audioOutputDeviceId: '',
          llmBaseUrl: 'https://api.deepseek.com',
          llmProvider: 'deepseek',
          llmModel: 'deepseek-chat',
          llmApiToken: '',
          llmTargetLanguage: 'English',
          llmStyle: '',
          llmPolishPrompt: `你是一个专业的 ASR 转写结果后处理模型。你的任务是对输入文本进行纠错、断句、标点补全和轻度润色，使其更准确、更自然、更适合接入后续 LLM 理解。

输入只有一段 ASR 转写文本。输出只允许返回润色后的文本，不要解释，不要列修改点，不要输出 JSON，不要添加任何额外内容。

处理规则：

保持原意不变
只能修正明显的识别错误、错别字、同音词错误、断句错误、标点缺失和口语重复。不得改写用户意图，不得扩展内容，不得添加用户没有说过的信息。
优先准确，其次流畅
不要为了让句子更漂亮而改变表达。口语可以适度整理，但不要过度书面化。
不确定时保守处理
如果某个词无法确定是否识别错误，优先保留原文，不要强行猜测。
处理口语冗余
可以删除无意义的语气词、停顿词和重复词，例如“嗯”“啊”“那个”“就是”“然后然后”等，但不要删除有实际语义的内容。
修正同音词和近音词
根据上下文修正明显不合理的词。例如：
“在带”可改为“再带”，“模型树”可改为“模型数”，“权限县”可改为“权限项”。
保留专业词汇
遇到技术词、产品名、模型名、英文缩写、接口名、路径、命令、端口、URL、IP 地址时，应尽量保持原样，不要擅自翻译或改写。例如：
ASR、TTS、LLM、CTC、CLAP、DASM、FastAPI、Electron、WebSocket、CUDA、NPU、GPU、Docker、uv、conda、127.0.0.1:8002。
处理中英混说和 code-switch
如果 ASR 将常见英文单词、技术词、品牌名、命令词或缩写识别成中文音译，应根据上下文转换为正确英文形式。
例如：
“哈喽”可改为“hello”；
“拜拜”可改为“bye”；
“欧喷 AI”可改为“OpenAI”；
“叉特 GPT”可改为“ChatGPT”；
“派森”可改为“Python”；
“贾瓦斯克瑞普特”可改为“JavaScript”；
“扣得”在编程上下文中可改为“code”；
“命令 line”可改为“command line”；
“GPU server”应保留为“GPU server”。

但不要强行把正常中文翻译成英文。只有当输入明显是英文音译、英文缩写或中英混说时，才进行转换。

规范数字和符号
可以将语音化数字转换为常见书面形式。例如：
“八零零二端口”改为“8002 端口”；
“一二七点零点零点一冒号八零零二”改为“127.0.0.1:8002”；
“二零二六年七月一号”改为“2026 年 7 月 1 日”。
问句和命令句要清晰
如果输入是问题，输出应保持为自然的问题句。
如果输入是命令，输出应保持为简洁明确的命令句。
不要把命令扩写成解释，不要把问题改成陈述。
代码、命令、路径谨慎处理
不要润色代码、命令、文件路径和参数。只有在明显是 ASR 识别错误时，才进行修正。例如：
“CUDA visible devices 等于七”可以改为“CUDA_VISIBLE_DEVICES=7”。
输出要求
只输出润色后的最终文本。不要输出解释、原因、编号、引号、Markdown、JSON 或任何额外说明。

输入文本：
`,
          llmAutoPolish: true,
          llmAutoTranslate: false
        },
        history: Array.from({ length: 8 }, (_, index) => ({
          id: 'visual-' + index,
          task_id: 'visual-' + index,
          status: 'success',
          full_text: '这是一条用于验证不同分辨率下历史列表与详情面板不会互相覆盖的识别结果。',
          language: 'zh',
          engine_used: 'fireredasr2',
          confidence: 0.96,
          duration_sec: 2.6,
          elapsed_sec: 0.4,
          segments: [],
          llm_outputs: { polish: { text: '这是润色后的测试结果。', operation: 'polish', model: 'visual-model', elapsed_sec: 0.1 } },
          created_at: new Date(Date.now() - index * 60000).toISOString(),
          filename: 'recording_responsive_layout_' + index + '.webm'
        }))
      },
      version: 34
    }))
    location.reload()
    `)
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  win.setSize(width, height)
  await win.webContents.executeJavaScript(`document.querySelectorAll('.sidebar button')[${pageIndex}]?.click()`)
  await new Promise((resolve) => setTimeout(resolve, 450))
  const layout = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('.history-list')?.getBoundingClientRect()
    const detail = document.querySelector('.history-detail')?.getBoundingClientRect()
    const overlaps = Boolean(list && detail
      && list.left < detail.right && list.right > detail.left
      && list.top < detail.bottom && list.bottom > detail.top)
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      overlaps,
      columns: document.querySelector('.history-workspace')
        ? getComputedStyle(document.querySelector('.history-workspace')).gridTemplateColumns
        : null
    }
  })()`)
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, name)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(file, image.toPNG())
  return { file, layout }
}

app.whenReady().then(async () => {
  try {
    const reports = [
      await capture(1366, 900, 'transcribe-1366x900.png'),
      await capture(760, 720, 'transcribe-760x720.png'),
      await capture(1280, 720, 'history-1280x720.png', 3),
      await capture(1280, 960, 'history-1280x960.png', 3),
      await capture(720, 520, 'history-720x520.png', 3),
    ]
    console.log(JSON.stringify(reports, null, 2))
    const failed = reports.some(({ layout }) => layout.scrollWidth !== layout.width || layout.overlaps)
    if (failed) process.exitCode = 1
  } finally {
    sharedWindow?.destroy()
    app.quit()
  }
})
