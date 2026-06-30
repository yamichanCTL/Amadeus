// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASRApi } from './api'

describe('first-run backend confirmation gate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('does not call fetch when the backend address is empty', () => {
    const api = new ASRApi('')

    expect(() => api.health()).toThrow('未确认后端地址')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fall back to localhost before the user confirms an address', async () => {
    const api = new ASRApi('/')

    await expect(api.models()).rejects.toThrow('未确认后端地址')
    expect(fetch).not.toHaveBeenCalled()
  })
})
