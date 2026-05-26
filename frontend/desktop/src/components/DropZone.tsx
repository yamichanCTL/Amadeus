import { base64ToBlob } from '@/services/audio'

export type LocalAudioFile = {
  blob: Blob
  name: string
  path?: string
}

export function DropZone({ onFiles }: { onFiles: (files: LocalAudioFile[]) => void }) {
  const pickFiles = async () => {
    const paths = await window.electronAPI?.openAudioDialog()
    if (!paths?.length) return
    const files = await Promise.all(
      paths.map(async (filePath) => {
        const info = await window.electronAPI!.fileInfo(filePath)
        const base64 = await window.electronAPI!.readFileBase64(filePath)
        return { blob: base64ToBlob(base64, 'application/octet-stream'), name: info.name, path: filePath }
      })
    )
    onFiles(files)
  }

  return (
    <button
      type="button"
      className="dropzone"
      onClick={pickFiles}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const files = Array.from(event.dataTransfer.files).map((file) => ({ blob: file, name: file.name }))
        if (files.length) onFiles(files)
      }}
    >
      <span className="upload-illustration" aria-hidden="true">
        <span>▣</span>
        <span>⬆</span>
      </span>
      <strong>拖拽音频 / 视频文件到此处，或点击选择文件</strong>
      <span>支持 mp3、wav、m4a、mp4、mov、wmv、flv 等格式，单文件最大 2GB</span>
      <span className="drop-actions" aria-hidden="true">
        <span className="fake-primary">选择文件</span>
        <span>从文件夹导入</span>
      </span>
    </button>
  )
}
