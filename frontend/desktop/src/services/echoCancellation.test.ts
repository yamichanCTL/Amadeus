// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openEchoCancelledMicrophone } from './echoCancellation'
afterEach(() => vi.unstubAllGlobals())
function device(mode: boolean | string, capabilities: (boolean | string)[] = [true, false]) {
  const track = { getSettings: vi.fn(() => ({ echoCancellation: mode, deviceId: 'physical-mic', sampleRate: 48000 })),
    getCapabilities: () => ({ echoCancellation: capabilities }), applyConstraints: vi.fn(async () => { mode = 'all' }), stop: vi.fn() }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  const getUserMedia = vi.fn(async () => stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { track, stream, getUserMedia }
}
describe('native acoustic echo cancellation', () => {
  it('requires real AEC on a separate physical capture without voice gating or gain control', async () => {
    const { getUserMedia, track } = device(true)
    const result = await openEchoCancelledMicrophone('physical-mic')
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'physical-mic' }, channelCount: { ideal: 1 },
      echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false })
    expect(result.state.mode).toBe('browser'); expect(track.stop).not.toHaveBeenCalled()
  })
  it('requests all-system playback as reference when the device supports that mode', async () => {
    const { track } = device(true, [true, false, 'all', 'remote-only'])
    const result = await openEchoCancelledMicrophone()
    expect(track.applyConstraints).toHaveBeenCalledWith({ echoCancellation: { ideal: 'all' } })
    expect(result.state.mode).toBe('all')
  })
  it('keeps voice input available and reports AEC unavailable instead of claiming success', async () => {
    const { track } = device(false)
    const result = await openEchoCancelledMicrophone()
    expect(result.state.mode).toBe('unavailable')
    expect(track.stop).not.toHaveBeenCalled()
  })
  it('retains the working microphone if advertised all-mode constraints fail', async () => {
    const { track } = device(true, [true, false, 'all'])
    track.applyConstraints.mockRejectedValue(new DOMException('Cannot satisfy constraints', 'OverconstrainedError'))
    const result = await openEchoCancelledMicrophone()
    expect(result.state.mode).toBe('browser')
    expect(track.stop).not.toHaveBeenCalled()
  })
  it('does not require mandatory AEC constraints on Windows microphone acquisition', async () => {
    const { getUserMedia } = device(true)
    const normalCapture = getUserMedia.getMockImplementation()!
    getUserMedia.mockImplementation(async (...args: any[]) => {
      if (typeof args[0]?.audio?.echoCancellation === 'object') throw new DOMException('Cannot satisfy constraints', 'OverconstrainedError')
      return normalCapture()
    })
    expect((await openEchoCancelledMicrophone()).state.mode).toBe('browser')
  })
})
