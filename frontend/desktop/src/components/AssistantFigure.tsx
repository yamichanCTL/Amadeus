import { useEffect, useState } from 'react'
import assistantHappy from '../../../../img/Amadeus/asr_assistant_happy.png'

function removeGreenScreen(source: string, onReady: (value: string) => void) {
  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) {
      onReady(source)
      return
    }
    context.drawImage(image, 0, 0)
    const frame = context.getImageData(0, 0, canvas.width, canvas.height)
    const data = frame.data
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index]
      const green = data[index + 1]
      const blue = data[index + 2]
      const isGreenScreen = green > 120 && green > red * 1.35 && green > blue * 1.35
      if (isGreenScreen) {
        const strength = Math.min(255, Math.max(0, (green - Math.max(red, blue)) * 2.2))
        data[index + 3] = Math.max(0, 255 - strength)
      }
    }
    context.putImageData(frame, 0, 0)
    onReady(canvas.toDataURL('image/png'))
  }
  image.onerror = () => onReady(source)
  image.src = source
}

export function AssistantFigure({
  action = 'idle',
  className = '',
  emotion = 'neutral'
}: {
  action?: string
  className?: string
  emotion?: string
}) {
  const [source, setSource] = useState(assistantHappy)

  useEffect(() => {
    removeGreenScreen(assistantHappy, setSource)
  }, [])

  return (
    <img
      className={`${className} emotion-${emotion} action-${action}`.trim()}
      src={source}
      alt="Amadeus 助手"
      draggable={false}
    />
  )
}
