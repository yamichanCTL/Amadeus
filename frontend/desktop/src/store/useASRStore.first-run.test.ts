// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, useASRStore } from './useASRStore'

describe('backend confirmation settings gate', () => {
  beforeEach(() => {
    useASRStore.setState({ settings: DEFAULT_SETTINGS })
  })

  it('clears an address that is changed without explicit confirmation', () => {
    useASRStore.getState().updateSettings({ serverUrl: 'http://legacy-backend.test:8000' })

    expect(useASRStore.getState().settings.serverUrl).toBe('')
    expect(useASRStore.getState().settings.backendConfirmed).toBe(false)
  })

  it('keeps the address only when the confirmation flag is written at the same time', () => {
    useASRStore.getState().updateSettings({
      serverUrl: 'backend.test:8000',
      backendConfirmed: true,
    })

    expect(useASRStore.getState().settings.serverUrl).toBe('http://backend.test:8000')
    expect(useASRStore.getState().settings.backendConfirmed).toBe(true)
  })
})
