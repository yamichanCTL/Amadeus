// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { closeAction } from './close-behavior'

describe('window close behavior', () => {
  it('quits by default when background mode was not selected', () => {
    expect(closeAction(false)).toBe('quit')
  })

  it('hides only after background mode is explicitly enabled', () => {
    expect(closeAction(true)).toBe('hide')
  })
})
