import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Packet = { type: string; pcm?: ArrayBuffer; rms?: number }
type Processor = {
  port: { postMessage: (packet: Packet) => void; onmessage?: (event: { data: { type: string } }) => void }
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
}

const source = readFileSync(resolve(process.cwd(), 'public/realtime-mic-worklet.js'), 'utf8')

describe('shipped microphone worklet', () => {
  it.each([44100, 48000])('keeps one second of %i Hz capture at 16 kHz across quantum boundaries', (rate) => {
    const packets: Packet[] = []
    let ProcessorClass!: new () => Processor
    class BaseProcessor { port = { postMessage: (packet: Packet) => packets.push(packet) } }
    runInNewContext(source, { AudioWorkletProcessor: BaseProcessor, sampleRate: rate,
      registerProcessor: (name: string, constructor: new () => Processor) => {
        expect(name).toBe('amadeus-microphone')
        ProcessorClass = constructor
      } })
    const processor = new ProcessorClass()
    for (let consumed = 0; consumed < rate; consumed += 128) {
      const input = new Float32Array(Math.min(128, rate - consumed)).fill(0.25)
      const output = new Float32Array(input.length).fill(1)
      expect(processor.process([[input]], [[output]])).toBe(true)
      expect(output.every((value) => value === 0)).toBe(true)
    }
    processor.port.onmessage?.({ data: { type: 'flush' } })
    const audio = packets.filter((packet) => packet.type === 'packet')
    const samples = audio.flatMap((packet) => Array.from(new Int16Array(packet.pcm!)))
    expect(Math.abs(samples.length - 16000)).toBeLessThanOrEqual(1)
    expect(samples.every((sample) => sample === 8192)).toBe(true)
    expect(audio.every((packet) => new Int16Array(packet.pcm!).length <= 1600)).toBe(true)
    expect(audio.every((packet) => Math.abs(packet.rms! - 0.25) < 0.00001)).toBe(true)
  })
})
