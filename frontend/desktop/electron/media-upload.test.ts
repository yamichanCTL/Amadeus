import { describe, expect, it } from 'vitest'
import { buildFfmpegExtractAudioArgs, isVideoUploadPath } from './media-upload'

describe('media upload preparation', () => {
  it('detects video upload paths', () => {
    expect(isVideoUploadPath('/tmp/demo.mp4')).toBe(true)
    expect(isVideoUploadPath('/tmp/demo.MOV')).toBe(true)
    expect(isVideoUploadPath('/tmp/demo.wav')).toBe(false)
  })

  it('builds ffmpeg args that extract mono 16k wav audio without video', () => {
    expect(buildFfmpegExtractAudioArgs('/in/video.mp4', '/out/audio.wav')).toEqual([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '/in/video.mp4',
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '/out/audio.wav',
    ])
  })
})
