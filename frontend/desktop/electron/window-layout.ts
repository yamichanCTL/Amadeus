export type WorkArea = { x: number; y: number; width: number; height: number }

/**
 * Keep the initial window non-maximized while using the complete vertical work
 * area. On smaller displays the full width is required; on desktop displays a
 * 90% width leaves a clear non-maximized affordance.
 */
export function calculateInitialWindowBounds(workArea: WorkArea) {
  const width = workArea.width < 1440 ? workArea.width : Math.round(workArea.width * 0.9)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y,
    width,
    height: workArea.height,
  }
}

