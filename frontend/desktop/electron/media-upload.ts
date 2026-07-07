import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type UploadAudioExtraction = {
  extracted: boolean
  path: string
  name: string
  originalPath: string
}

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.avi',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
])

export function isVideoUploadPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function buildFfmpegExtractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]
}

export async function extractAudioForUpload(filePath: string): Promise<UploadAudioExtraction> {
  if (!isVideoUploadPath(filePath)) {
    return {
      extracted: false,
      path: filePath,
      name: path.basename(filePath),
      originalPath: filePath,
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-upload-audio-'))
  const baseName = path.basename(filePath, path.extname(filePath)).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'video'
  const outputPath = path.join(tempDir, `${baseName}.wav`)
  await runFfmpeg(buildFfmpegExtractAudioArgs(filePath, outputPath))
  return {
    extracted: true,
    path: outputPath,
    name: `${baseName}.wav`,
    originalPath: filePath,
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error('未找到 ffmpeg，无法在前端从视频中提取音频。请安装 ffmpeg 并加入 PATH，或先手动导出音频后上传。'))
        return
      }
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(`ffmpeg 提取视频音频失败${detail ? `：${detail}` : ''}`))
    })
  })
}
