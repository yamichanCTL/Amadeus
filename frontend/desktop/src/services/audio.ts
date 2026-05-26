export class AudioRecorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: BlobPart[] = []
  private startedAt = 0

  async start(deviceId?: string) {
    if (this.recorder) throw new Error('录音已在进行中')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    })

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    this.chunks = []
    this.startedAt = Date.now()
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start()
  }

  async stop() {
    if (!this.recorder) throw new Error('录音尚未开始')
    const recorder = this.recorder
    const mimeType = recorder.mimeType || 'audio/webm'
    const durationSec = (Date.now() - this.startedAt) / 1000

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.stop()
    await stopped
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    return { blob: new Blob(this.chunks, { type: mimeType }), durationSec, mimeType }
  }

  cancel() {
    this.recorder?.stop()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.recorder = null
    this.stream = null
    this.chunks = []
  }
}

export class AudioSegmentStreamer {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private timer: number | null = null
  private readonly onSegment: (blob: Blob) => void

  constructor(onSegment: (blob: Blob) => void) {
    this.onSegment = onSegment
  }

  async start(source: 'speaker' | 'microphone', chunkSec: number, deviceId?: string) {
    if (this.recorder) throw new Error('实时字幕已在运行')
    this.stream =
      source === 'speaker'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined }, video: false })

    this.stream.getVideoTracks().forEach((track) => track.stop())
    this.startRecorder()
    this.timer = window.setInterval(() => this.rotateRecorder(), Math.max(2, chunkSec) * 1000)
  }

  stop() {
    if (this.timer) window.clearInterval(this.timer)
    this.timer = null
    this.recorder?.stop()
    this.recorder = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }

  private startRecorder() {
    if (!this.stream) return
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((item) => MediaRecorder.isTypeSupported(item))
    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      if (chunks.length > 0) this.onSegment(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
    }
    this.recorder = recorder
    recorder.start()
  }

  private rotateRecorder() {
    if (!this.recorder || this.recorder.state === 'inactive') return
    this.recorder.stop()
    this.startRecorder()
  }
}

export async function listAudioInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audioinput')
}

export async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

export function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}
