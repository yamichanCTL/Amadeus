import type { ReactNode } from 'react'

function safeLink(href: string) {
  return /^(https?:|mailto:)/i.test(href) ? href : ''
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const token = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (match[2]) nodes.push(<strong key={`${keyPrefix}-${match.index}`}>{match[2]}</strong>)
    else if (match[3]) nodes.push(<code key={`${keyPrefix}-${match.index}`}>{match[3]}</code>)
    else {
      const href = safeLink(match[5] || '')
      nodes.push(href
        ? <a key={`${keyPrefix}-${match.index}`} href={href} target="_blank" rel="noreferrer">{match[4]}</a>
        : match[4])
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: { language: string; lines: string[] } | null = null

  const flushParagraph = () => {
    if (!paragraph.length) return
    const text = paragraph.join('\n')
    blocks.push(<p key={`p-${blocks.length}`}>{renderInline(text, `p-${blocks.length}`)}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`list-${blocks.length}`}>
        {list.items.map((item, index) => <li key={index}>{renderInline(item, `li-${blocks.length}-${index}`)}</li>)}
      </Tag>
    )
    list = null
  }

  lines.forEach((line) => {
    const fence = line.match(/^```\s*([^\s]*)/)
    if (fence) {
      flushParagraph()
      flushList()
      if (code) {
        blocks.push(<pre key={`code-${blocks.length}`}><code data-language={code.language}>{code.lines.join('\n')}</code></pre>)
        code = null
      } else code = { language: fence[1] || '', lines: [] }
      return
    }
    if (code) {
      code.lines.push(line)
      return
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      const Heading = `h${level}` as keyof JSX.IntrinsicElements
      blocks.push(<Heading key={`h-${blocks.length}`}>{renderInline(heading[2], `h-${blocks.length}`)}</Heading>)
      return
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (unordered || ordered) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      if (list && list.ordered !== isOrdered) flushList()
      if (!list) list = { ordered: isOrdered, items: [] }
      list.items.push((ordered || unordered)?.[1] || '')
      return
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push(<hr key={`hr-${blocks.length}`} />)
      return
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push(<blockquote key={`quote-${blocks.length}`}>{renderInline(quote[1], `quote-${blocks.length}`)}</blockquote>)
      return
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      return
    }
    flushList()
    paragraph.push(line)
  })
  flushParagraph()
  flushList()
  const unfinishedCode = code as { language: string; lines: string[] } | null
  if (unfinishedCode) blocks.push(<pre key={`code-${blocks.length}`}><code data-language={unfinishedCode.language}>{unfinishedCode.lines.join('\n')}</code></pre>)

  return <div className="markdown-content">{blocks}</div>
}
