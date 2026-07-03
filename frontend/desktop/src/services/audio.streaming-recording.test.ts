import { describe, expect, it } from 'vitest'
import { PcmRecordingBuffer } from './audio'

describe('realtime PCM recording buffer', () => {
  it('exports all streamed PCM frames as a valid mono WAV', async () => {
    const recorder = new PcmRecordingBuffer()
    recorder.append(new Int16Array([1, 2, 3]), 16000)
    recorder.append(new Int16Array([4, 5]), 16000)

    const result = recorder.finish()
    expect(result).not.toBeNull()
    expect(result?.samples).toBe(5)
    expect(result?.durationSec).toBe(5 / 16000)
    const bytes = new Uint8Array(await result!.blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(10)
  })

  it('is session-scoped and returns null after the buffer is consumed', () => {
    const recorder = new PcmRecordingBuffer()
    recorder.append(new Int16Array([8, 9]), 16000)
    expect(recorder.finish()?.samples).toBe(2)
    expect(recorder.finish()).toBeNull()
  })
})
