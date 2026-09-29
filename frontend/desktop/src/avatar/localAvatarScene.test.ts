import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { disposeAvatarScene, frameAvatar, normalizeAvatarScene } from './localAvatarScene'

describe('user supplied GLB scene handling', () => {
  it('fits an offset static mesh without requiring any bones or mouth shapes', () => {
    const scene = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 3), new THREE.MeshStandardMaterial())
    mesh.position.set(30, -5, 10)
    scene.add(mesh)
    const bounds = normalizeAvatarScene(scene)
    const box = new THREE.Box3().setFromObject(scene)
    const center = box.getCenter(new THREE.Vector3())
    expect(bounds.width).toBeCloseTo(1.64)
    expect(box.min.y).toBeCloseTo(0)
    expect(center.x).toBeCloseTo(0)
    expect(center.z).toBeCloseTo(0)
    const camera = new THREE.PerspectiveCamera(38, .5, .05, 100)
    frameAvatar(camera, bounds)
    expect(camera.position.z).toBeGreaterThan(bounds.width)
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true)
    disposeAvatarScene(scene)
  })

  it('rejects a GLB with no visible geometry', () => {
    expect(() => normalizeAvatarScene(new THREE.Group())).toThrow('没有可显示的网格')
  })

  it('releases shared geometry, material and texture once and detaches the old scene', () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map: texture })
    const geometry = new THREE.BoxGeometry()
    const scene = new THREE.Group()
    scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
    const parent = new THREE.Group(); parent.add(scene)
    const spies = [vi.spyOn(texture, 'dispose'), vi.spyOn(material, 'dispose'), vi.spyOn(geometry, 'dispose')]
    disposeAvatarScene(scene)
    spies.forEach(spy => expect(spy).toHaveBeenCalledOnce())
    expect(parent.children).toHaveLength(0)
  })
})
