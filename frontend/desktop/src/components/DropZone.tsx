import { base64ToBlob } from '@/services/audio'
import { useState } from 'react'

export type LocalAudioFile = {
  blob: Blob
  name: string
  path?: string
  originalPath?: string
  extractedFromVideo?: boolean
}

export function DropZone({ onFiles }: { onFiles: (files: LocalAudioFile[]) => void }) {
  const [error, setError] = useState('')
  const pickFiles = async () => {
    const paths = await window.electronAPI?.openAudioDialog()
    if (!paths?.length) return
    try {
      setError('')
      const files = await Promise.all(paths.map(loadLocalFileForUpload))
      onFiles(files)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '准备上传文件失败')
    }
  }

  return (
    <>
      <button
        type="button"
        className="dropzone"
        onClick={pickFiles}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          void (async () => {
            try {
              setError('')
              const files = await Promise.all(Array.from(event.dataTransfer.files).map(async (file) => {
                const path = (file as File & { path?: string }).path
                return path && window.electronAPI?.extractAudioForUpload
                  ? loadLocalFileForUpload(path)
                  : { blob: file, name: file.name }
              }))
              if (files.length) onFiles(files)
            } catch (uploadError) {
              setError(uploadError instanceof Error ? uploadError.message : '准备上传文件失败')
            }
          })()
        }}
      >
        <span className="upload-illustration" aria-hidden="true">
          <span>▣</span>
          <span>⬆</span>
        </span>
        <strong>拖拽音频 / 视频文件到此处，或点击选择文件</strong>
        <span>选择后需要确认，文件不会立即开始识别</span>
        <span>支持 mp3、wav、m4a、mp4、mov、wmv、flv 等格式，单文件最大 2GB</span>
        <span className="drop-actions" aria-hidden="true">
          <span className="fake-primary">选择文件</span>
          <span>从文件夹导入</span>
        </span>
      </button>
      {error && <p className="error">{error}</p>}
    </>
  )
}

async function loadLocalFileForUpload(filePath: string): Promise<LocalAudioFile> {
  const api = window.electronAPI!
  const prepared = api.extractAudioForUpload ? await api.extractAudioForUpload(filePath) : null
  const uploadPath = prepared?.path || filePath
  const info = await api.fileInfo(uploadPath)
  const base64 = await api.readFileBase64(uploadPath)
  return {
    blob: base64ToBlob(base64, 'application/octet-stream'),
    name: prepared?.name || info.name,
    path: uploadPath,
    originalPath: prepared?.originalPath,
    extractedFromVideo: prepared?.extracted,
  }
}
