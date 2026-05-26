import { formatTimestamp } from '@/services/export'
import type { Segment } from '@/services/api'

export function SegmentList({ segments }: { segments: Segment[] }) {
  if (!segments.length) return <p className="empty">暂无分段。</p>

  return (
    <div className="segment-list">
      {segments.map((segment, index) => (
        <div key={`${segment.start}-${index}`} className="segment-row">
          <time>{formatTimestamp(segment.start, '.')} - {formatTimestamp(segment.end, '.')}</time>
          <p>{segment.speaker ? `[${segment.speaker}] ` : ''}{segment.text}</p>
          {typeof segment.confidence === 'number' && <span>{Math.round(segment.confidence * 100)}%</span>}
        </div>
      ))}
    </div>
  )
}
