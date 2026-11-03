import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import styles from './Image3d.module.scss'

/**
 * Built-in 3D viewer for Image → 3D outputs (claude1 2026-11-03).
 * mesh  = glTF binary (TRELLIS.2 / UniForge3D / Hunyuan3D-2.1), PBR-lit with a room environment, orbit controls.
 * splat = 3D Gaussian Splatting PLY (Idol), drawn with @mkkellogg/gaussian-splats-3d (its own renderer and camera).
 * Image-to-3D outputs are unit-normalized, so the size readout is in model units - scale with ailab-scale.py.
 */
export interface ViewOpts { wireframe: boolean; autoRotate: boolean; dark: boolean; grid: boolean }

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3))

export const Model3dCanvas: React.FC<{ url: string; type: 'mesh' | 'splat'; opts: ViewOpts; resetKey?: number }> = ({ url, type, opts, resetKey }) => {
  const host = useRef<HTMLDivElement>(null)
  const meshCtx = useRef<{ scene: THREE.Scene; controls: OrbitControls; root?: THREE.Object3D; grid: THREE.GridHelper; fit: () => void } | null>(null)
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; pct?: number; msg?: string; info?: string }>({ phase: 'loading' })

  // ---- mesh viewer ----------------------------------------------------------------------------
  useEffect(() => {
    if (type !== 'mesh' || !host.current) return
    const el = host.current
    let disposed = false
    setState({ phase: 'loading', pct: 0 })
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 1000)
    camera.position.set(1.6, 1.0, 2.2)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(3, 5, 4); scene.add(sun)
    const grid = new THREE.GridHelper(4, 40, 0x888888, 0x444444); (grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.35; scene.add(grid)

    const fit = () => {
      const root = meshCtx.current?.root
      if (!root) return
      const box = new THREE.Box3().setFromObject(root)
      const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3())
      const r = Math.max(size.x, size.y, size.z) || 1
      controls.target.copy(center)
      camera.position.copy(center).add(new THREE.Vector3(0.9, 0.55, 1.25).multiplyScalar(r * 1.25))
      camera.near = r / 1000; camera.far = r * 100; camera.updateProjectionMatrix()
      grid.position.y = box.min.y; grid.scale.setScalar(r / 2)
    }
    meshCtx.current = { scene, controls, grid, fit }

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize); ro.observe(el); resize()
    let raf = 0
    const tick = () => { raf = requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera) }
    tick()

    new GLTFLoader().load(url, (gltf) => {
      if (disposed) return
      const root = gltf.scene; scene.add(root)
      meshCtx.current!.root = root
      let tris = 0
      root.traverse((o: any) => { if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 })
      const s = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
      fit()
      setState({ phase: 'ready', info: `${Math.round(tris).toLocaleString()} triangles · ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} model units (W × H × D)` })
    }, (ev) => {
      if (!disposed && ev.total) setState({ phase: 'loading', pct: Math.round((ev.loaded / ev.total) * 100) })
    }, (err: any) => {
      if (!disposed) setState({ phase: 'error', msg: `Could not load the model: ${err?.message || err}` })
    })

    return () => {
      disposed = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose()
      scene.traverse((o: any) => {
        o.geometry?.dispose?.()
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        for (const m of mats) { for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose() } m.dispose() }
      })
      scene.environment?.dispose(); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove()
      meshCtx.current = null
    }
  }, [url, type])

  // mesh view options (no reload)
  useEffect(() => {
    const c = meshCtx.current
    if (!c) return
    c.controls.autoRotate = opts.autoRotate
    c.scene.background = new THREE.Color(opts.dark ? 0x15171a : 0xe9ebee)
    c.grid.visible = opts.grid
    c.root?.traverse((o: any) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) m.wireframe = opts.wireframe
    })
  }, [opts, state.phase])
  useEffect(() => { meshCtx.current?.fit() }, [resetKey])

  // ---- splat viewer ---------------------------------------------------------------------------
  useEffect(() => {
    if (type !== 'splat' || !host.current) return
    const el = host.current
    let disposed = false
    let viewer: any = null
    setState({ phase: 'loading', pct: 0 })
    ;(async () => {
      try {
        const GS: any = await import('@mkkellogg/gaussian-splats-3d')
        if (disposed) return
        viewer = new GS.Viewer({
          rootElement: el, selfDrivenMode: true, sharedMemoryForWorkers: false, useBuiltInControls: true,
          cameraUp: [0, -1, 0], initialCameraPosition: [0, -0.4, 2.2], initialCameraLookAt: [0, 0, 0],
          gpuAcceleratedSort: false, dynamicScene: false, logLevel: GS.LogLevel?.None ?? 0,
        })
        await viewer.addSplatScene(url, {
          format: GS.SceneFormat.Ply, showLoadingUI: false, progressiveLoad: false,
          onProgress: (p: number) => { if (!disposed) setState({ phase: 'loading', pct: Math.round(p) }) },
        })
        if (disposed) return
        viewer.start()
        setState({ phase: 'ready', info: 'Gaussian splat (Idol) · drag to orbit, scroll to zoom · not a mesh' })
      } catch (e: any) {
        if (!disposed) setState({ phase: 'error', msg: `Could not load the splat: ${e?.message || e}` })
      }
    })()
    return () => {
      disposed = true
      try { viewer?.dispose() } catch (e: any) { console.warn('[3d viewer] splat dispose:', e?.message || e) }
      while (el.firstChild) el.removeChild(el.firstChild)
    }
  }, [url, type, resetKey])

  return (
    <div className={styles.canvasWrap} style={{ background: opts.dark ? '#15171a' : '#e9ebee' }}>
      <div ref={host} className={styles.canvasHost} />
      {state.phase === 'loading' && <div className={styles.overlay}>Loading model… {state.pct ? `${state.pct}%` : ''}</div>}
      {state.phase === 'error' && <div className={`${styles.overlay} ${styles.errText}`}>{state.msg}</div>}
      {state.phase === 'ready' && state.info && <div className={styles.infoBar}>{state.info}</div>}
    </div>
  )
}
