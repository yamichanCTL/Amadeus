export type WorkArea = { x: number; y: number; width: number; height: number }

/** Keep the first launch compact, centered, and inside the available work area. */
export function calculateInitialWindowBounds(workArea: WorkArea) {
  const width = Math.min(
    workArea.width,
    Math.max(720, Math.min(1600, Math.round(workArea.width * 0.78))),
  )
  const height = Math.min(
    workArea.height,
    Math.max(520, Math.min(1000, Math.round(workArea.height * 0.82))),
  )
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  }
}
