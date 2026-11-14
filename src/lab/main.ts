// 花田密度实验（只在开发时用）：看效果，也在真机上测“多少花、多少草还能流畅”。
// 模式：sim = 纯 3D 草地（对照参考图）；camera = 相机 + 陀螺仪；ar = 相机 + 8th Wall 世界追踪。
import * as THREE from 'three'
import { Meadow, type Arrangement, type BrushSettings } from '../engine/meadow'
import { BRUSH, DENSITY, PRESETS, type BrushKind, type DensityName, type PresetName } from '../engine/presets'
import type { SpeciesId } from '../engine/species'
import { GyroTracker } from '../engine/tracking'
import { loadXrEngine } from '../engine/xrEngine'
import { cameraErrorText, requestMotionPermission } from '../lib/permissions'
import { STRINGS } from '../lib/i18n'

type Mode = 'sim' | 'camera' | 'ar'
const query = new URLSearchParams(location.search)
const mode = (query.get('mode') ?? 'sim') as Mode

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('c')
const video = $<HTMLVideoElement>('video')
const statsEl = $('stats')
const bar = $('bar')

const FOG = '#dfe8d8'
const CAMERA_HEIGHT = 1.4
const LONG_SIDE_FOV = (67 * Math.PI) / 180

const VIEWS: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  远: { pos: [0, 1.55, 4.3], look: [0, 0.1, -0.7], fov: 50 },
  近: { pos: [0.3, 0.62, 1.9], look: [0, 0.22, 0], fov: 45 },
  标本: { pos: [0.1, 0.36, 0.72], look: [0.03, 0.3, 0], fov: 38 },
  特写: { pos: [0.0, 0.66, 0.32], look: [0.0, 0.28, 0.0], fov: 34 },
  俯: { pos: [0, 4.2, 3.6], look: [0, 0, 0.1], fov: 45 },
}

const state = {
  preset: (query.get('pre') ?? '花田') as PresetName,
  arrangement: (query.get('arr') ?? 'mix') as Arrangement,
  density: (query.get('den') ?? '中') as DensityName,
  grass: query.get('grass') !== '0',
  view: query.get('view') ?? (query.has('specimen') ? '标本' : '远'),
  brush: (query.get('brush') ?? '花片') as BrushKind,
}

const brush = (): BrushSettings => ({
  flowers: DENSITY[state.density].flowers,
  grass: DENSITY[state.density].grass, // 草总是种下，开关只控制显示，切换立刻生效
  arrangement: state.arrangement,
  species: PRESETS[state.preset],
  size: 1,
})

const meadow = new Meadow(FOG, { soil: mode !== 'sim', grassCap: 90000 })

let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let renderer: THREE.WebGLRenderer

/* ---------- 帧率统计 ---------- */

let frames = 0
let windowStart = performance.now()
let fps = 0
let recent: number[] = []
let samples: number[] = [] // 当前这组设置下每秒的帧率，发回电脑用

function countFrame() {
  frames++
  const now = performance.now()
  if (now - windowStart < 1000) return
  fps = Math.round((frames * 1000) / (now - windowStart))
  recent = [...recent.slice(-9), fps]
  if (samples.length < 600) samples.push(fps)
  frames = 0
  windowStart = now
  const s = meadow.stats
  const info = renderer.info.render
  statsEl.textContent =
    `${fps} fps（10 秒最低 ${Math.min(...recent)}）· 花 ${s.flowers} · 草 ${s.blades} · ` +
    `三角形 ${Math.round(info.triangles / 1000)}k · 绘制 ${info.calls} 次 · ${Math.round(innerWidth * Math.min(devicePixelRatio, 2))}px 宽`
}

/* ---------- 种花：点一下从中心扩散开一片，滑动铺一条花带 ---------- */

const raycaster = new THREE.Raycaster()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

function groundAt(clientX: number, clientY: number) {
  const r = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
  camera.updateMatrixWorld()
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  raycaster.setFromCamera(ndc, camera)
  const hit = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3())
  return hit && hit.distanceTo(raycaster.ray.origin) < 14 ? hit : null
}

function attachInput() {
  const pointers = new Set<number>()
  let drag: { id: number; sx: number; sy: number; last: THREE.Vector3 | null; moved: boolean } | null = null
  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId)
    if (pointers.size > 1) {
      drag = null
      return
    }
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, last: groundAt(e.clientX, e.clientY), moved: false }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 10) drag.moved = true
    if (!drag.moved) return
    const p = groundAt(e.clientX, e.clientY)
    if (!p) return
    if (drag.last && p.distanceTo(drag.last) > 0.12) {
      meadow.bloomBand(drag.last.x, drag.last.z, p.x, p.z, BRUSH[state.brush].band, brush())
      drag.last = p
    } else if (!drag.last) {
      drag.last = p
    }
  })
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (drag && drag.id === e.pointerId && !drag.moved) {
      const p = groundAt(e.clientX, e.clientY)
      if (p) meadow.bloomPatch(p.x, p.z, BRUSH[state.brush].radius, brush())
    }
    if (drag && drag.id === e.pointerId) drag = null
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault())
}

/* ---------- 模式 ---------- */

function makeRenderer(alpha: boolean) {
  const r = new THREE.WebGLRenderer({ canvas, alpha, antialias: true })
  r.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
  // 花和草的颜色都直接写 sRGB 值，全程不转换。
  r.outputColorSpace = THREE.LinearSRGBColorSpace
  return r
}

function bloomMain() {
  meadow.clear(true)
  const solo = query.get('specimen') as SpeciesId | null
  if (solo) {
    // 检查造型：只种三株不同形状的同一种花。
    if (query.has('six')) {
      // 六种颜色排成两排
      for (let i = 0; i < 6; i++) meadow.specimen(solo, -0.2 + (i % 3) * 0.2, (i < 3 ? 0.08 : -0.14), i * 1.7, i)
    } else {
      meadow.specimen(solo, 0, 0, 0.4, 0)
      meadow.specimen(solo, -0.32, -0.2, 2.2, 1)
      meadow.specimen(solo, 0.34, -0.25, 4.1, 2)
    }
    return
  }
  meadow.bloomPatch(0, 0, 3.4, brush(), 1.4)
}

function startSim() {
  renderer = makeRenderer(false)
  scene = new THREE.Scene()
  scene.background = new THREE.Color().setStyle(FOG, THREE.LinearSRGBColorSpace)
  camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(150, 48).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { uFog: { value: scene.background } },
      vertexShader: `varying float vD; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.); vD = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uFog; varying float vD; void main() { gl_FragColor = vec4(mix(vec3(0.3, 0.5, 0.22), uFog, smoothstep(6., 34., vD)), 1.); }`,
    }),
  )
  scene.add(ground, meadow.group)
  const applyView = () => {
    const v = VIEWS[state.view]
    camera.position.set(...v.pos)
    camera.fov = v.fov
    camera.lookAt(...v.look)
    resizeSim()
  }
  const resizeSim = () => {
    renderer.setSize(innerWidth, innerHeight, false)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  }
  addEventListener('resize', resizeSim)
  viewHook = applyView
  applyView()
  attachInput()
  bloomMain()
  renderer.setAnimationLoop(() => {
    meadow.tick(performance.now() / 1000)
    renderer.render(scene, camera)
    countFrame()
  })
}

async function startCamera() {
  video.hidden = false
  await requestMotionPermission()
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false,
  })
  video.srcObject = stream
  await video.play().catch(() => {})
  renderer = makeRenderer(true)
  renderer.setClearColor(0x000000, 0)
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 300)
  camera.position.set(0, CAMERA_HEIGHT, 0)
  scene.add(meadow.group)
  const tracker = new GyroTracker()
  const resize = () => {
    const W = innerWidth
    const H = innerHeight
    renderer.setSize(W, H, false)
    camera.aspect = W / H
    const vw = video.videoWidth || 3
    const vh = video.videoHeight || 4
    const focal = (Math.max(vw, vh) / 2 / Math.tan(LONG_SIDE_FOV / 2)) * Math.max(W / vw, H / vh)
    camera.fov = (2 * Math.atan(H / 2 / focal) * 180) / Math.PI
    camera.updateProjectionMatrix()
  }
  resize()
  addEventListener('resize', resize)
  video.addEventListener('resize', resize)
  attachInput()
  renderer.setAnimationLoop(() => {
    tracker.update(camera)
    meadow.tick(performance.now() / 1000)
    renderer.render(scene, camera)
    countFrame()
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function startAr(XR8: any) {
  await requestMotionPermission()
  canvas.width = Math.round(innerWidth * Math.min(devicePixelRatio, 2))
  canvas.height = Math.round(innerHeight * Math.min(devicePixelRatio, 2))
  addEventListener('resize', () => {
    canvas.width = Math.round(innerWidth * Math.min(devicePixelRatio, 2))
    canvas.height = Math.round(innerHeight * Math.min(devicePixelRatio, 2))
  })
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    {
      name: 'meadowlab',
      onStart: () => {
        const xr = XR8.Threejs.xrScene()
        scene = xr.scene
        camera = xr.camera
        renderer = xr.renderer
        scene.add(meadow.group)
        camera.position.set(0, CAMERA_HEIGHT, 0)
        XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion })
        attachInput()
      },
      onUpdate: () => {
        meadow.tick(performance.now() / 1000)
        if (renderer) countFrame()
      },
      onException: (e: unknown) => {
        statsEl.textContent = `引擎出错：${e instanceof Error ? e.message : JSON.stringify(e)}`
      },
    },
  ])
  XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---------- 界面 ---------- */

let viewHook: (() => void) | null = null

function row(label: string, options: string[], current: () => string, choose: (v: string) => void, quick = false) {
  const el = document.createElement('div')
  el.className = 'row'
  if (quick) el.dataset.quick = '1'
  const paint = () => {
    for (const b of el.querySelectorAll('button')) b.classList.toggle('on', b.textContent === current())
  }
  const span = document.createElement('span')
  span.textContent = label
  el.append(span)
  for (const o of options) {
    const b = document.createElement('button')
    b.textContent = o
    b.addEventListener('click', () => {
      choose(o)
      paint()
    })
    el.append(b)
  }
  paint()
  bar.append(el)
}

const rebloomIfSim = () => {
  samples = []
  if (mode === 'sim') bloomMain()
}

function buildUi() {
  const MODE_NAME: Record<Mode, string> = { sim: '模拟', camera: '相机', ar: 'AR' }
  row('模式', Object.values(MODE_NAME), () => MODE_NAME[mode], (v) => {
    const m = (Object.keys(MODE_NAME) as Mode[]).find((k) => MODE_NAME[k] === v)!
    if (m !== mode) location.search = `?mode=${m}`
  })
  row('花种', Object.keys(PRESETS), () => state.preset, (v) => {
    state.preset = v as PresetName
    rebloomIfSim()
  }, true)
  row('排列', ['混杂', '成片'], () => (state.arrangement === 'mix' ? '混杂' : '成片'), (v) => {
    state.arrangement = v === '混杂' ? 'mix' : 'drift'
    rebloomIfSim()
  })
  row('密度', Object.keys(DENSITY), () => state.density, (v) => {
    state.density = v as DensityName
    rebloomIfSim()
  }, true)
  if (mode === 'sim') {
    row('视角', Object.keys(VIEWS), () => state.view, (v) => {
      state.view = v
      viewHook?.()
    })
  }
  row('笔刷', ['花片', '小簇'], () => state.brush, (v) => {
    state.brush = v as BrushKind
  }, true)
  row('草', ['有', '无'], () => (state.grass ? '有' : '无'), (v) => {
    state.grass = v === '有'
    samples = []
    meadow.setGrassVisible(state.grass)
  }, true)
  const actions = document.createElement('div')
  actions.className = 'row'
  actions.dataset.quick = '1'
  const add = (text: string, fn: () => void) => {
    const b = document.createElement('button')
    b.textContent = text
    b.addEventListener('click', fn)
    actions.append(b)
  }
  if (mode === 'sim') add('重新开花', bloomMain)
  add('清空', () => {
    samples = []
    meadow.clear(true)
  })
  const sendBtn = document.createElement('button')
  sendBtn.textContent = '发送结果'
  sendBtn.addEventListener('click', () => sendReport(sendBtn))
  actions.append(sendBtn)
  add('更多', function toggle(this: void) {
    const open = bar.dataset.open !== '1'
    bar.dataset.open = open ? '1' : ''
    for (const el of bar.querySelectorAll<HTMLElement>('.row')) if (!el.dataset.quick) el.hidden = !open
    const btn = [...actions.querySelectorAll('button')].at(-1)!
    btn.textContent = open ? '收起' : '更多'
  })
  bar.append(actions)
  for (const el of bar.querySelectorAll<HTMLElement>('.row')) if (!el.dataset.quick) el.hidden = true
  if (mode === 'ar') {
    const legal = document.createElement('div')
    legal.className = 'legal'
    legal.innerHTML = `AR 追踪由 8th Wall Engine 提供，© 2026 Niantic Spatial, Inc.，按<a href="${__XR_BASE__}LICENSE" target="_blank">许可协议</a>使用，不提供任何担保。`
    bar.append(legal)
  }
}

async function sendReport(btn: HTMLButtonElement) {
  const sorted = samples.slice(3).sort((a, b) => a - b) // 去掉刚切换时的几秒
  const report = {
    kind: 'meadow-lab',
    time: new Date().toISOString(),
    ua: navigator.userAgent,
    screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    mode,
    preset: state.preset,
    arrangement: state.arrangement,
    density: state.density,
    grass: state.grass,
    brush: state.brush,
    stats: meadow.stats,
    drawn: { triangles: renderer?.info.render.triangles, calls: renderer?.info.render.calls },
    fps: {
      seconds: samples.length,
      avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
      min: sorted[0] ?? null,
      median: sorted[Math.floor(sorted.length / 2)] ?? null,
      samples,
    },
  }
  btn.textContent = '发送中…'
  try {
    const res = await fetch('/api/lab-report', { method: 'POST', body: JSON.stringify(report) })
    btn.textContent = res.ok ? `✅ 已发送（${samples.length} 秒）` : `❌ ${res.status}`
  } catch (e) {
    btn.textContent = `❌ ${String(e)}`
  }
  setTimeout(() => (btn.textContent = '发送结果'), 2500)
  samples = [] // 下一组从头算
}

/** 电脑上通过隧道打开时，显示手机要扫的二维码（AR 模式）。 */
function showQr() {
  if (/iPhone|iPad|Android/.test(navigator.userAgent) || !location.hostname.endsWith('.trycloudflare.com')) return
  const url = `${location.origin}/meadow-lab.html?mode=ar`
  const s = document.createElement('script')
  s.src = '/probe/public/vendor/qrcode.js'
  s.onload = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qr = (window as any).qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const box = document.createElement('div')
    box.id = 'qr'
    box.innerHTML = `<b>手机扫码打开（AR 模式）</b>${qr.createSvgTag(4, 2)}<small>iPhone 相机扫码，会用 Safari 打开</small>`
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  }
  document.head.append(s)
}

function askToStart(run: () => Promise<void>, prepare?: () => Promise<void>) {
  const panel = $('start')
  const btn = $<HTMLButtonElement>('btn-start')
  panel.hidden = false
  if (prepare) {
    btn.disabled = true
    btn.textContent = '引擎加载中…'
    prepare().then(
      () => {
        btn.disabled = false
        btn.textContent = '开始'
      },
      (e) => {
        $('start-err').textContent = String(e)
      },
    )
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      await run()
      panel.hidden = true
    } catch (e) {
      $('start-err').textContent = cameraErrorText(e, STRINGS.zh.errors)
      btn.disabled = false
    }
  })
}

buildUi()
showQr()
meadow.setGrassVisible(state.grass)
if (mode === 'sim') {
  startSim()
} else if (mode === 'camera') {
  askToStart(startCamera)
} else {
  let xr: unknown
  askToStart(
    () => startAr(xr),
    async () => {
      xr = await loadXrEngine()
    },
  )
}
