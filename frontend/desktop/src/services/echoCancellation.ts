/** Native WebRTC acoustic echo cancellation; never a playback-time input gate. */
export type EchoCancellationState = {
  mode: 'all' | 'browser' | 'unavailable' | 'unknown'
  deviceId: string
  sampleRate?: number
}

function isConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error
    && ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotSupportedError'].includes(String(error.name))
}

export async function openEchoCancelledMicrophone(deviceId?: string): Promise<{ stream: MediaStream; state: EchoCancellationState }> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: 1 },
        // A preference, not an admission requirement: some Windows drivers reject
        // exact:true despite supporting the browser's normal AEC processing path.
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    })
  } catch (error) {
    if (isConstraintError(error)) {
      const constraint = (error as Error & { constraint?: string }).constraint
      throw new Error(constraint === 'deviceId'
        ? '所选麦克风不可用，请在设置中重新选择输入设备。'
        : `麦克风无法采用当前采集设置${constraint ? `（${constraint}）` : ''}，请检查输入设备。`)
    }
    throw error
  }
  try {
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('未获取到麦克风音轨。')
    const capabilities = track.getCapabilities?.() as { echoCancellation?: (boolean | string)[] } | undefined
    if (capabilities?.echoCancellation?.includes('all')) {
      try {
        // Advertising a capability does not guarantee that this device/driver can
        // apply it now. Negotiate all-system reference without making capture fail.
        await track.applyConstraints({ echoCancellation: { ideal: 'all' } } as unknown as MediaTrackConstraints)
      } catch (error) {
        if (!isConstraintError(error)) throw error
        // applyConstraints failure leaves the already acquired browser-AEC track
        // intact. Keep it and report getSettings(), never the requested mode.
      }
    }
    const settings = track.getSettings() as Omit<MediaTrackSettings, 'echoCancellation'> & { echoCancellation?: boolean | string }
    const mode = settings.echoCancellation === 'all' ? 'all'
      : settings.echoCancellation === true ? 'browser'
        : settings.echoCancellation === false ? 'unavailable' : 'unknown'
    return { stream, state: { mode, deviceId: settings.deviceId || deviceId || '', sampleRate: settings.sampleRate } }
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }
}
