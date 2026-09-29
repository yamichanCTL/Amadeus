import * as THREE from 'three'

export interface AvatarBounds { width: number; height: number; depth: number }

/** Fit arbitrary user models into the shared stage without editing their source files. */
export function normalizeAvatarScene(scene: THREE.Object3D): AvatarBounds {
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const max = Math.max(size.x, size.y, size.z)
  if (box.isEmpty() || !Number.isFinite(max) || max <= 0) throw new Error('模型没有可显示的网格。')
  const center = box.getCenter(new THREE.Vector3())
  const scale = 1.64 / max
  scene.scale.multiplyScalar(scale)
  scene.position.set((scene.position.x - center.x) * scale,
    (scene.position.y - box.min.y) * scale, (scene.position.z - center.z) * scale)
  scene.updateMatrixWorld(true)
  return { width: size.x * scale, height: size.y * scale, depth: size.z * scale }
}

export function frameAvatar(camera: THREE.PerspectiveCamera, bounds: AvatarBounds): void {
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const distance = Math.max(bounds.height / 2, bounds.width / (2 * Math.max(.1, camera.aspect))) / tangent * 1.18 + bounds.depth / 2
  camera.position.set(0, bounds.height * .57, Math.max(distance, .5))
  camera.lookAt(0, bounds.height * .5, 0)
  camera.updateProjectionMatrix()
}

/** GLTF resources survive removing a group; explicitly release them on replacement. */
export function disposeAvatarScene(scene: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
    const skinned = mesh as THREE.SkinnedMesh
    if (skinned.isSkinnedMesh && skinned.skeleton.boneTexture) textures.add(skinned.skeleton.boneTexture)
  })
  geometries.forEach(value => value.dispose())
  materials.forEach(value => value.dispose())
  const bitmaps = new Set<ImageBitmap>()
  textures.forEach(value => {
    value.dispose()
    if (typeof ImageBitmap !== 'undefined' && value.image instanceof ImageBitmap) bitmaps.add(value.image)
  })
  bitmaps.forEach(value => value.close())
  scene.removeFromParent()
}
