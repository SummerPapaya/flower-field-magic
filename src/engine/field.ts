import * as THREE from 'three'
import { Meadow, type Arrangement, type BrushSettings } from './meadow'
import { BRUSH, DENSITY, PRESETS, type BrushKind, type DensityName, type PresetName } from './presets'
import { smoothstep } from './geometry'
import type { SpeciesId } from './species'

/** 花的默认大小（双指调节的 sizeK 在这个基础上再乘） */
const BASE_SIZE = 0.75
// 地面上默认再小一点：真机上多是坐着或手机拿得比 1.4 米低，按 1.4 米算出来的花显得偏大
const GROUND_SCALE = 0.8

export type StemMode = 'auto' | 'always' | 'never'
/** 花种：预设的搭配，或者“单种”（只开 single 这一种花） */
export type PaletteName = PresetName | '单种'
/** 种在哪儿：地面（手机离地约 1.4 米）或桌面（手机离桌面只有三四十厘米，花和笔刷都缩小） */
export type SceneKind = '地面' | '桌面'
// 桌面上：AR 引擎把桌面当地面，仍按手机离地 1.4 米算。真机试下来，按地面的原大小（1.0）再稍大一点合适
const DESK_SCALE = 1.1
// 双指调过的大小记在手机上，下次打开还是这个大小
const SIZE_KEY = 'flower-size-k'

export interface FieldSettings {
  preset: PaletteName
  single: SpeciesId
  density: DensityName
  brush: BrushKind
  grass: boolean
  stemMode: StemMode
  arrangement: Arrangement
  scene: SceneKind
}

export const DEFAULT_SETTINGS: FieldSettings = {
  preset: '花田',
  single: 'nemophila',
  density: '中',
  brush: '花片',
  grass: true,
  stemMode: 'auto',
  arrangement: 'mix',
  scene: '地面',
}

// 三角形上限，按实际帧率自动调整。iPhone 12 Pro Max：陀螺仪舞台 53 万时 60 帧；
// AR 舞台要同时跑追踪，34 万时 44 帧，80 万时平均 31、最低 23，所以起步留点余量。
const TRIS_START = 600_000
const TRIS_MIN = 250_000
const TRIS_MAX = 1_400_000
const FPS_LOW = 26 // 连续几秒低于它，就下调上限（让多出来的花枯萎）
const FPS_OK = 40 // 高于它，并且已经接近上限时，才上调（AR 舞台的帧率顶多 45 左右）

// 天空花的距离：贴着地平线放在远处（与那里的地面花一样小），越往上越近。
const AIR_FAR = 40
const AIR_NEAR = 2.5
// 远处的花按真实尺寸会小到看不见：5 米外实际尺寸逐渐放大（最多 3.5 倍），屏幕上仍然越远越小。
// 地面花和天空花用同一条规则，过地平线时大小连续。
const distanceScale = (d: number) => Math.min(3.5, Math.pow(Math.max(d, 5) / 5, 0.6))
// 地面花最远开到这里。贴着地平线的射线和地面的交点在几十上百米外，手机俯仰差一点点交点就差很多，
// 真机上一笔划过去会开出几千朵花（一次到过 900 万三角形），压成一条细带，浮在走廊尽头的墙上。
// 比这更远的地方，花开在这个距离的边缘上，往上划过地平线才变成天空花。
const GROUND_FAR = 20
// 桌面：AR 把桌面当地面，算出来的 6 米相当于现实里一米多，再远就超出桌子了
const DESK_GROUND_FAR = 6
// 草和底色只铺到近处：离得远、又贴着地面看时，它们会压成一条绿带，看着像飘在半空
const GRASS_FADE_FROM = 0.4 // 从最远距离的这个比例开始变稀
const SOIL_MIN_GRASS = 0.5 // 草稀到这个比例以下就不铺底色

function loadSizes(): Record<SceneKind, number> {
  const sizes: Record<SceneKind, number> = { 地面: 1, 桌面: 1 }
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? '{}')
    for (const k of ['地面', '桌面'] as SceneKind[]) {
      const v = Number(saved?.[k])
      if (v >= 0.5 && v <= 2.5) sizes[k] = v
    }
  } catch {
    // 读不到就用默认
  }
  return sizes
}

/**
 * 花田逻辑：把屏幕上的点击、滑动变成空间里的花。地面是 y = 0 的平面。
 * 不关心相机画面从哪里来、谁来渲染：那是“舞台”（stages.ts）的事，切换舞台时花不受影响。
 */
export class FlowerField {
  readonly meadow: Meadow
  settings: FieldSettings
  /** 不能变焦时（AR 模式，或相机不支持），双指捏合调这个；地面、桌面各记各的 */
  private readonly sizeKs: Record<SceneKind, number> = loadSizes()
  get sizeK() {
    return this.sizeKs[this.settings.scene]
  }
  set sizeK(v: number) {
    this.sizeKs[this.settings.scene] = v
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(this.sizeKs))
    } catch {
      // 无痕模式等存不了，就只在这次有效
    }
  }
  fps = 0
  /** 数码变焦倍数：画面放大了多少，手指的位置要按这个换算回去 */
  viewZoom = 1

  private camera: THREE.PerspectiveCamera | null = null
  private strokeId = 0
  private lastGround: { stroke: number; p: THREE.Vector3 } | null = null
  private frames = 0
  private fpsStart = performance.now()
  private lowSeconds = 0
  private okSeconds = 0
  private readonly raycaster = new THREE.Raycaster()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly viewDir = new THREE.Vector3()
  private readonly sizeEl: HTMLElement

  /** sizeEl：接收手势的那个全屏元素，用它的尺寸换算屏幕坐标 */
  constructor(sizeEl: HTMLElement, settings: FieldSettings) {
    this.sizeEl = sizeEl
    this.settings = settings
    // 很淡的空气透视：远处的花稍微变淡、偏蓝白。
    this.meadow = new Meadow('#e4ecf8', { soil: true, maxTris: TRIS_START, fog: { near: 12, far: 70, max: 0.55 } })
    this.meadow.setGrassVisible(settings.grass)
  }

  /** 舞台把场景和相机交给花田；再调用一次就搬到新舞台，已开的花都还在。 */
  attach(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    scene.add(this.meadow.group) // 一个对象只能在一个场景里：会自动从旧舞台移走
    this.camera = camera
  }

  get hasFlowers() {
    return this.meadow.hasFlowers
  }

  setGrass(v: boolean) {
    this.settings = { ...this.settings, grass: v }
    this.meadow.setGrassVisible(v)
  }

  beginStroke() {
    return ++this.strokeId
  }

  undo() {
    this.meadow.undo()
  }

  clear() {
    this.meadow.clear()
    this.lastGround = null
  }

  private rayAt(x: number, y: number) {
    const cam = this.camera!
    const ndc = new THREE.Vector2((x / this.sizeEl.clientWidth) * 2 - 1, -(y / this.sizeEl.clientHeight) * 2 + 1).divideScalar(this.viewZoom)
    cam.updateMatrixWorld()
    // AR 引擎直接改写 projectionMatrix，不会同步它的逆矩阵；射线要用最新的。
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert()
    this.raycaster.setFromCamera(ndc, cam)
    return this.raycaster.ray
  }

  /** 场景的缩放：桌面上花和笔刷都缩小 */
  private get world() {
    return this.settings.scene === '桌面' ? DESK_SCALE : GROUND_SCALE
  }

  /**
   * 按当前设置和离相机的远近，得到这一处的笔刷：远处花放大，密度相应降低，花的朵数不变。
   * k 里已经包含了场景的缩放（桌面上花小、密度按面积提高，一片里的朵数不变）。
   */
  private brush(k: number, grassFade = 1): BrushSettings {
    const { preset, single, density, arrangement, stemMode } = this.settings
    return {
      flowers: DENSITY[density].flowers / (k * k),
      grass: (DENSITY[density].grass * grassFade) / (k * k),
      soil: grassFade >= SOIL_MIN_GRASS,
      arrangement,
      species: preset === '单种' ? [single] : PRESETS[preset],
      size: k * this.sizeK * BASE_SIZE,
      stems: stemMode !== 'never',
    }
  }

  /** 地面花的最远距离 */
  private get groundFar() {
    return this.settings.scene === '桌面' ? DESK_GROUND_FAR : GROUND_FAR
  }

  /** 射线落在地面的哪一点：朝上的射线没有；太远的收到最远距离的边缘上（方向不变）。 */
  private groundHit(ray: THREE.Ray) {
    const hit = ray.intersectPlane(this.groundPlane, new THREE.Vector3())
    if (!hit) return null
    const far = this.groundFar
    if (hit.distanceTo(ray.origin) > far) {
      const dx = hit.x - ray.origin.x
      const dz = hit.z - ray.origin.z
      const flat = Math.hypot(dx, dz)
      const r = Math.sqrt(Math.max(0, far * far - ray.origin.y * ray.origin.y))
      hit.x = ray.origin.x + (dx / flat) * r
      hit.z = ray.origin.z + (dz / flat) * r
    }
    return hit
  }

  /** 这个距离上草还剩多少（0～1） */
  private grassFade(d: number) {
    const far = this.groundFar
    return 1 - smoothstep(far * GRASS_FADE_FROM, far, d)
  }

  private skyStyle() {
    const m = this.settings.stemMode
    return m === 'always' ? 'full' : m === 'never' ? 'head' : 'auto'
  }

  // 高出地平线的射线：离地平线越近放得越远。
  private plantSky(ray: THREE.Ray, delay: number, stroke: number) {
    const elev = Math.asin(Math.min(1, ray.direction.y))
    const t = Math.min(1, elev / 0.6)
    const d = AIR_FAR + (AIR_NEAR - AIR_FAR) * (t * t * (3 - 2 * t))
    const point = ray.at(d, new THREE.Vector3())
    const toCamera = ray.direction.clone().negate()
    const k = distanceScale(d) * this.world
    this.meadow.bloomSky(point, toCamera, (0.95 + Math.random() * 0.45) * 1.15, delay, this.brush(k), this.skyStyle(), stroke)
  }

  /** 滑动时沿路径调用：地面上铺花带，天空里开一串花。 */
  placeAt(x: number, y: number, delay: number, stroke: number) {
    if (!this.camera) return
    const ray = this.rayAt(x, y)
    const hit = this.groundHit(ray)
    if (!hit) {
      this.lastGround = null
      const dir = ray.direction.clone()
      this.plantSky(new THREE.Ray(ray.origin.clone(), dir), delay, stroke)
      // 再撒几朵，花带才有宽度；散到地平线以下的不开。
      for (let i = 0; i < 2; i++) {
        const j = this.rayAt(x + (Math.random() - 0.5) * 56, y + (Math.random() - 0.5) * 56)
        if (j.direction.y > 0) this.plantSky(j, delay + 0.05 + i * 0.05, stroke)
      }
      this.meadow.finishSky(stroke)
      return
    }
    const dist = hit.distanceTo(ray.origin)
    const k = distanceScale(dist) * this.world
    const last = this.lastGround
    if (last && last.stroke === stroke) {
      if (hit.distanceTo(last.p) < 0.12 * k) return
      this.meadow.bloomBand(last.p.x, last.p.z, hit.x, hit.z, BRUSH[this.settings.brush].band * k, this.brush(k, this.grassFade(dist)), stroke)
      last.p = hit
    } else {
      this.lastGround = { stroke, p: hit }
    }
  }

  /** 点一下：花片从中心扩散开一大片，小簇开一小丛。 */
  tap(x: number, y: number, stroke: number) {
    if (!this.camera) return
    const ray = this.rayAt(x, y)
    const hit = this.groundHit(ray)
    const b = BRUSH[this.settings.brush]
    if (hit) {
      const dist = hit.distanceTo(ray.origin)
      const k = distanceScale(dist) * this.world
      this.meadow.bloomPatch(hit.x, hit.z, b.radius * k, this.brush(k, this.grassFade(dist)), 1.5 * k, stroke)
      return
    }
    // 天空里：花按黄金角向外散开，同样从中心往外依次开。
    const spread = Math.min(this.sizeEl.clientWidth, this.sizeEl.clientHeight) * b.skySpread
    const n = Math.round((b.skyCount * DENSITY[this.settings.density].flowers) / DENSITY['中'].flowers)
    for (let i = 0; i < n; i++) {
      const f = Math.sqrt((i + 0.3) / n)
      const a = i * 2.39996
      const j = this.rayAt(x + Math.cos(a) * f * spread + (Math.random() - 0.5) * 10, y + Math.sin(a) * f * spread * 0.8 + (Math.random() - 0.5) * 10)
      if (j.direction.y <= 0) continue // 散到地平线以下的不开，不会有花飘在地面上
      this.plantSky(j, f * 0.9 + Math.random() * 0.12, stroke)
    }
    this.meadow.finishSky(stroke)
  }

  /** 舞台每帧调用（渲染之前）。 */
  tick() {
    const now = performance.now()
    this.meadow.tick(now / 1000)
    const cam = this.camera
    if (cam) {
      cam.getWorldDirection(this.viewDir)
      this.meadow.setView(cam.position, this.viewDir)
    }
    this.frames++
    if (now - this.fpsStart >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsStart))
      this.frames = 0
      this.fpsStart = now
      this.adapt()
    }
  }

  // 按真实帧率调上限：掉帧就少留一些花，流畅且接近上限就多留一些。不同手机都能自己找到合适的量。
  private adapt() {
    const m = this.meadow
    const tris = m.stats.tris
    this.lowSeconds = this.fps < FPS_LOW ? this.lowSeconds + 1 : 0
    this.okSeconds = this.fps >= FPS_OK ? this.okSeconds + 1 : 0
    if (this.lowSeconds >= 3 && tris > TRIS_MIN) {
      // 只往下调：一笔开太多花时 tris 可能远超上限，不能把上限抬上去
      m.maxTris = Math.max(TRIS_MIN, Math.min(m.maxTris, Math.round(tris * 0.8)))
      m.trim()
      this.lowSeconds = 0
    } else if (this.okSeconds >= 4 && tris > m.maxTris * 0.85 && m.maxTris < TRIS_MAX) {
      m.maxTris = Math.min(TRIS_MAX, Math.round(m.maxTris * 1.15))
      this.okSeconds = 0
    }
  }
}
