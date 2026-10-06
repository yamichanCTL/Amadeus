/** Prepare the hidden surface before input. A late creation/update must never
 * show an overlay after cancel, or replace a newer recognition phase. */
export interface WarmOverlaySurface<T> {
  isDestroyed(): boolean
  apply(value: T): void
  showInactive(): void
  hide(): void
}

export class WarmOverlay<T> {
  private surface: WarmOverlaySurface<T> | null = null
  private pending: Promise<WarmOverlaySurface<T>> | null = null
  private revision = 0

  constructor(private readonly create: () => Promise<WarmOverlaySurface<T>>) {}

  async prepare(): Promise<WarmOverlaySurface<T>> {
    if (this.surface && !this.surface.isDestroyed()) return this.surface
    if (!this.pending) {
      this.pending = this.create().then(surface => {
        this.surface = surface
        return surface
      }).finally(() => { this.pending = null })
    }
    return this.pending
  }

  async show(value: T): Promise<boolean> {
    const revision = ++this.revision
    const surface = await this.prepare()
    if (revision !== this.revision || surface.isDestroyed()) return false
    surface.apply(value)
    surface.showInactive()
    return true
  }

  hide(): void {
    ++this.revision
    if (this.surface && !this.surface.isDestroyed()) this.surface.hide()
  }
}
