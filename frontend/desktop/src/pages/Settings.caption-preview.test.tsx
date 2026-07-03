// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/audio', () => ({
  audioRelayMixer: {
    isActive: vi.fn(() => false), getInputLevel: vi.fn(() => 0), getMonitorLevel: vi.fn(() => 0),
    stop: vi.fn(), stopMonitor: vi.fn(), startMonitor: vi.fn(), setOutputDevice: vi.fn(), start: vi.fn(),
  },
  captureSpeakerAudio: vi.fn(),
  listAudioInputDevices: vi.fn(async () => []),
  listAudioOutputDevices: vi.fn(async () => []),
  testAudioInputDevice: vi.fn(),
  testAudioOutputDevice: vi.fn(),
}))

import { SettingsPage } from './Settings'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

describe('caption preview live updates', () => {
  beforeEach(() => {
    useASRStore.setState({ settings: { ...useASRStore.getState().settings, ...DEFAULT_SETTINGS } })
  })

  it('updates an open preview when caption width changes', async () => {
    const showCaptionOverlay = vi.fn(async () => true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { showCaptionOverlay, hideCaptionOverlay: vi.fn(async () => true) },
    })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: '识别与字幕' }))
    fireEvent.click(screen.getByRole('button', { name: '预览字幕框' }))
    await waitFor(() => expect(showCaptionOverlay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ width: 760 })))

    fireEvent.change(screen.getByLabelText(/^字幕宽度/), { target: { value: '900' } })

    await waitFor(() => expect(showCaptionOverlay).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ width: 900 })))
  })
})
