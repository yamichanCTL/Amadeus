import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8')

describe('desktop overlay implementation', () => {
  it('marks the caption surface draggable while keeping buttons clickable', () => {
    expect(source).toContain('-webkit-app-region: drag; cursor: move;')
    expect(source).toContain('-webkit-app-region: no-drag;')
  })

  it('keeps synchronous Electron clipboard writes out of text injection', () => {
    const injection = source.slice(source.indexOf('async function injectText(text: string)'), source.indexOf('function registerIpc()'))
    expect(injection).not.toContain('clipboard.writeText')
    expect(injection).toContain('textInjectQueue.run')
    expect(source).not.toContain('clipboard.writeText')
  })

  it('hides the offline result overlay for both copy and close actions', () => {
    expect(source).toMatch(/statusOverlay:copyResultDone[\s\S]{0,160}statusOverlay\?\.hide\(\)/)
    expect(source).toMatch(/statusOverlay:closeResult[\s\S]{0,120}statusOverlay\?\.hide\(\)/)
  })
})
