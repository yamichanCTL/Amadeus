import { beforeEach, describe, expect, it } from 'vitest'
import { connectLocalRuntime, isSelectedLocalRuntime } from './localRuntimeConnection'
import type { LocalRuntimeState } from './localRuntimeTypes'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'

const running: LocalRuntimeState = { phase: 'running', installed: true, owned: true, url: 'http://127.0.0.1:8768', message: '', root: 'F:/fixture', logPath: '', autoStart: false }
beforeEach(() => { localStorage.clear(); useASRStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) }) })

describe('selected local backend identity', () => {
  it('matches normalized current runtime URLs and retains identity when installation clears the URL', () => {
    connectLocalRuntime(running, true)
    expect(isSelectedLocalRuntime(running, ' http://127.0.0.1:8768/ ')).toBe(true)
    expect(isSelectedLocalRuntime({ ...running, phase: 'installing', url: null, owned: false }, running.url!)).toBe(true)
    expect(isSelectedLocalRuntime({ ...running, phase: 'starting', url: null, owned: false }, 'https://remote.example.test')).toBe(false)
  })

  it('does not guess local ownership when neither a live nor remembered URL is available', () => {
    expect(isSelectedLocalRuntime({ ...running, phase: 'installing', url: null, owned: false }, running.url!)).toBe(false)
    expect(isSelectedLocalRuntime(null, running.url!)).toBe(false)
    expect(isSelectedLocalRuntime(running, '')).toBe(false)
  })
})
