import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownContent } from './MarkdownContent'

describe('MarkdownContent', () => {
  it('renders headings, lists and emphasis without raw HTML execution', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'## 总览\n\n- **结论**：完成\n- `TODO`\n\n<script>alert(1)</script>'} />)
    expect(html).toContain('<h2>总览</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>结论</strong>')
    expect(html).toContain('<code>TODO</code>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
})
