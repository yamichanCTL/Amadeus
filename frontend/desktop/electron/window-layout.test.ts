import { describe, expect, it } from 'vitest'
import { calculateInitialWindowBounds } from './window-layout'

describe('initial desktop window bounds', () => {
  it('opens a proportionally sized centered window on a desktop display', () => {
    expect(calculateInitialWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 211,
      y: 94,
      width: 1498,
      height: 853,
    })
  })

  it('caps a large work area at 1600x1000 and centers within its offset', () => {
    expect(calculateInitialWindowBounds({ x: 100, y: 40, width: 2560, height: 1440 })).toEqual({
      x: 580,
      y: 260,
      width: 1600,
      height: 1000,
    })
  })

  it('stays compact without overflowing a smaller work area', () => {
    expect(calculateInitialWindowBounds({ x: 0, y: 0, width: 1280, height: 680 })).toEqual({
      x: 141,
      y: 61,
      width: 998,
      height: 558,
    })
  })

  it('falls back to the full work area at the minimum supported size', () => {
    expect(calculateInitialWindowBounds({ x: 0, y: 0, width: 720, height: 520 })).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 520,
    })
  })
})
