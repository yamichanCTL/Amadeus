import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { LiveAvatarAudioFrame } from '../services/liveVoiceTypes'
import { MouthController, MOUTH_SHAPES } from '../avatar/mouthController'
import { disposeAvatarScene, frameAvatar, normalizeAvatarScene, type AvatarBounds } from '../avatar/localAvatarScene'
import { watchLocalAvatar } from '../services/localAvatar'
import type { LocalAvatarStatus } from '../vite-env'
import { LocalAvatarPanel } from './LocalAvatarPanel'

type Props = {
  status: string
  emotion: string
  action: string
  gesture?: string
  audioFrameRef?: MutableRefObject<LiveAvatarAudioFrame | null>
  view?: 'portrait' | 'full'
}

const xAxis = new THREE.Vector3(1, 0, 0)
const yAxis = new THREE.Vector3(0, 1, 0)
const zAxis = new THREE.Vector3(0, 0, 1)

export function Aemeath3D({ status, emotion, action, gesture = '', audioFrameRef, view = 'portrait' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({ status, emotion, action, gesture, audioFrameRef, view })
  const [loadError, setLoadError] = useState('')
  const [hasModel, setHasModel] = useState(false)
  const [loading, setLoading] = useState(true)
  stateRef.current = { status, emotion, action, gesture, audioFrameRef, view }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let stopped = false
    let frame = 0
    let blinkAt = 2.6
    let pointerX = 0
    let lastGesture = ''
    let gestureStart = -10
    let model: THREE.Group | null = null
    let cameraView = ''
    let generation = 0
    let loadedRevision: string | null | undefined
    let bounds: AvatarBounds = { width: 1, height: 1.64, depth: .5 }
    let portraitSupported = false
    const mouth = new MouthController()
    canvas.dataset.loaded = 'false'
    canvas.dataset.voiced = 'false'
    canvas.dataset.mouth = '0'
    canvas.dataset.morphCount = '0'
    const bones: Record<string, THREE.Bone> = {}
    const baseQuat: Record<string, THREE.Quaternion> = {}
    const morphMeshes: THREE.Mesh[] = []
    let skeletonRoots: THREE.Bone[] = []
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.6
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100)
    camera.position.set(0, 1.25, 3.1)
    camera.lookAt(0, 1.02, 0)
    scene.add(new THREE.HemisphereLight(0xd6e0ff, 0x594665, 2.1))
    const key = new THREE.DirectionalLight(0xffe9ef, 3.2)
    key.position.set(-2, 3, 3)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xba9aff, 2.2)
    rim.position.set(2, 2, -2)
    scene.add(rim)
    const holder = new THREE.Group()
    scene.add(holder)

    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1)
      const height = Math.max(canvas.clientHeight, 1)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      cameraView = ''
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointerX = THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1)
    }
    const onPointerLeave = () => { pointerX = 0 }
    canvas.addEventListener('pointermove', onPointer)
    canvas.addEventListener('pointerleave', onPointerLeave)

    const clearModel = () => {
      if (model) disposeAvatarScene(model)
      model = null
      morphMeshes.length = 0
      skeletonRoots = []
      for (const key of Object.keys(bones)) { delete bones[key]; delete baseQuat[key] }
      mouth.clear()
      canvas.dataset.loaded = 'false'
      canvas.dataset.morphCount = '0'
      canvas.dataset.mouth = '0'
      canvas.dataset.voiced = 'false'
      setHasModel(false)
    }
    const loadLocalModel = async (status: LocalAvatarStatus) => {
      if (stopped) return
      if (loadedRevision === status.revision && model) return
      loadedRevision = status.revision
      const current = ++generation
      clearModel()
      setLoadError(status.error || '')
      setLoading(status.available)
      if (!status.available) return
      try {
        const bytes = await window.electronAPI!.localAvatarRead()
        if (stopped || current !== generation) return
        if (!bytes) throw new Error('本地模型不存在，请重新导入。')
        const gltf = await new GLTFLoader().parseAsync(bytes, '')
        if (stopped || current !== generation) { disposeAvatarScene(gltf.scene); return }
        try { bounds = normalizeAvatarScene(gltf.scene) } catch (error) { disposeAvatarScene(gltf.scene); throw error }
        model = gltf.scene
        holder.add(model)
        const skinned: THREE.SkinnedMesh[] = []
        portraitSupported = Boolean(model.getObjectByName('頭'))
        model.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(mesh as THREE.SkinnedMesh)
          if (mesh.morphTargetDictionary) morphMeshes.push(mesh)
          if (!portraitSupported) return
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (!material) continue
            material.side = THREE.DoubleSide
            if (material.name.includes('后发+') || material.name.includes('前发+')) {
              material.transparent = true; material.depthWrite = false
            } else {
              material.transparent = false; material.alphaTest = .08; material.depthWrite = true
            }
            material.needsUpdate = true
          }
        })
        for (const bone of skinned[0]?.skeleton.bones || []) {
          bones[bone.name] = bone
          baseQuat[bone.name] = bone.quaternion.clone()
        }
        const allBones = new Set(skinned[0]?.skeleton.bones || [])
        skeletonRoots = [...allBones].filter((bone) => !allBones.has(bone.parent as THREE.Bone))
        cameraView = ''
        canvas.dataset.loaded = 'true'
        canvas.dataset.morphCount = String(Object.keys(morphMeshes[0]?.morphTargetDictionary || {}).length)
        setHasModel(true)
      } catch (error) {
        if (!stopped && current === generation) setLoadError(error instanceof Error ? error.message : '本地 GLB 模型载入失败，请更换文件。')
      } finally { if (!stopped && current === generation) setLoading(false) }
    }
    const unwatch = window.electronAPI?.localAvatarStatus
      ? watchLocalAvatar(window.electronAPI, status => { void loadLocalModel(status) })
      : () => undefined
    if (!window.electronAPI?.localAvatarStatus) setLoading(false)

    const setMorph = (name: string, value: number) => {
      for (const mesh of morphMeshes) {
        const index = mesh.morphTargetDictionary?.[name]
        if (index !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = THREE.MathUtils.clamp(value, 0, 1)
      }
    }
    const rotate = (name: string, axis: THREE.Vector3, radians: number) => {
      const bone = bones[name]
      if (bone) bone.quaternion.copy(baseQuat[name]).multiply(new THREE.Quaternion().setFromAxisAngle(axis, radians))
    }
    const rotateWorld = (name: string, axis: THREE.Vector3, radians: number) => {
      const bone = bones[name]
      if (!bone) return
      const localAxis = axis.clone().applyQuaternion(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()
      bone.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(localAxis, radians)).multiply(baseQuat[name])
    }
    const clock = new THREE.Clock()
    const animate = () => {
      if (stopped) return
      frame = requestAnimationFrame(animate)
      const now = clock.getElapsedTime()
      const current = stateRef.current
      if (cameraView !== current.view) {
        cameraView = current.view
        if (cameraView === 'portrait' && portraitSupported) {
          camera.position.set(0, 1.43, 1.05)
          camera.lookAt(0, 1.34, 0)
        } else {
          frameAvatar(camera, bounds)
        }
        camera.updateProjectionMatrix()
      }
      if (current.gesture && current.gesture !== lastGesture) { lastGesture = current.gesture; gestureStart = now }
      const gestureT = THREE.MathUtils.clamp((now - gestureStart) / 2.1, 0, 1)
      const wave = current.gesture === 'wave' && gestureT < 1 ? Math.sin(Math.PI * gestureT) : 0
      const dance = current.gesture === 'dance' && gestureT < 1 ? Math.sin(Math.PI * gestureT) : 0
      if (model) {
        for (const [name, bone] of Object.entries(bones)) bone.quaternion.copy(baseQuat[name])
        const listening = current.status === 'listening' || current.action === 'listening'
        const thinking = current.status === 'thinking' || current.action === 'thinking'
        rotate('上半身', xAxis, Math.sin(now * 1.7) * 0.025 + (listening ? -0.025 : 0) + dance * Math.sin(now * 5) * 0.08)
        rotate('頭', yAxis, pointerX * 0.12 + (thinking ? Math.sin(now * 2.1) * 0.08 : 0))
        rotateWorld('腕R', zAxis, 0.88 - wave * 1.93 - dance * 0.55 * (1 + Math.sin(now * 5)))
        rotateWorld('腕L', zAxis, -0.88 + dance * 0.45 * (1 - Math.sin(now * 5)))
        if (now > blinkAt + 0.22) blinkAt = now + 2.8 + Math.random() * 2.2
        setMorph('まばたき', now >= blinkAt ? Math.sin(Math.PI * THREE.MathUtils.clamp((now - blinkAt) / 0.22, 0, 1)) : 0)
        setMorph('にこり', Math.max(wave * 0.55, current.emotion === 'happy' ? 0.4 : 0))
        const audio = current.audioFrameRef?.current
        if (audio) mouth.push(audio)
        else mouth.clear()
        const pose = mouth.sample()
        for (const vowel of Object.keys(MOUTH_SHAPES) as (keyof typeof MOUTH_SHAPES)[]) {
          setMorph(MOUTH_SHAPES[vowel], pose.weights[vowel])
        }
        const actualMouth = Object.fromEntries(Object.entries(MOUTH_SHAPES).map(([vowel, name]) => {
          const mesh = morphMeshes[0]
          const index = mesh?.morphTargetDictionary?.[name]
          return [vowel, index === undefined ? 0 : mesh.morphTargetInfluences?.[index] || 0]
        }))
        canvas.dataset.voiced = String(pose.voiced)
        canvas.dataset.mouth = String(Math.max(...Object.values(actualMouth)))
        canvas.dataset.mouthWeights = JSON.stringify(actualMouth)
        canvas.dataset.audioEpoch = String(pose.epoch)
        for (const root of skeletonRoots) root.updateMatrixWorld(true)
      }
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      stopped = true
      generation += 1
      unwatch()
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('pointermove', onPointer)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      if (model) disposeAvatarScene(model)
      renderer.dispose()
      renderer.forceContextLoss()
    }
  }, [])

  return <>
    <canvas ref={canvasRef} className="agent-model-3d" aria-label="本地 3D 模型" />
    {!hasModel && <div className="agent-local-avatar-empty"><div>
      {loading ? <p>正在加载本地模型……</p> : <LocalAvatarPanel compact />}
      {loadError && <p role="alert">{loadError}</p>}
    </div></div>}
  </>
}
