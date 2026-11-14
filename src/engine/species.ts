// 花田用的低面数花（一株约 200 个三角形，铃兰约 1000 个）。形状全部是真实几何，不用透明贴图：
// 手机 GPU 上 alpha test 很贵，而且几何轮廓放大了也不糊。颜色写在顶点上，是直接的 sRGB 值。
// 顶点的 aPart 标明部位：0 = 叶，1 = 花（开花时收拢、展开的部分），2 = 茎。天空花按部位取用。
import * as THREE from 'three'

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

type RGB = [number, number, number]
type Stop = [number, string]

// 着色器里全程用 sRGB 原值，所以这里不做色彩空间转换。
const rawColor = (hex: string) => new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace)

const rgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function gradient(stops: Stop[], t: number): RGB {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (t - t0) / (t1 - t0 || 1)
      const a = rgb(c0)
      const b = rgb(c1)
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
    }
  }
  return rgb(stops[stops.length - 1][1])
}

interface V {
  x: number
  y: number
  z: number
  c: RGB
}

class MeshBuilder {
  private readonly pos: number[] = []
  private readonly col: number[] = []
  private readonly part: number[] = []
  private readonly idx: number[] = []
  private readonly v = new THREE.Vector3()
  matrix = new THREE.Matrix4()

  /** 一块 nu × nv 的网格。法线朝向由 (u, v) 的走向决定：u 向右、v 向前时朝上。 */
  grid(nu: number, nv: number, fn: (iu: number, iv: number) => V, part = 0) {
    const base = this.pos.length / 3
    for (let iv = 0; iv <= nv; iv++) {
      for (let iu = 0; iu <= nu; iu++) {
        const q = fn(iu, iv)
        this.v.set(q.x, q.y, q.z).applyMatrix4(this.matrix)
        this.pos.push(this.v.x, this.v.y, this.v.z)
        this.col.push(q.c[0], q.c[1], q.c[2])
        this.part.push(part)
      }
    }
    for (let iv = 0; iv < nv; iv++) {
      for (let iu = 0; iu < nu; iu++) {
        const a = base + iv * (nu + 1) + iu
        const b = a + 1
        const c = a + nu + 1
        const d = c + 1
        this.idx.push(a, c, b, b, c, d)
      }
    }
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setIndex(this.idx)
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1))
    g.computeVertexNormals()
    return g
  }
}

interface PetalSpec {
  n: number
  len: number
  /** 最宽处的半宽（相对花瓣长度） */
  width: number
  /** 长到最宽的位置（0…1），越大越像上宽下窄的倒卵形 */
  a: number
  /** 变宽的快慢：越小根部越快变宽 */
  b: number
  /** 端部收圆的程度（1 = 半圆头） */
  round?: number
  cup: number
  droop?: number
  notch?: number
  rows: number
  cols: number
  stops: Stop[]
  inner?: number
  /** 第几层的高度和转角（重瓣用） */
  lift?: number
  turn?: number
  /** 花瓣尖往花心收的程度（0～1）：重瓣花里层的花瓣是抱在一起的 */
  curl?: number
  /** 瓣缘往外卷的程度：玫瑰的花瓣两边向外翻卷，瓣尖看着是尖的 */
  roll?: number
}

function petals(b: MeshBuilder, s: PetalSpec) {
  const inner = s.inner ?? 0.004
  const round = s.round ?? 1
  for (let i = 0; i < s.n; i++) {
    const theta = (i * TAU) / s.n + (s.turn ?? 0) + (Math.random() - 0.5) * 0.08
    const c = Math.cos(theta)
    const sn = Math.sin(theta)
    const wave = Math.random() * TAU
    // 每片花瓣大小、宽窄略有不同，不像一个模子刻出来的
    const len = s.len * (0.94 + Math.random() * 0.12)
    const r = s.width * len * (0.93 + Math.random() * 0.14) // 花瓣头的半径 = 最宽处的半宽
    const shoulder = len - r * round // 圆头的圆心离根部多远
    const root = r * 0.14
    // 花瓣的轮廓 = 根部 → 两侧 → 圆圆的头。每一列是从根部射向轮廓上一点的“射线”，每一行是缩小的轮廓，
    // 所以花瓣头是真正的圆弧（以前是按宽度收窄，面数少的时候头是尖的、有棱角），颜色也沿着轮廓一圈圈过渡。
    b.grid(s.cols, s.rows, (iu, iv) => {
      const u = (iu / s.cols) * 2 - 1
      const v = iv / s.rows
      const phi = u * (Math.PI / 2)
      const notch = 1 - (s.notch ?? 0) * (0.5 - 0.5 * Math.cos(phi * 4)) // 波斯菊花瓣头上的小缺口
      const ox = Math.sin(phi) * r * notch
      const orho = inner + shoulder + Math.cos(phi) * r * round * notch
      // 横向比纵向张开得快：两侧是鼓出来的弧线（倒卵形），不是直线
      const g = Math.sin((Math.PI / 2) * Math.min(1, Math.pow(v / s.a, s.b)))
      const x = u * root + (ox - u * root) * g
      // 瓣缘外卷：越靠两边、越靠上卷得越多，往外、往下翻
      const rk = (s.roll ?? 0) * u * u * Math.pow(Math.max(0, (v - 0.4) / 0.6), 2)
      const rho = (inner + (orho - inner) * v) * (1 - (s.curl ?? 0) * v * v) + rk * len * 0.4
      // 兜起 / 外垂 + 一点波浪；两边微微翘起，花瓣依次叠压。
      const y =
        (s.lift ?? 0) +
        len * (s.cup * v * v - (s.droop ?? 0) * v * v * v + 0.02 * Math.sin(u * 2 + wave) * v + 0.03 * u * v + 0.05 * u * u * v * v) +
        (i % 2) * 0.0008 -
        rk * len * 0.3
      return { x: x * c + rho * sn, y, z: -x * sn + rho * c, c: gradient(s.stops, v) }
    }, 1)
  }
}

/** 花盘：一个矮圆顶，r 外圈半径，dome 高度。 */
function disc(b: MeshBuilder, r: number, dome: number, y0: number, stops: Stop[], sides = 6, rows = 2) {
  b.grid(sides, rows, (iu, iv) => {
    const a = (iu / sides) * TAU
    const t = iv / rows
    const rr = r * (1 - t) // t = 0 外圈，t = 1 顶点
    return { x: Math.sin(a) * rr, y: y0 + dome * (1 - (1 - t) * (1 - t)), z: Math.cos(a) * rr, c: gradient(stops, 1 - t) }
  }, 1)
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** 沿折线的细管（花茎、花梗）。截面始终垂直于走向，水平、弯曲的部分也有厚度。sides = 3 已经足够。 */
function tube(b: MeshBuilder, pts: THREE.Vector3[], r0: number, r1: number, c0: string, c1: string, part = 2, sides = 3) {
  const rows = pts.length - 1
  const tangent = (i: number) => pts[Math.min(i + 1, rows)].clone().sub(pts[Math.max(i - 1, 0)]).normalize()
  const t0 = tangent(0)
  let side = t0.clone().cross(Math.abs(t0.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize()
  const frames = pts.map((_, i) => {
    const t = tangent(i)
    side = side.clone().addScaledVector(t, -side.dot(t)).normalize() // 沿路径平移，截面不扭转
    return { s: side, n: side.clone().cross(t) }
  })
  b.grid(sides, rows, (iu, iv) => {
    const a = (iu / sides) * TAU
    const t = iv / rows
    const r = r0 + (r1 - r0) * t
    const { s: fs, n } = frames[iv]
    const k1 = Math.cos(a) * r
    const k2 = Math.sin(a) * r
    const p = pts[iv]
    return {
      x: p.x + fs.x * k1 + n.x * k2,
      y: p.y + fs.y * k1 + n.y * k2,
      z: p.z + fs.z * k1 + n.z * k2,
      c: gradient([[0, c0], [1, c1]], t),
    }
  }, part)
}

/** 一片叶子：从 base 朝 dir 伸出，宽度 width，末端下垂 droop。 */
function leaf(b: MeshBuilder, base: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, droop: number, stops: Stop[], rows = 4) {
  const d = dir.clone().normalize()
  const side = d.clone().cross(UP).normalize()
  if (side.lengthSq() < 0.01) side.set(1, 0, 0)
  b.grid(2, rows, (iu, iv) => {
    const u = iu - 1
    const v = iv / rows
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(0.999, v * 0.97 + 0.015)), 0.8)
    const p = base.clone().addScaledVector(d, len * v).addScaledVector(side, u * w)
    p.y += -droop * len * v * v + Math.abs(u) * width * 0.25 // 沿中脉微微折起
    return { x: p.x, y: p.y, z: p.z, c: gradient(stops, v) }
  })
}

export interface SpeciesGeo {
  geo: THREE.BufferGeometry
  /** 花头中心和朝向：顶点着色器用它把花瓣收拢成花苞 */
  center: THREE.Vector3
  axis: THREE.Vector3
  /** 背面的明暗（乘在顶点色上，接近白色；太深背面会发黑） */
  back: THREE.Color
}

const LEAF: Stop[] = [[0, '#4f7d4a'], [0.6, '#6f9e5b'], [1, '#8fbd6e']]

interface PlantShape {
  height: number
  /** 花头偏离垂直方向的角度 */
  tilt: number
  back: string
}

/** 共用的“茎 + 两片叶 + 花头”骨架。head() 在花头的局部坐标系里画（+Y 是花朵朝向）。 */
/** leafAt：叶子长在茎的多高（相对株高，最低 + 随机范围）；leafUp：叶子朝上的程度 */
function plant(shape: PlantShape, head: (b: MeshBuilder) => void, leafLen = 0.075, leafWide = 0.14, leafAt: [number, number] = [0.25, 0.2], leafUp = 0.5): SpeciesGeo {
  const b = new MeshBuilder()
  const H = shape.height
  const az = Math.random() * TAU
  const lean = 0.02 + Math.random() * 0.05
  const top = v3(Math.sin(az) * lean, H, Math.cos(az) * lean)
  tube(b, [v3(0, 0, 0), v3(top.x * 0.3, H * 0.55, top.z * 0.3), top], 0.0032, 0.0022, '#4f7d4a', '#7fae5f')
  const la = Math.random() * TAU
  for (const k of [0, Math.PI]) {
    const base = v3(top.x * 0.2, H * (leafAt[0] + Math.random() * leafAt[1]), top.z * 0.2)
    leaf(b, base, v3(Math.sin(la + k), leafUp, Math.cos(la + k)), leafLen, leafLen * leafWide, 0.25, LEAF, 2)
  }
  const tiltAz = Math.random() * TAU
  const q = new THREE.Quaternion().setFromAxisAngle(v3(Math.cos(tiltAz), 0, Math.sin(tiltAz)), shape.tilt)
  b.matrix = new THREE.Matrix4().compose(top, q, v3(1, 1, 1))
  head(b)
  return { geo: b.build(), center: top, axis: UP.clone().applyQuaternion(q), back: rawColor(shape.back) }
}

const NEMOPHILA: Stop[] = [[0, '#fdfbfd'], [0.34, '#eef3fd'], [0.6, '#bcd4fa'], [0.82, '#8fb2ee'], [1, '#7a9ce6']]

function nemophila() {
  return plant({ height: 0.24 + Math.random() * 0.1, tilt: 0.15 + Math.random() * 0.5, back: '#dfe3f6' }, (b) => {
    const len = 0.055
    petals(b, { n: 5, len, width: 0.46, a: 0.7, b: 0.9, round: 1, cup: 0.4, droop: 0.2, rows: 3, cols: 5, stops: NEMOPHILA })
    // 花心周围的紫色小斑点、淡紫花蕊
    for (let i = 0; i < 5; i++) {
      const a = (i * TAU) / 5
      for (const k of [-0.17, 0.17]) {
        const px = Math.sin(a + k) * len * 0.3
        const pz = Math.cos(a + k) * len * 0.3
        const s = len * 0.05
        b.grid(1, 1, (iu, iv) => ({
          x: px + (iu * 2 - 1) * s * Math.cos(a + k) + (iv * 2 - 1) * s * 0.45 * Math.sin(a + k),
          y: 0.008,
          z: pz - (iu * 2 - 1) * s * Math.sin(a + k) + (iv * 2 - 1) * s * 0.45 * Math.cos(a + k),
          c: rgb('#6450aa'),
        }), 1)
      }
      const ax = Math.sin(a + 0.6)
      const az = Math.cos(a + 0.6)
      const r = len * 0.26
      b.grid(1, 1, (iu, iv) => ({
        x: ax * r * iv + (iu - 0.5) * 0.003 * az,
        y: 0.004 + iv * 0.016,
        z: az * r * iv - (iu - 0.5) * 0.003 * ax,
        c: iv ? rgb('#b09ad8') : rgb('#e5dbc3'),
      }), 1)
    }
  })
}

function daisy() {
  return plant({ height: 0.3 + Math.random() * 0.14, tilt: 0.1 + Math.random() * 0.45, back: '#e6e8dc' }, (b) => {
    petals(b, {
      n: 17, len: 0.058, width: 0.13, a: 0.3, b: 0.7, round: 1, cup: 0.12, droop: 0.2, rows: 2, cols: 3, inner: 0.012,
      stops: [[0, '#f6efcf'], [0.3, '#fffdf6'], [1, '#ffffff']],
    })
    disc(b, 0.019, 0.008, 0.002, [[0, '#f8cf3a'], [0.7, '#f3b823'], [1, '#d99a18']])
  })
}

function cosmos() {
  return plant({ height: 0.36 + Math.random() * 0.16, tilt: 0.15 + Math.random() * 0.5, back: '#efd9e2' }, (b) => {
    petals(b, {
      n: 8, len: 0.06, width: 0.38, a: 0.66, b: 0.85, round: 0.45, cup: 0.2, droop: 0.12, notch: 0.04, rows: 3, cols: 4, inner: 0.006,
      stops: [[0, '#d65a8d'], [0.3, '#ee8cb0'], [0.75, '#f8bcd1'], [1, '#fbd5e2']],
    })
    disc(b, 0.012, 0.006, 0.003, [[0, '#f7cf45'], [1, '#e0a526']], 6, 1)
  })
}

function goldenrod() {
  // 黄色的花：照开场页的向日葵——一圈平展的圆头黄花瓣，中间一个深褐色的大花盘
  return plant({ height: 0.28 + Math.random() * 0.12, tilt: 0.1 + Math.random() * 0.45, back: '#f2e2bc' }, (b) => {
    const stops: Stop[] = [[0, '#e9a21c'], [0.45, '#f8c22e'], [1, '#ffd84e']]
    petals(b, { n: 13, len: 0.046, width: 0.21, a: 0.4, b: 0.8, round: 1, cup: 0.12, droop: 0.16, rows: 2, cols: 3, inner: 0.014, stops })
    petals(b, { n: 9, len: 0.036, width: 0.24, a: 0.4, b: 0.8, round: 1, cup: 0.3, rows: 2, cols: 3, inner: 0.012, stops, lift: 0.003, turn: 0.35 })
    disc(b, 0.017, 0.008, 0.004, [[0, '#7a4a16'], [0.6, '#5e3410'], [1, '#4a280c']], 8, 2)
  })
}

function hydrangea() {
  const b = new MeshBuilder()
  const H = 0.27 + Math.random() * 0.1
  const top = v3((Math.random() - 0.5) * 0.04, H, (Math.random() - 0.5) * 0.04)
  tube(b, [v3(0, 0, 0), v3(top.x * 0.4, H * 0.6, top.z * 0.4), top], 0.005, 0.004, '#4f7d4a', '#6f9e5b')
  const la = Math.random() * TAU
  for (const k of [0, 2.2, 4.3]) {
    leaf(b, v3(top.x * 0.5, H * (0.5 + Math.random() * 0.2), top.z * 0.5), v3(Math.sin(la + k), 0.25, Math.cos(la + k)),
      0.11, 0.034, 0.35, [[0, '#5a8c50'], [1, '#86b56a']], 4)
  }
  // 花球：小四瓣花按斐波那契分布在球面上，每朵颜色略有不同。
  const R = 0.078
  const center = top.clone().add(v3(0, R * 0.55, 0))
  b.matrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z)
  // 底下的球铺到接近底部，颜色和小花接近：小花之间露出来的地方不显得是个洞（以前底部敞开、颜色深，看着像镂空）
  b.grid(8, 4, (iu, iv) => {
    const a = (iu / 8) * TAU
    const t = (iv / 4) * 0.9 * Math.PI
    const r = R * 0.95
    return { x: Math.sin(t) * Math.sin(a) * r, y: Math.cos(t) * r, z: Math.sin(t) * Math.cos(a) * r, c: gradient([[0, '#b7b0ee'], [0.6, '#a49de6'], [1, '#8c86d2']], iv / 4) }
  }, 1)
  // 小花铺得密一些、大小不一、花瓣微微翘起，互相叠压，看不到底下的球（开场页的绣球就是一团挤在一起的小花）
  const n = 30
  const tints = ['#a99cec', '#b8acf0', '#9da6ea', '#c3b9f3', '#94a0e8']
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 1.7 // 铺到球的下半部分
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = i * 2.39996
    const nrm = v3(Math.cos(a) * r, y, Math.sin(a) * r)
    const q = new THREE.Quaternion().setFromUnitVectors(UP, nrm)
    // 小花一层压一层（离球心的距离错开），花瓣顺着球面往下弯：相邻的小花叠在一起，不会互相穿过去
    b.matrix = new THREE.Matrix4().compose(center.clone().addScaledVector(nrm, R * (1.01 + (i % 3) * 0.06)), q, v3(1, 1, 1))
    const tint = tints[i % tints.length]
    // 每朵小花四片圆圆的花瓣（开场页的绣球也是这样），不是直边的十字
    const size = 0.029 + Math.random() * 0.01
    petals(b, { n: 4, len: size, width: 0.54, a: 0.55, b: 1, round: 1, cup: -size / (2 * R), rows: 1, cols: 3, inner: 0.001, turn: i, stops: [[0, '#e2dcf8'], [0.4, '#cfc8f4'], [1, tint]] })
  }
  return { geo: b.build(), center, axis: UP.clone(), back: rawColor('#e6e3f6') }
}

/**
 * 一朵铃铛：顶部接花梗，圆肩、微微收腰，下摆外翻成 6 个尖瓣。
 * 局部坐标：顶点在原点，向 -Y 垂下。正面朝外，里面（背面）由 uBack 染成淡紫白。
 */
function bell(b: MeshBuilder, at: THREE.Vector3, tilt: THREE.Quaternion, size: number) {
  const R = 0.024 * size
  const h = 0.044 * size
  const stops: Stop[] = [[0, '#dfe9d2'], [0.25, '#edf1f3'], [0.6, '#f9f6f5'], [0.8, '#fdf8f7'], [1, '#ffffff']]
  b.matrix = new THREE.Matrix4().compose(at, tilt, v3(1, 1, 1))
  const SIDES = 12
  b.grid(SIDES, 5, (iu, iv) => {
    const a = (iu / SIDES) * TAU
    const tip = iu % 2 === 1 // 奇数点是瓣尖，偶数点是瓣与瓣之间的缺口
    const ring: [number, number][] = [
      [0.12, 0], // 接花梗
      [0.6, -0.045], // 圆顶
      [0.92, -0.19],
      [1, -0.45], // 最饱满处
      [tip ? 1.0 : 0.95, -0.74], // 微微收腰
      tip ? [1.36, -1.0] : [1.1, -0.87], // 外翻的下摆：瓣宽而短，不是细尖
    ]
    const [r, y] = ring[iv]
    return { x: Math.sin(a) * r * R, y: y * h, z: Math.cos(a) * r * R, c: gradient(stops, iv / 5) }
  }, 1)
  b.matrix = new THREE.Matrix4()
}

/** 宽大的披针形叶：根部收窄裹住花茎，中脉折起，一半亮一半暗，叶尖尖。 */
function broadLeaf(b: MeshBuilder, az: number, lean: number, len: number, width: number) {
  const out = v3(Math.sin(az), 0, Math.cos(az))
  const side = v3(Math.cos(az), 0, -Math.sin(az))
  const ROWS = 6
  b.grid(2, ROWS, (iu, iv) => {
    const u = iu - 1
    const v = iv / ROWS
    const w = width * (0.14 * (1 - v) + 0.86 * Math.pow(Math.sin(Math.PI * Math.pow(Math.min(v, 0.999), 0.72)), 0.85))
    const y = len * v * (1 - 0.1 * v)
    const o = lean * len * v + 0.16 * len * v * v // 向外倾，越往上弯得越多
    const fold = -Math.abs(u) * w * 0.32 // 沿中脉向内折
    const c = gradient([[0, '#7da35a'], [0.35, '#6f9a4f'], [0.8, '#86ad5e'], [1, '#9dbd6c']], v)
    const k = u < 0 ? 0.86 : 1 // 折痕两边一明一暗
    return {
      x: out.x * (o + fold) + side.x * u * w,
      y,
      z: out.z * (o + fold) + side.z * u * w,
      c: [c[0] * k, c[1] * k, c[2] * k] as RGB,
    }
  })
}

function lilyOfTheValley(): SpeciesGeo {
  const b = new MeshBuilder()
  const H = 0.46 + Math.random() * 0.08
  const az = Math.random() * TAU
  const dir = v3(Math.sin(az), 0, Math.cos(az))
  // 弧形主茎：先直直向上，到顶部弯向一侧、微微下垂。
  const arc = (t: number) => dir.clone().multiplyScalar(0.02 * t + 0.2 * Math.pow(t, 2.2)).add(v3(0, (H * Math.sin(t * 1.75)) / Math.sin(1.57), 0))
  tube(b, Array.from({ length: 8 }, (_, i) => arc(i / 7)), 0.0052, 0.0019, '#6f9a4f', '#9dbb6e')

  // 宽叶长在弯曲方向的背后，把花串衬出来。
  const back = az + Math.PI
  broadLeaf(b, back + 0.55 + Math.random() * 0.25, 0.12 + Math.random() * 0.08, 0.44 + Math.random() * 0.06, 0.078)
  broadLeaf(b, back - 0.55 - Math.random() * 0.25, 0.16 + Math.random() * 0.1, 0.38 + Math.random() * 0.06, 0.068)

  // 花串：下面的铃铛大，往上渐小，左右交错地挂在弯曲的一侧。
  const n = 5 + Math.floor(Math.random() * 2)
  for (let i = 0; i < n; i++) {
    const t = 0.32 + (i / (n - 1)) * 0.54
    const node = arc(t)
    const size = 1 - (i / (n - 1)) * 0.4
    const turn = (i % 2 ? 0.75 : -0.75) + (Math.random() - 0.5) * 0.3
    const out = dir.clone().applyAxisAngle(UP, turn)
    const reach = 0.026 + 0.008 * size
    const top = node.clone().addScaledVector(out, reach).add(v3(0, -0.01, 0))
    const pts = [node, node.clone().addScaledVector(out, reach * 0.5).add(v3(0, 0.011, 0)), node.clone().addScaledVector(out, reach * 0.92).add(v3(0, 0.006, 0)), top]
    b.matrix = new THREE.Matrix4()
    tube(b, pts, 0.0023, 0.0019, '#86a85c', '#a4bd72', 1)
    // 花梗根部的小苞片
    const bractDir = out.clone().multiplyScalar(0.7).add(v3(0, 1, 0)).normalize()
    const bractSide = bractDir.clone().cross(out).normalize()
    b.grid(1, 1, (iu, iv) => {
      const p = node.clone().addScaledVector(bractDir, iv * 0.022).addScaledVector(bractSide, (iu - 0.5) * 0.007 * (1 - iv))
      return { x: p.x, y: p.y, z: p.z, c: rgb(iv ? '#b6c98a' : '#8fae62') }
    }, 1)
    // 铃铛朝外微微歪一点，不是完全笔直地垂着。
    const lean = new THREE.Quaternion().setFromAxisAngle(out.clone().cross(UP).normalize(), -0.14 + Math.random() * 0.1)
    bell(b, top, lean, size)
  }
  // 顶端两个还没开的小花苞（黄绿色的小圆球）
  for (const [t, r, turn] of [[0.95, 0.0105, 0.8], [1, 0.009, -0.5]] as [number, number, number][]) {
    const node = arc(t)
    const out = dir.clone().applyAxisAngle(UP, turn)
    const c = node.clone().addScaledVector(out, 0.02).add(v3(0, -0.008, 0))
    tube(b, [node, node.clone().addScaledVector(out, 0.012).add(v3(0, 0.004, 0)), c], 0.0013, 0.0012, '#8fae62', '#a4bd72', 1)
    b.matrix = new THREE.Matrix4().makeTranslation(c.x, c.y - r * 0.8, c.z)
    b.grid(7, 4, (iu, iv) => {
      const a = (iu / 7) * TAU
      const lat = (iv / 4) * Math.PI
      return {
        x: Math.sin(lat) * Math.sin(a) * r,
        y: Math.cos(lat) * r,
        z: Math.sin(lat) * Math.cos(a) * r,
        c: gradient([[0, '#eef0cf'], [1, '#cfdc98']], iv / 4),
      }
    }, 1)
    b.matrix = new THREE.Matrix4()
  }
  return { geo: b.build(), center: arc(0.62), axis: UP.clone(), back: rawColor('#ebe6f6') }
}

const lerpHex = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)]
  const c = (i: number) => Math.round((x[i] + (y[i] - x[i]) * t) * 255).toString(16).padStart(2, '0')
  return `#${c(0)}${c(1)}${c(2)}`
}

// 毛茛的六种颜色：[花瓣根部（最深）, 中间, 瓣缘（最亮）]。颜色写在几何上，每种颜色一个变体，不用多加着色器。
const RANUNCULUS: [string, string, string][] = [
  ['#7c0f28', '#c01c3c', '#e6465c'], // 绯红
  ['#b8440a', '#ee7a18', '#ffa64e'], // 橙
  ['#c8432f', '#f4745c', '#ffa78f'], // 珊瑚
  ['#8e1254', '#d02c82', '#f06fac'], // 洋红
  ['#d08a06', '#f8c618', '#ffe460'], // 黄
  ['#d97c3e', '#f9b078', '#ffd8b0'], // 杏
]

// 花毛茛：饱满圆润、偏扁的花球，像迷你牡丹。很多层又薄又圆的小花瓣一圈圈紧紧包着：
// 每一层花瓣的上缘都落在同一个扁球面上（宽、矮），外层在“赤道”，越往里越靠近顶上、越往里收。花心有一点绿。
function ranunculus(variant: number) {
  const [deep, mid, light] = RANUNCULUS[variant % RANUNCULUS.length]
  // 茎长一些（花球不变），和玫瑰、郁金香高低错开
  return plant({ height: 0.34 + Math.random() * 0.08, tilt: 0.1 + Math.random() * 0.3, back: '#fff6f2' }, (b) => {
    const Rb = 0.033 // 花球的水平半径
    const Rv = 0.018 // 竖直半径：比水平小得多，花是扁的（以前是正圆的球，太高）
    const c = 0.008 // 球心离花托多高
    const counts = [6, 6, 7, 7, 7, 6, 6, 5]
    counts.forEach((n, i) => {
      const t = i / (counts.length - 1)
      const th = ((95 - 78 * Math.pow(t, 0.9)) * Math.PI) / 180 // 这一层花瓣上缘在球面上的位置（从赤道到球顶）
      const r = Rb * Math.sin(th) * (0.97 + Math.random() * 0.06)
      const h = c + Rv * Math.cos(th)
      const curl = 0.12 + 0.45 * t
      const inner = 0.002
      const len = r / (1 - curl) - inner
      const lift = 0.001 + 0.004 * t
      // 薄纸一样的花瓣：外层浅、里层深，瓣缘最亮
      const stops: Stop[] = [[0, lerpHex(deep, mid, 0.3)], [0.65, lerpHex(mid, deep, t * 0.5)], [1, lerpHex(light, mid, t * 0.7)]]
      petals(b, { n, len, width: 0.7, a: 0.5, b: 0.8, round: 1, cup: (h - lift) / len, curl, lift, turn: i * 2.39996, rows: 2, cols: 3, inner, stops })
    })
    disc(b, 0.0045, 0.002, c + Rv * 0.97, [[0, '#7a9a3a'], [1, '#4f6a22']], 6, 1)
  }, 0.1, 0.22)
}

// 红玫瑰：经典的高心卷边。侧面看是高脚杯：外层花瓣先向上托，瓣尖和两边向外翻卷；
// 中间几层螺旋抱紧、高高拱起。二十来片厚实的花瓣，一层层疏朗分明。颜色越往里越深。
function rose() {
  // 茎短一些（花朵大小不变）：以前整株比别的花高出一截，很突兀
  return plant({ height: 0.35 + Math.random() * 0.066, tilt: 0.08 + Math.random() * 0.25, back: '#e8c8cc' }, (b) => {
    const layers = [
      { n: 5, len: 0.05, width: 0.72, cup: 1.05, droop: 0.5, curl: 0, roll: 1.1, lift: 0, cols: 4, rows: 3 },
      { n: 5, len: 0.046, width: 0.72, cup: 1.35, droop: 0.32, curl: 0.06, roll: 0.9, lift: 0.003, cols: 4, rows: 3 },
      { n: 5, len: 0.04, width: 0.74, cup: 1.6, droop: 0.12, curl: 0.22, roll: 0.6, lift: 0.007, cols: 4, rows: 3 },
      { n: 4, len: 0.032, width: 0.82, cup: 2.0, droop: 0, curl: 0.55, roll: 0.2, lift: 0.012, cols: 3, rows: 2 },
      { n: 3, len: 0.022, width: 0.95, cup: 2.4, droop: 0, curl: 0.8, roll: 0, lift: 0.018, cols: 3, rows: 2 },
    ]
    layers.forEach((l, i) => {
      const t = i / (layers.length - 1)
      const stops: Stop[] = [[0, '#5e0816'], [0.55, lerpHex('#b0132b', '#7c0c20', t)], [1, lerpHex('#d9273c', '#a01228', t)]]
      petals(b, { n: l.n, len: l.len, width: l.width, a: 0.55, b: 0.85, round: 0.7, cup: l.cup, droop: l.droop, curl: l.curl, roll: l.roll, lift: l.lift, turn: i * 1.26, rows: l.rows, cols: l.cols, inner: 0.003, stops })
    })
  }, 0.12, 0.3)
}

const ease = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 郁金香的花头：六片椭圆形的花瓣（里外两轮各三片）围成杯盏，底窄、中间鼓、口微收，瓣尖略向外翻。
 * 每片高矮不一，杯口是错落的。局部坐标：花托在原点，+Y 朝上。
 */
function tulipHead(b: MeshBuilder, R: number, H: number, stops: Stop[]) {
  for (let i = 0; i < 6; i++) {
    const outer = i % 2 === 0
    const th0 = (i * TAU) / 6 + (Math.random() - 0.5) * 0.12
    const half = (Math.PI / 3) * (outer ? 0.68 : 0.62)
    const h = H * (outer ? 1 : 0.93) * (0.92 + Math.random() * 0.16)
    const flare = (outer ? 0.16 : 0.06) + Math.random() * 0.08
    const inset = outer ? 1 : 0.92
    b.grid(4, 6, (iu, iv) => {
      const u = (iu / 4) * 2 - 1
      const v = iv / 6
      const egg = Math.sin(Math.PI * (0.12 + 0.72 * v))
      const rho = R * inset * (0.3 + 0.7 * egg) * (1 - 0.05 * u * u) + R * flare * v * v * v
      // 轮廓：下半部是椭圆，中间最宽，往上收成柔和的尖（太圆不像郁金香，太尖又像锯齿）
      const e = v < 0.5 ? Math.sqrt(Math.max(0, 1 - ((v - 0.5) / 0.62) ** 2)) : Math.max(0.12, Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.5) / 0.5, 1.8))))
      const a = th0 + u * half * Math.max(0.03, e)
      return { x: Math.sin(a) * rho, y: h * v, z: Math.cos(a) * rho, c: gradient(stops, v) }
    }, 1)
  }
  // 杯底：花瓣根部之间的小洞用浅黄的圆底盖住（以前是深色，远看花底发灰）
  disc(b, R * 0.5, -0.004, 0.0015, [[0, '#f2dc8a'], [1, '#d8bc5a']], 6, 1)
}

/** 一株郁金香：微弯的花茎、根部两片宽大的披针形叶，顶上一朵杯盏。stops：花瓣从根部到瓣尖的颜色 */
function tulipPlant(stops: Stop[]): SpeciesGeo {
  const b = new MeshBuilder()
  // 花茎短一些、粗一些：以前细长的茎顶着小花头，看着摇摇欲坠
  const H = 0.24 + Math.random() * 0.06
  const az = Math.random() * TAU
  const d = v3(Math.sin(az), 0, Math.cos(az))
  const bend = 0.01 + Math.random() * 0.025
  const top = v3(d.x * bend, H, d.z * bend)
  tube(b, [v3(0, 0, 0), v3(d.x * bend * 0.1, H * 0.5, d.z * bend * 0.1), v3(d.x * bend * 0.5, H * 0.85, d.z * bend * 0.5), top], 0.0046, 0.0038, '#5f8a4c', '#7fa860')
  broadLeaf(b, az + 2.2 + Math.random() * 0.5, 0.18 + Math.random() * 0.1, 0.18 + Math.random() * 0.05, 0.045)
  broadLeaf(b, az - 2.0 - Math.random() * 0.5, 0.26 + Math.random() * 0.1, 0.15 + Math.random() * 0.04, 0.04)
  const q = new THREE.Quaternion().setFromAxisAngle(v3(d.z, 0, -d.x), 0.04 + Math.random() * 0.14)
  b.matrix = new THREE.Matrix4().compose(top, q, v3(1, 1, 1))
  tulipHead(b, 0.028, 0.072, stops)
  b.matrix = new THREE.Matrix4()
  const axis = UP.clone().applyQuaternion(q)
  // 花瓣内侧几乎和外侧一样亮：薄而透光的感觉
  return { geo: b.build(), center: top.clone().addScaledVector(axis, 0.034), axis, back: rawColor('#fff6f2') }
}

// 郁金香的颜色：明亮、饱和、带渐变（以前根部一圈深色，竖着的花瓣又受光少，看着发灰）。
// 盛放用的六种和花毛茛同一个色系；参考用户给的图：粉色底部泛白、红瓣黄边、纯黄。
const TULIP_COLORS: Stop[][] = [
  [[0, '#c81e36'], [0.45, '#e2283e'], [0.8, '#f0505a'], [1, '#f77c78']], // 绯红
  [[0, '#f08a1a'], [0.5, '#f7a028'], [0.85, '#fbbf4a'], [1, '#fdd468']], // 橙
  [[0, '#f2b632'], [0.2, '#ea463c'], [0.65, '#ee4c3e'], [0.88, '#f69a48'], [1, '#fcd45a']], // 红瓣黄边
  [[0, '#fbe0e6'], [0.22, '#f6a4bd'], [0.6, '#ef7ea4'], [1, '#f8b2c9']], // 粉，底部泛白
  [[0, '#f4c418'], [0.55, '#fcd83c'], [1, '#fff27e']], // 黄
  [[0, '#f7ae76'], [0.5, '#f9c08a'], [1, '#fde0b8']], // 杏
]
// 花田里的粉郁金香：照 🌷 的颜色，饱和明亮的玫粉，底部稍深、往上渐亮。
// 竖着的花瓣受光少，会比写的颜色暗一成多，所以这里写得偏亮、偏艳；瓣缘不能太淡，不然一暗就发灰
const TULIP_BLUSH: Stop[] = [[0, '#e2336c'], [0.35, '#f84e82'], [0.75, '#ff6e9a'], [1, '#ff92b4']]

/**
 * 小苍兰的一朵花：六片花瓣下半部合成细管，上半部张开成喇叭，瓣尖圆、微微外翻；开得不平摊。
 * open：1 = 开了，越小越合拢（半开的花）。局部坐标：花管底在原点，+Y 是花朝向。
 */
function trumpet(b: MeshBuilder, size: number, open: number, stops: Stop[], turn: number) {
  const tubeR = 0.0042 * size
  const R = (0.0055 + 0.0165 * open) * size // 喇叭口的半径
  const H = 0.03 * size
  for (let i = 0; i < 6; i++) {
    const th0 = (i * TAU) / 6 + turn
    const half = (Math.PI / 6) * (i % 2 ? 1.22 : 1.1) // 两轮花瓣在管子部分互相叠着，看不到缝
    const L = 0.94 + Math.random() * 0.12
    b.grid(3, 4, (iu, iv) => {
      const u = (iu / 3) * 2 - 1
      const v = iv / 4
      const f = ease(0.3, 1, v)
      const rho = tubeR * (0.6 + 0.4 * Math.min(1, v / 0.3)) + (R - tubeR) * Math.pow(f, 1.4)
      const y = H * L * (v - 0.18 * open * f * f) // 瓣尖往外翻，所以上得慢一点
      // 瓣尖宽而圆（以前收成尖角，看着像星星）；张开的部分花瓣更宽，互相叠着
      const tip = v < 0.6 ? 1 : Math.max(0.5, Math.sqrt(Math.max(0, 1 - ((v - 0.6) / 0.4) ** 2)))
      const a = th0 + u * half * (1 + 0.3 * f) * tip
      const cup = 1 - 0.08 * u * u * f // 每片花瓣中间微微凹
      return { x: Math.sin(a) * rho * cup, y, z: Math.cos(a) * rho * cup, c: gradient(stops, v) }
    }, 1)
  }
}

/**
 * 小苍兰：花茎上部弯向一侧，花穗短而斜伸；靠近茎的三朵开成喇叭，接着一朵半开，梢头一串越来越小的花苞，
 * 都开在花穗的上侧、朝外。叶子细长如剑。
 */
function freesia(): SpeciesGeo {
  const b = new MeshBuilder()
  const H = 0.3 + Math.random() * 0.08
  const az = Math.random() * TAU
  const dir = v3(Math.sin(az), 0, Math.cos(az))
  const side = v3(Math.cos(az), 0, -Math.sin(az))
  tube(b, [v3(0, 0, 0), v3(0, H * 0.5, 0), v3(dir.x * 0.01, H * 0.86, dir.z * 0.01), v3(dir.x * 0.028, H, dir.z * 0.028)], 0.003, 0.0024, '#4f7d4a', '#6f9a4f')
  const spine = (t: number) => v3(dir.x * (0.028 + t * 0.12), H + 0.02 * t + 0.03 * t * t, dir.z * (0.028 + t * 0.12))
  tube(b, Array.from({ length: 5 }, (_, i) => spine(i / 4)), 0.002, 0.0011, '#6f9a4f', '#9cb46a', 1)
  for (let k = 0; k < 3; k++) broadLeaf(b, az + 1.2 + k * 1.9 + Math.random() * 0.4, 0.06 + Math.random() * 0.08, 0.24 + Math.random() * 0.08, 0.016)
  const YELLOW: Stop[] = [[0, '#e39410'], [0.35, '#f4c018'], [0.75, '#f8d634'], [1, '#fbe25a']]
  const items: [number, number, 'open' | 'half' | 'bud'][] = [
    [0.04, 1.44, 'open'], [0.2, 1.35, 'open'], [0.36, 1.25, 'open'], [0.52, 1.1, 'half'],
    [0.64, 0.7, 'bud'], [0.74, 0.58, 'bud'], [0.83, 0.48, 'bud'], [0.91, 0.4, 'bud'], [0.98, 0.32, 'bud'],
  ]
  items.forEach(([t, s, kind], i) => {
    const at = spine(t)
    const axis = UP.clone().addScaledVector(dir, kind === 'bud' ? 1.1 : 0.8).addScaledVector(side, i % 2 ? 0.4 : -0.4).normalize()
    b.matrix = new THREE.Matrix4()
    const base = at.clone().addScaledVector(axis, 0.005 * s)
    tube(b, [at, base], 0.0015, 0.0013, '#8fae62', '#a4bd72', 1)
    b.matrix = new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromUnitVectors(UP, axis), v3(1, 1, 1))
    if (kind === 'bud') {
      const rx = 0.005 * s
      const ry = 0.013 * s
      // 花苞：底下绿，尖上带一点褐红
      const stops: Stop[] = [[0, '#7f9c52'], [0.6, '#8d8a52'], [1, '#8a5a46']]
      b.grid(5, 3, (iu, iv) => {
        const a = (iu / 5) * TAU
        const lat = Math.PI - (iv / 3) * Math.PI
        return { x: Math.sin(lat) * Math.sin(a) * rx, y: ry + Math.cos(lat) * ry, z: Math.sin(lat) * Math.cos(a) * rx, c: gradient(stops, iv / 3) }
      }, 1)
    } else {
      trumpet(b, s, kind === 'open' ? 1 : 0.35, YELLOW, i * 0.7)
    }
  })
  b.matrix = new THREE.Matrix4()
  return { geo: b.build(), center: spine(0.3), axis: UP.clone(), back: rawColor('#f6eccc') }
}

export type SpeciesId = 'nemophila' | 'hydrangea' | 'daisy' | 'lily' | 'cosmos' | 'golden' | 'freesia' | 'tulipBlush' | 'ranunculus' | 'tulip' | 'rose'

export const SPECIES: Record<SpeciesId, (variant: number) => SpeciesGeo> = {
  nemophila,
  hydrangea,
  daisy,
  lily: lilyOfTheValley,
  cosmos,
  golden: goldenrod,
  freesia,
  tulipBlush: () => tulipPlant(TULIP_BLUSH),
  ranunculus,
  tulip: (v) => tulipPlant(TULIP_COLORS[v % TULIP_COLORS.length]),
  rose,
}

/** 每种花几个变体（默认 3 个形状）；毛茛一种颜色一个 */
/** “单种”里列出的花（名字在 lib/i18n.ts）：花田专用的粉郁金香不单独列，有六色的郁金香 */
export const SINGLE_SPECIES: SpeciesId[] = ['nemophila', 'hydrangea', 'daisy', 'lily', 'cosmos', 'golden', 'freesia', 'ranunculus', 'tulip', 'rose']

export const SPECIES_VARIANTS: Partial<Record<SpeciesId, number>> = { ranunculus: RANUNCULUS.length, tulip: TULIP_COLORS.length }

/**
 * 每种花的相对密度：花头大的种得稀一些，不然互相挤在一起；也省三角形。
 * 铃兰一株约 1000 个三角形（铃铛是立体的），比其他花多很多，也要靠这个控制总量。
 */
export const SPECIES_DENSITY: Partial<Record<SpeciesId, number>> = { lily: 0.51, hydrangea: 0.6, freesia: 0.6, tulipBlush: 0.85, ranunculus: 0.75, tulip: 0.85, rose: 0.65 }
/** 花田预设里各种花的目标比例（百分比）；别的预设只含其中几种，按相对大小换算 */
export const SPECIES_SHARE: Record<SpeciesId, number> = { nemophila: 24, daisy: 20, golden: 18, cosmos: 16, hydrangea: 12, lily: 10, freesia: 18, tulipBlush: 18, ranunculus: 50, tulip: 32, rose: 18 }
/** 整株的相对大小：铃兰植株本来就高，缩小一些；玫瑰整株小 15%（花朵和高度一起）；花田里的粉郁金香大一些 */
export const SPECIES_SIZE: Partial<Record<SpeciesId, number>> = { lily: 0.72, tulipBlush: 1.2, rose: 0.85 }

/**
 * 天空花（和“不带茎叶”的地面花）用的几何：只取需要的部位，以花头中心为原点，花朵朝向对齐 +Y。
 * head = 只有花；full = 整株。
 */
export type SkyForm = 'head' | 'full'
const FORM_PARTS: Record<SkyForm, number[]> = { head: [1], full: [0, 1, 2] }

export function skyGeometry(sp: SpeciesGeo, form: SkyForm): THREE.BufferGeometry {
  const src = sp.geo
  const index = src.index!.array
  const part = src.attributes.aPart
  const keep = new Set(FORM_PARTS[form])
  const q = new THREE.Quaternion().setFromUnitVectors(sp.axis.clone().normalize(), UP)
  const remap = new Map<number, number>()
  const pos: number[] = []
  const nor: number[] = []
  const col: number[] = []
  const prt: number[] = []
  const idx: number[] = []
  const v = new THREE.Vector3()
  const vertex = (i: number) => {
    let n = remap.get(i)
    if (n != null) return n
    n = remap.size
    remap.set(i, n)
    v.fromBufferAttribute(src.attributes.position as THREE.BufferAttribute, i).sub(sp.center).applyQuaternion(q)
    pos.push(v.x, v.y, v.z)
    v.fromBufferAttribute(src.attributes.normal as THREE.BufferAttribute, i).applyQuaternion(q)
    nor.push(v.x, v.y, v.z)
    const c = src.attributes.aColor
    col.push(c.getX(i), c.getY(i), c.getZ(i))
    prt.push(part.getX(i))
    return n
  }
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]]
    if (keep.has(part.getX(a)) && keep.has(part.getX(b)) && keep.has(part.getX(c))) idx.push(vertex(a), vertex(b), vertex(c))
  }
  const g = new THREE.BufferGeometry()
  g.setIndex(idx)
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(prt, 1))
  return g
}
