import { describe, expect, it } from 'vitest'
import { calculateInitialWindowBounds } from './window-layout'

describe('initial desktop window bounds', () => {
  it('uses the full work-area height so every sidebar task remains visible', () => {
    expect(calculateInitialWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 96,
      y: 0,
      width: 1728,
      height: 1040,
    })
  })

  it('never overflows a smaller work area', () => {
    expect(calculateInitialWindowBounds({ x: 0, y: 0, width: 1280, height: 680 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 680,
    })
  })
})

