import { useEffect, useState } from 'react'

type AudioLike = {
  audio_url?: string
  archived_audio?: string
}

function guessMime(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.webm')) return 'audio/webm'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  return 'audio/*'
}

export function AudioPlayer({ item }: { item: AudioLike | null }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let alive = true
    setSrc(item?.audio_url || '')
    if (!item?.audio_url && item?.archived_audio && window.electronAPI?.readFileBase64) {
      window.electronAPI.readFileBase64(item.archived_audio)
        .then((base64) => {
          if (alive) setSrc(`data:${guessMime(item.archived_audio || '')};base64,${base64}`)
        })
        .catch(() => {
          if (alive) setSrc('')
        })
    }
    return () => {
      alive = false
    }
  }, [item?.audio_url, item?.archived_audio])

  if (!src) return <p className="empty">暂无可播放音频。</p>
  return <audio className="audio-player" src={src} controls preload="metadata" />
}
