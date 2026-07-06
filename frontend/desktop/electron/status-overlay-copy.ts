export function copyOverlayResultNonBlocking(
  text: string,
  writeText: (value: string) => void,
  notify: (value: string) => void,
  schedule: (callback: () => void) => void = (callback) => window.setTimeout(callback, 0),
) {
  notify(text)
  schedule(() => {
    writeText(text)
  })
  return true
}
