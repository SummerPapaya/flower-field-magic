// 开场页的花：每片花瓣、每朵小花、每个铃铛都是单独的一张图，组合和摆动在 wcMeadow.ts 里。
// 花瓣的画法照水彩花卉：花心留白往瓣尖渐深，一侧积色，叶脉和细描边，花瓣之间靠描边和淡影分开。
import { drop, makeCanvas, rgba, smooth, type P, type RNG } from './watercolor'

const TAU = Math.PI * 2

export interface Sprite {
  canvas: HTMLCanvasElement | null
  /** 形状的基准长度（像素） */
  L: number
  /** 贴图底边到形状根部的留白（像素） */
  padB: number
  /** 根部在贴图里的横坐标 */
  ax: number
  w: number
  h: number
  u0: number
  v0: number
  u1: number
  v1: number
}

const sprite = (canvas: HTMLCanvasElement, L: number, padB: number, ax = canvas.width / 2): Sprite => ({
  canvas, L, padB, ax, w: canvas.width, h: canvas.height, u0: 0, v0: 0, u1: 1, v1: 1,
})

/** 平滑地走过一串点 */
function trace(ctx: CanvasRenderingContext2D, pts: P[], closed = true) {
  ctx.beginPath()
  const n = pts.length
  const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  if (closed) {
    const m = mid(pts[n - 1], pts[0])
    ctx.moveTo(m[0], m[1])
    for (let i = 0; i < n; i++) {
      const q = mid(pts[i], pts[(i + 1) % n])
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1])
    }
    ctx.closePath()
  } else {
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < n - 1; i++) {
      const q = mid(pts[i], pts[i + 1])
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1])
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1])
  }
}

/** 一笔由粗到细 */
function taper(ctx: CanvasRenderingContext2D, pts: P[], w0: number, w1: number) {
  const left: P[] = []
  const right: P[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const w = (w0 + (w1 - w0) * (i / (n - 1))) / 2
    left.push([pts[i][0] - (dy / l) * w, pts[i][1] + (dx / l) * w])
    right.unshift([pts[i][0] + (dy / l) * w, pts[i][1] - (dx / l) * w])
  }
  trace(ctx, [...left, ...right])
  ctx.fill()
}

function bezier(a: P, b: P, c: P, d: P, n = 14): P[] {
  const out: P[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([
      u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
      u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
    ])
  }
  return out
}

interface PetalPaint {
  L: number
  /** 最宽处半宽 / 长度 */
  width: number
  /** 最宽处的位置 */
  peak: number
  tip: 'round' | 'point'
  /** 根部宽度（相对最宽处） */
  root: number
  /** 边缘的起伏 */
  wave?: number
  /** 瓣尖的小齿 */
  teeth?: number
  /** 瓣尖中间的缺口 */
  notch?: number
  /** 整片微微弯曲 */
  bend?: number
  /** 由根到尖的颜色 */
  stops: [number, string][]
  /** 趁湿滴进去的颜色 */
  wash: string[]
  washA: number
  deep: string
  line: string
  shadow: string
  paper: string
  /** 中间提亮的浓度 */
  lift: number
  veins: number
  veinA: number
  streaks: number
  streakA: number
  glints: number
}

function petalOutline(p: PetalPaint, r: RNG): P[] {
  const N = 26
  const a1 = r() * TAU
  const a2 = r() * TAU
  const bend = (p.bend ?? 0) * (r() - 0.5) * 2
  const side = (sign: number, phase: number): P[] => {
    const out: P[] = []
    for (let i = 0; i <= N; i++) {
      const t = 1 - Math.pow(1 - i / N, 1.5)
      let f: number
      if (t < p.peak) f = p.root + (1 - p.root) * Math.pow(Math.sin(((t / p.peak) * Math.PI) / 2), 0.9)
      else {
        const u = (t - p.peak) / (1 - p.peak)
        f = p.tip === 'point' ? Math.pow(Math.cos((u * Math.PI) / 2), 1.2) : Math.sqrt(Math.max(0, 1 - u * u))
      }
      if (p.wave) f *= 1 + p.wave * Math.sin(t * 11 + phase) * smooth(0.2, 0.7, t)
      const hw = f * p.width * p.L
      const x = sign * hw + bend * p.L * t * t
      let y = -t * p.L
      const near = smooth(p.peak, 1, t)
      if (p.teeth) y += p.L * 0.05 * near * Math.abs(Math.sin((hw / (p.width * p.L)) * p.teeth * Math.PI + phase))
      if (p.notch) y += p.L * p.notch * near * Math.exp(-Math.pow(hw / (p.width * p.L * 0.22), 2))
      out.push([x, y])
    }
    return out
  }
  return [...side(-1, a1), ...side(1, a2).reverse()]
}

function paintPetal(p: PetalPaint, r: RNG): Sprite {
  const pad = Math.ceil(p.L * 0.12)
  const cw = Math.ceil(p.width * p.L * 2.3 + pad * 2)
  const ch = Math.ceil(p.L + pad * 2)
  const c = makeCanvas(cw, ch)
  const ctx = c.getContext('2d')!
  ctx.translate(cw / 2, ch - pad)
  const out = petalOutline(p, r)

  // 纸色打底，外面一圈淡影：盖在别的花瓣上时，两片才分得开
  ctx.save()
  ctx.shadowColor = rgba(p.shadow, 0.3)
  ctx.shadowBlur = p.L * 0.06
  ctx.fillStyle = p.paper
  trace(ctx, out)
  ctx.fill()
  ctx.restore()

  ctx.save()
  trace(ctx, out)
  ctx.clip()
  const g = ctx.createLinearGradient(0, 0, 0, -p.L)
  for (const [at, color] of p.stops) g.addColorStop(at, color)
  ctx.fillStyle = g
  ctx.fillRect(-cw, -ch, cw * 2, ch * 2)
  const W = p.width * p.L
  // 一侧积色、瓣尖积色
  for (let i = 0; i < 4; i++) {
    const side = r() < 0.5 ? -1 : 1
    drop(ctx, side * W * (0.55 + r() * 0.5), -p.L * (0.45 + r() * 0.5), W * (0.45 + r() * 0.5) + p.L * 0.08, p.wash[Math.floor(r() * p.wash.length)], p.washA * (0.5 + r() * 0.7))
  }
  if (p.lift > 0) drop(ctx, (r() - 0.5) * W * 0.5, -p.L * (0.32 + r() * 0.14), p.L * 0.34, '#ffffff', p.lift)
  // 笔触：从瓣尖往里拖
  ctx.fillStyle = rgba(p.deep, p.streakA)
  for (let i = 0; i < p.streaks; i++) {
    const a = (r() - 0.5) * 2
    const y0 = -p.L * (0.8 + 0.2 * (1 - a * a))
    taper(ctx, [[a * W * 0.92, y0], [a * W * 0.72, y0 * 0.82], [a * W * 0.5, y0 * (0.48 + r() * 0.2)]], p.L * (0.012 + r() * 0.024), p.L * 0.002)
  }
  // 叶脉：从根部散开，越往外越淡
  ctx.lineCap = 'round'
  for (let i = 0; i < p.veins; i++) {
    const a = p.veins > 1 ? (i / (p.veins - 1) - 0.5) * 2 : 0
    const ex = a * W * 0.84
    const ey = -p.L * (0.72 + 0.2 * (1 - a * a))
    const v = ctx.createLinearGradient(0, 0, ex, ey)
    v.addColorStop(0.08, rgba(p.deep, p.veinA))
    v.addColorStop(0.75, rgba(p.deep, p.veinA * 0.45))
    v.addColorStop(1, rgba(p.deep, 0))
    ctx.strokeStyle = v
    ctx.lineWidth = Math.max(0.7, p.L * 0.006)
    ctx.beginPath()
    ctx.moveTo(a * W * 0.1, -p.L * 0.04)
    ctx.quadraticCurveTo(a * W * 0.5, -p.L * (0.36 + r() * 0.1), ex, ey)
    ctx.stroke()
  }
  // 边缘积色
  ctx.strokeStyle = rgba(p.deep, 0.16)
  ctx.lineWidth = p.L * 0.05
  trace(ctx, out)
  ctx.stroke()
  // 高光：几点留白
  ctx.fillStyle = 'rgba(255,255,255,0.86)'
  for (let i = 0; i < p.glints; i++) {
    const a = (r() - 0.5) * 1.5
    ctx.beginPath()
    ctx.ellipse(a * W * 0.8, -p.L * (0.72 + 0.14 * (1 - a * a)), p.L * 0.016, p.L * 0.008, a * 1.1, 0, TAU)
    ctx.fill()
  }
  ctx.restore()

  ctx.strokeStyle = rgba(p.line, 0.62)
  ctx.lineWidth = Math.max(1, p.L * 0.009)
  ctx.lineJoin = 'round'
  ctx.setLineDash([p.L * (0.5 + r() * 0.5), p.L * 0.012, p.L * 0.4, p.L * 0.02])
  trace(ctx, out)
  ctx.stroke()
  ctx.setLineDash([])
  return sprite(c, p.L, pad)
}

/** 把花瓣贴到一张整朵花的图上（angle = 0 时瓣尖朝上） */
function place(ctx: CanvasRenderingContext2D, s: Sprite, angle: number, len: number) {
  ctx.save()
  ctx.rotate(angle)
  const k = len / s.L
  ctx.scale(k, k)
  ctx.drawImage(s.canvas!, -s.ax, -(s.h - s.padB))
  ctx.restore()
}

/** 向日葵式的花盘：按叶序排列的小点 */
function seedDisc(R: number, colorAt: (d: number, r: RNG) => string, n: number, dot: number, r: RNG): Sprite {
  const size = Math.ceil(R * 2.3)
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  ctx.fillStyle = colorAt(0.5, r)
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.98, 0, TAU)
  ctx.fill()
  for (let i = n; i > 0; i--) {
    const d = Math.sqrt(i / n)
    const a = i * 2.39996
    ctx.fillStyle = colorAt(d, r)
    ctx.beginPath()
    const q = R * dot * (0.8 + d * 0.5) * (0.85 + r() * 0.3)
    ctx.ellipse(Math.cos(a) * d * R, Math.sin(a) * d * R, q, q * 0.8, a, 0, TAU)
    ctx.fill()
  }
  // 整体的立体感：右下压暗、左上提亮
  ctx.globalCompositeOperation = 'source-atop'
  drop(ctx, R * 0.35, R * 0.45, R * 1.05, '#3a1f06', 0.34)
  drop(ctx, -R * 0.35, -R * 0.4, R * 0.8, '#fff3c2', 0.26)
  ctx.globalCompositeOperation = 'source-over'
  return sprite(c, R * 2, 0)
}

// ---------- 喜林草 ----------

const NEMO: PetalPaint = {
  L: 150, width: 0.56, peak: 0.62, tip: 'round', root: 0.16, wave: 0.03, notch: 0.02,
  stops: [[0, '#f9eef5'], [0.28, '#ffffff'], [0.52, '#e8effd'], [0.76, '#b4caf6'], [1, '#86a4eb']],
  wash: ['#6e8ee4', '#8a8ce6'], washA: 0.32, deep: '#4f6fd0', line: '#4c69c6', shadow: '#3a4ea6', paper: '#ffffff',
  lift: 0.55, veins: 9, veinA: 0.34, streaks: 12, streakA: 0.1, glints: 2,
}
const NEMO_BACK: PetalPaint = {
  ...NEMO, stops: [[0, '#c3d0f4'], [0.5, '#a2b8ef'], [1, '#7492e4']], wash: ['#6280dc', '#8b8be4'], washA: 0.34, lift: 0, glints: 0, veinA: 0.4,
}

function nemoCenter(r: RNG): Sprite {
  const R = 70
  const size = R * 2 + 4
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  drop(ctx, 0, 0, R, '#fff4f6', 0.85)
  drop(ctx, 0, 0, R * 0.46, '#f4d9e8', 0.75)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3
    for (const k of [-0.2, 0, 0.2]) {
      const d = R * (0.3 + r() * 0.1 + Math.abs(k) * 0.3)
      ctx.fillStyle = 'rgba(96, 80, 176, 0.62)'
      ctx.beginPath()
      ctx.ellipse(Math.cos(a + k) * d, Math.sin(a + k) * d, R * 0.075, R * 0.03, a + k, 0, TAU)
      ctx.fill()
    }
  }
  return sprite(c, R * 2, 0)
}

/** 一根花蕊：米色花丝 + 淡紫色花药 */
function stamen(filament: string, anther: string, edge: string): Sprite {
  const c = makeCanvas(20, 90)
  const ctx = c.getContext('2d')!
  ctx.lineCap = 'round'
  ctx.strokeStyle = filament
  ctx.lineWidth = 2.4
  ctx.beginPath()
  ctx.moveTo(10, 88)
  ctx.lineTo(10, 16)
  ctx.stroke()
  ctx.fillStyle = anther
  ctx.strokeStyle = edge
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.ellipse(10, 11, 6, 9.5, 0, 0, TAU)
  ctx.fill()
  ctx.stroke()
  return sprite(c, 88, 2)
}

// ---------- 波斯菊 ----------

const COSMOS: PetalPaint = {
  L: 150, width: 0.33, peak: 0.74, tip: 'round', root: 0.12, teeth: 2.4, wave: 0.03,
  stops: [[0, '#c9437e'], [0.14, '#e681ab'], [0.46, '#f8c4d7'], [0.86, '#fbd9e4'], [1, '#f6b4cd']],
  wash: ['#ee8db1', '#e36b9b'], washA: 0.4, deep: '#c23c7a', line: '#b94a7e', shadow: '#7d2758', paper: '#fff8fa',
  lift: 0.3, veins: 7, veinA: 0.4, streaks: 20, streakA: 0.13, glints: 1,
}

// ---------- 雏菊 ----------

const DAISY: PetalPaint = {
  L: 150, width: 0.15, peak: 0.62, tip: 'round', root: 0.34, notch: 0.015,
  stops: [[0, '#aab0d2'], [0.24, '#dfe1f0'], [0.58, '#fdfdff'], [1, '#ffffff']],
  wash: ['#c7cae2'], washA: 0.3, deep: '#969bc0', line: '#8287ae', shadow: '#4e5286', paper: '#ffffff',
  lift: 0, veins: 3, veinA: 0.3, streaks: 3, streakA: 0.1, glints: 0,
}

// ---------- 向日葵（黄色） ----------

const SUN: PetalPaint = {
  L: 146, width: 0.26, peak: 0.44, tip: 'point', root: 0.34, bend: 0.05,
  stops: [[0, '#e58c1a'], [0.24, '#f5b52e'], [0.6, '#fcd34e'], [1, '#fbc739']],
  wash: ['#f0a21f', '#ffe685'], washA: 0.5, deep: '#cd7d10', line: '#c07410', shadow: '#7f4c06', paper: '#fff6d8',
  lift: 0.26, veins: 7, veinA: 0.46, streaks: 8, streakA: 0.12, glints: 1,
}
const SUN_BACK: PetalPaint = {
  ...SUN, stops: [[0, '#d67e14'], [0.5, '#eea925'], [1, '#f2b52e']], lift: 0, glints: 0,
}

// ---------- 玫瑰（粉色） ----------

const ROSE: PetalPaint = {
  L: 132, width: 0.6, peak: 0.6, tip: 'round', root: 0.2, wave: 0.07,
  stops: [[0, '#fbe6cf'], [0.34, '#fcdedb'], [0.68, '#f9c2d0'], [1, '#f08fad']],
  wash: ['#f291b0', '#fde3da'], washA: 0.46, deep: '#d65885', line: '#cf5582', shadow: '#8f3159', paper: '#fff7f4',
  lift: 0.4, veins: 8, veinA: 0.2, streaks: 8, streakA: 0.08, glints: 1,
}
const ROSE_BACK: PetalPaint = {
  ...ROSE, stops: [[0, '#f7bccb'], [0.6, '#f29db8'], [1, '#e97ba0']], lift: 0.12,
}

function roseCore(r: RNG): Sprite {
  const R = 44
  const size = R * 2 + 6
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  drop(ctx, 0, 0, R, '#f4a4bb', 0.95)
  drop(ctx, 0, 0, R * 0.55, '#d9608c', 0.8)
  ctx.lineCap = 'round'
  let a = r() * TAU
  for (let i = 0; i < 16; i++) {
    const d = R * (0.1 + (i / 16) * 0.82)
    const span = 1.5 + r() * 0.6
    ctx.strokeStyle = rgba(i % 3 === 0 ? '#fff0ee' : '#c74a7c', i % 3 === 0 ? 0.85 : 0.62)
    ctx.lineWidth = i % 3 === 0 ? 1.6 : 1.1
    ctx.beginPath()
    ctx.arc(0, 0, d, a, a + span)
    ctx.stroke()
    a += 1.4 + r() * 0.5
  }
  return sprite(c, R * 2, 0)
}

// ---------- 绣球 ----------

function floretPetal(rim: string, mid: string, deep: string, line: string, r: RNG): Sprite {
  return paintPetal({
    L: 76, width: 0.54, peak: 0.6, tip: 'round', root: 0.16, wave: 0.03,
    stops: [[0, '#fdfbf2'], [0.3, '#f0f1fe'], [0.68, mid], [1, rim]],
    wash: [rim, deep], washA: 0.36, deep, line, shadow: '#2f2f86', paper: '#ffffff',
    lift: 0.4, veins: 5, veinA: 0.3, streaks: 3, streakA: 0.08, glints: 1,
  }, r)
}

/** 一朵四瓣小花（平的，一整张） */
function floret(rim: string, mid: string, deep: string, line: string, r: RNG): Sprite {
  const R = 84
  const size = R * 2 + 12
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  const t0 = r() * TAU
  for (const i of [1, 3, 0, 2]) place(ctx, floretPetal(rim, mid, deep, line, r), t0 + (i / 4) * TAU + (r() - 0.5) * 0.14, R * (0.92 + r() * 0.1))
  // 中间一颗珠子
  const p = R * 0.1
  const g = ctx.createRadialGradient(-p * 0.35, -p * 0.4, p * 0.1, 0, 0, p)
  g.addColorStop(0, '#fffef0')
  g.addColorStop(0.6, '#f2e6b4')
  g.addColorStop(1, '#c9b67c')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, p, 0, TAU)
  ctx.fill()
  return sprite(c, R * 2, 0)
}

function hydrangeaBall(r: RNG): Sprite {
  const R = 96
  const size = R * 2 + 8
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  ctx.fillStyle = '#7f86dc'
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.96, 0, TAU)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-atop'
  for (let i = 0; i < 14; i++) drop(ctx, (r() - 0.5) * R * 1.8, (r() - 0.5) * R * 1.8, R * (0.2 + r() * 0.3), r() < 0.5 ? '#5b5fc4' : '#a59ae8', 0.5)
  return sprite(c, R * 2, 0)
}

// ---------- 铃兰 ----------

/** 一个铃铛（连着弯弯的花梗）。花梗的起点是摆动的支点，记在 ax / padB 上。 */
function bell(s: number, bud: boolean, r: RNG): Sprite {
  const pad = Math.ceil(s * 0.25)
  const cx = s * 1.3 + pad
  const top = s * 0.92 + pad
  const W = Math.ceil(cx + s * 1.3 + pad)
  const H = Math.ceil(top + s * (bud ? 1.5 : 1.9) + pad)
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')!
  const px = pad + s * 0.12
  const py = top + s * 0.1

  ctx.fillStyle = '#9dc35e'
  taper(ctx, bezier([px, py], [px + s * 0.05, top - s * 1.05], [cx - s * 0.2, top - s * 1.05], [cx, top + s * 0.08]), s * 0.15, s * 0.1)
  ctx.fillStyle = 'rgba(220, 240, 170, 0.7)'
  taper(ctx, bezier([px - s * 0.01, py], [px + s * 0.03, top - s * 1.05], [cx - s * 0.24, top - s * 1.06], [cx - s * 0.03, top + s * 0.03]), s * 0.05, s * 0.03)

  ctx.save()
  ctx.translate(cx, top)
  ctx.scale(0.86, 1) // 铃铛整体收窄一点
  const q = (x: number, y: number): P => [x * s, y * s]
  const out: P[] = bud
    ? [q(0, 0), q(0.55, 0.06), q(0.9, 0.5), q(0.92, 1), q(0.62, 1.32), q(0.3, 1.26), q(0, 1.36), q(-0.3, 1.26), q(-0.62, 1.32), q(-0.92, 1), q(-0.9, 0.5), q(-0.55, 0.06)]
    : [q(0, 0), q(0.5, 0.04), q(0.86, 0.34), q(0.98, 0.84), q(1.02, 1.2), q(1.24, 1.5), q(1.02, 1.56), q(0.82, 1.44), q(0.62, 1.68), q(0.34, 1.54), q(0.14, 1.72), q(-0.14, 1.72), q(-0.34, 1.54), q(-0.62, 1.68), q(-0.82, 1.44), q(-1.02, 1.56), q(-1.24, 1.5), q(-1.02, 1.2), q(-0.98, 0.84), q(-0.86, 0.34), q(-0.5, 0.04)]
  ctx.save()
  ctx.shadowColor = 'rgba(70, 76, 130, 0.42)'
  ctx.shadowBlur = s * 0.16
  ctx.fillStyle = '#ffffff'
  trace(ctx, out)
  ctx.fill()
  ctx.restore()
  ctx.save()
  trace(ctx, out)
  ctx.clip()
  drop(ctx, s * 0.82, s * 0.9, s * 0.92, '#a9acd8', 0.72)
  drop(ctx, -s * 1, s * 1, s * 0.62, '#bcbae6', 0.6)
  drop(ctx, -s * 0.28, s * 0.58, s * 0.5, '#ffffff', 0.95)
  drop(ctx, 0, s * 0.02, s * 0.56, '#c9e08f', 0.85)
  ctx.lineCap = 'round'
  for (const k of [-0.62, -0.22, 0.22, 0.62]) {
    ctx.strokeStyle = 'rgba(138, 142, 192, 0.36)'
    ctx.lineWidth = Math.max(1, s * 0.022)
    ctx.beginPath()
    ctx.moveTo(k * s * 0.42, s * 0.08)
    ctx.quadraticCurveTo(k * s * 1.3, s * 0.7, k * s * 1.2, s * 1.4)
    ctx.stroke()
  }
  if (!bud) {
    // 铃口里面：一弯阴影和几根花蕊
    ctx.fillStyle = 'rgba(158, 152, 208, 0.42)'
    ctx.beginPath()
    ctx.ellipse(0, s * 1.46, s * 0.86, s * 0.24, 0, 0, TAU)
    ctx.fill()
    for (const x of [-0.26, -0.08, 0.12, 0.3]) {
      const y = 1.4 + r() * 0.12
      ctx.strokeStyle = '#ded7a0'
      ctx.lineWidth = Math.max(1, s * 0.03)
      ctx.beginPath()
      ctx.moveTo(x * s * 0.8, s * 1.18)
      ctx.lineTo(x * s, s * y)
      ctx.stroke()
      ctx.fillStyle = '#f2e68e'
      ctx.strokeStyle = 'rgba(180, 160, 70, 0.8)'
      ctx.lineWidth = Math.max(0.7, s * 0.016)
      ctx.beginPath()
      ctx.ellipse(x * s, s * y, s * 0.062, s * 0.09, 0, 0, TAU)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
  ctx.strokeStyle = 'rgba(112, 116, 168, 0.72)'
  ctx.lineWidth = Math.max(1, s * 0.022)
  trace(ctx, out)
  ctx.stroke()
  // 花萼
  for (const [a, l] of [[-1.05, 0.46], [1.05, 0.46], [0.1, 0.34]] as [number, number][]) {
    ctx.save()
    ctx.rotate(a + Math.PI)
    ctx.fillStyle = a === 0.1 ? '#b7d776' : '#a4ca64'
    ctx.beginPath()
    ctx.moveTo(-s * 0.13, 0)
    ctx.quadraticCurveTo(-s * 0.12, -l * s * 0.6, 0, -l * s)
    ctx.quadraticCurveTo(s * 0.12, -l * s * 0.6, s * 0.13, 0)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(96, 136, 50, 0.7)'
    ctx.lineWidth = Math.max(0.8, s * 0.014)
    ctx.stroke()
    ctx.restore()
  }
  ctx.restore()
  return sprite(c, s * 2, H - py, px)
}

export interface LilyArch {
  stem: Sprite
  /** 铃铛的挂点：相对根部的横向偏移（贴图像素）、高度比例、朝哪边 */
  nodes: { dx: number; t: number; side: number; k: number; bud: boolean }[]
}

function lilyArch(height: number, r: RNG): LilyArch {
  const reach = height * 0.32
  const W = Math.ceil(reach * 2 + 60)
  const H = Math.ceil(height * 1.04)
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')!
  const ax = W / 2
  const arc = (t: number): P => [ax + reach * Math.pow(t, 2.3), H - height * Math.sin(t * 1.68)]
  const pts = Array.from({ length: 24 }, (_, i) => arc(i / 23))
  ctx.fillStyle = '#93bd58'
  taper(ctx, pts, height * 0.022, height * 0.008)
  ctx.fillStyle = 'rgba(222, 240, 170, 0.75)'
  taper(ctx, pts.map(([x, y]) => [x - height * 0.003, y] as P), height * 0.007, height * 0.002)
  const n = 6
  const nodes = Array.from({ length: n }, (_, i) => {
    const t = 0.46 + (i / (n - 1)) * 0.54
    const [x, y] = arc(t)
    return { dx: x - ax, t: (H - y) / H, side: i % 2 ? 1 : -1, k: 1 - (i / (n - 1)) * 0.5 + (r() - 0.5) * 0.06, bud: i >= n - 2 }
  })
  return { stem: sprite(c, H, 0, ax), nodes }
}

// ---------- 茎、叶、草 ----------

export interface Stem extends Sprite {
  /** 茎向一侧偏移的量（贴图像素） */
  lean: number
  bow: number
}

function stemSprite(H: number, lean: number, bow: number, width: number, color: string, deep: string): Stem {
  const m = Math.ceil(Math.abs(lean) + Math.abs(bow) + 8)
  const W = m * 2
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')!
  const ax = W / 2
  const pts = Array.from({ length: 16 }, (_, i) => {
    const t = i / 15
    return [ax + lean * t + bow * Math.sin(Math.PI * t), H - t * H] as P
  })
  ctx.fillStyle = color
  taper(ctx, pts, width, width * 0.62)
  ctx.fillStyle = rgba(deep, 0.5)
  taper(ctx, pts.map(([x, y]) => [x + width * 0.22, y] as P), width * 0.42, width * 0.24)
  return { ...sprite(c, H, 0, ax), lean, bow }
}

/** 叶子：两半一明一暗，中脉和侧脉留得淡淡的。lobes > 0 时是羽状裂叶。 */
function paintLeaf(L: number, width: number, lobes: number, light: string, dark: string): Sprite {
  const pad = Math.ceil(L * 0.06)
  const hw = width * L
  const cw = Math.ceil(hw * 2.4 + pad * 2)
  const ch = Math.ceil(L + pad * 2)
  const c = makeCanvas(cw, ch)
  const ctx = c.getContext('2d')!
  ctx.translate(cw / 2, ch - pad)
  const N = lobes ? 56 : 20
  const half = (sign: number): P[] => {
    const out: P[] = []
    for (let i = 0; i <= N; i++) {
      const t = i / N
      let f = Math.pow(Math.sin(Math.PI * Math.min(0.995, t * 0.96 + 0.02)), 0.85) * (1 - t * 0.25)
      if (lobes) f *= 0.42 + 0.58 * Math.pow(Math.abs(Math.sin(t * Math.PI * lobes)), 0.65)
      out.push([sign * f * hw, -t * L])
    }
    return out
  }
  const left = half(-1)
  const right = half(1)
  const paintHalf = (edge: P[], color: string) => {
    const poly = [...edge, ...edge.map(([, y]) => [0, y] as P).reverse()]
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(poly[0][0], poly[0][1])
    for (const [x, y] of poly) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
  }
  ctx.save()
  ctx.shadowColor = 'rgba(40, 70, 40, 0.28)'
  ctx.shadowBlur = L * 0.04
  paintHalf(left, light)
  paintHalf(right, dark)
  ctx.restore()
  ctx.globalCompositeOperation = 'source-atop'
  drop(ctx, -hw * 0.3, -L * 0.3, L * 0.24, '#f4f7dc', 0.42)
  drop(ctx, hw * 0.3, -L * 0.72, L * 0.3, '#4f8a6e', 0.3)
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(64, 104, 62, 0.34)'
  ctx.lineWidth = Math.max(0.7, L * 0.006)
  for (let i = 1; i <= 6; i++) {
    const t = i / 7.4
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(0, -t * L)
      ctx.quadraticCurveTo(s * hw * 0.5, -(t + 0.06) * L, s * hw * 0.92, -(t + 0.16) * L)
      ctx.stroke()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.strokeStyle = 'rgba(244, 248, 222, 0.8)'
  ctx.lineWidth = Math.max(0.9, L * 0.009)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, -L * 0.92)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(58, 96, 58, 0.62)'
  ctx.lineWidth = Math.max(0.8, L * 0.007)
  ctx.beginPath()
  ctx.moveTo(left[0][0], left[0][1])
  for (const [x, y] of left) ctx.lineTo(x, y)
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1])
  ctx.stroke()
  return sprite(c, L, pad)
}

function blade(L: number, width: number, color: string, deep: string): Sprite {
  const pad = 4
  const cw = Math.ceil(width * 3 + pad * 2)
  const ch = L + pad
  const c = makeCanvas(cw, ch)
  const ctx = c.getContext('2d')!
  ctx.translate(cw / 2, ch)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(-width, 0)
  ctx.quadraticCurveTo(-width * 0.9, -L * 0.55, 0, -L)
  ctx.quadraticCurveTo(width * 0.9, -L * 0.55, width, 0)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = rgba(deep, 0.45)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.quadraticCurveTo(width * 0.2, -L * 0.55, 0, -L)
  ctx.quadraticCurveTo(width * 0.9, -L * 0.55, width, 0)
  ctx.closePath()
  ctx.fill()
  return sprite(c, L, 0)
}

/** 远处的一丛草：一整张 */
function tuft(L: number, list: Sprite[], r: RNG): Sprite {
  const W = Math.ceil(L * 1.1)
  const H = Math.ceil(L * 1.02)
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')!
  ctx.translate(W / 2, H)
  for (let i = 0; i < 7; i++) {
    const a = ((i + 0.5) / 7 - 0.5) * 1.1 + (r() - 0.5) * 0.25
    place(ctx, list[Math.floor(r() * list.length)], a, L * (0.6 + r() * 0.38))
  }
  return sprite(c, L, 0)
}

/** 远景用的一小团色点 */
function dab(color: string, r: RNG): Sprite {
  const c = makeCanvas(36, 36)
  const ctx = c.getContext('2d')!
  ctx.translate(18, 18)
  drop(ctx, 0, 0, 13, color, 0.75)
  for (let i = 0; i < 4; i++) {
    const a = r() * TAU
    drop(ctx, Math.cos(a) * 6, Math.sin(a) * 6, 8, color, 0.5)
  }
  return sprite(c, 26, 0)
}

export type WcSpecies = 'nemophila' | 'hydrangea' | 'daisy' | 'lily' | 'cosmos' | 'golden' | 'rose'

export interface Assets {
  nemo: { front: Sprite[]; back: Sprite[]; center: Sprite; stamens: Sprite[] }
  cosmos: { front: Sprite[]; disc: Sprite }
  daisy: { front: Sprite[]; disc: Sprite }
  sun: { front: Sprite[]; back: Sprite[]; disc: Sprite }
  rose: { front: Sprite[]; back: Sprite[]; core: Sprite }
  hydrangea: { florets: Sprite[]; ball: Sprite }
  lily: { arches: LilyArch[]; bells: Sprite[]; buds: Sprite[] }
  stems: Stem[]
  leaves: { slim: Sprite[]; lobed: Sprite[]; wide: Sprite[] }
  blades: Sprite[]
  tufts: Sprite[]
  /** 远处用的整朵花 */
  far: Record<WcSpecies, Sprite[]>
  loose: Sprite[]
  dabs: Sprite[]
}

function bakeHead(R: number, draw: (ctx: CanvasRenderingContext2D, R: number) => void): Sprite {
  const size = Math.ceil(R * 2.5)
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.translate(size / 2, size / 2)
  draw(ctx, R)
  return sprite(c, R * 2, 0)
}

/** 画好全部素材。每画一批让出主线程，页面不会卡住。 */
export async function paintAssets(r: RNG, dabColors: string[], yieldNow: () => Promise<unknown>): Promise<Assets | null> {
  const many = (n: number, p: PetalPaint) => Array.from({ length: n }, () => paintPetal(p, r))
  const nemoFront = many(4, NEMO)
  const nemoBack = many(2, NEMO_BACK)
  const nemo = {
    front: nemoFront, back: nemoBack, center: nemoCenter(r),
    stamens: [stamen('#efe7c6', '#c7b6e6', '#8c78bd'), stamen('#ece2bd', '#b9a8e0', '#8069b4')],
  }
  await yieldNow()
  const cosmos = {
    front: many(4, COSMOS),
    disc: seedDisc(44, (d, q) => (d < 0.55 ? (q() < 0.5 ? '#f3c332' : '#e8ab22') : q() < 0.5 ? '#fbe07a' : '#f0b52a'), 90, 0.075, r),
  }
  const daisy = {
    front: many(4, DAISY),
    disc: seedDisc(54, (d, q) => (d < 0.6 ? (q() < 0.5 ? '#f6c732' : '#e9a91e') : q() < 0.6 ? '#fbdc62' : '#eea922'), 150, 0.06, r),
  }
  await yieldNow()
  const sun = {
    front: many(4, SUN),
    back: many(2, SUN_BACK),
    disc: seedDisc(70, (d, q) => {
      if (d < 0.5) return q() < 0.6 ? '#3d2410' : '#5b3614'
      if (d < 0.72) return q() < 0.5 ? '#6f4416' : '#8d5a1c'
      return q() < 0.55 ? '#c98a1e' : '#e4ae32'
    }, 340, 0.04, r),
  }
  const rose = { front: many(4, ROSE), back: many(2, ROSE_BACK), core: roseCore(r) }
  await yieldNow()
  const hydrangea = {
    florets: [
      floret('#7d8fe8', '#b3bdf4', '#5a6cd6', '#5a60c6', r),
      floret('#8a98ea', '#c2caf6', '#6474da', '#5c62c8', r),
      floret('#a08fe4', '#cdbcf4', '#7f6cd6', '#6b5cc4', r),
      floret('#7c9cec', '#b9cdf7', '#5a7ede', '#5468c8', r),
    ],
    ball: hydrangeaBall(r),
  }
  await yieldNow()
  const lily = {
    arches: [lilyArch(330, r), lilyArch(300, r)],
    bells: [bell(58, false, r), bell(58, false, r), bell(52, false, r)],
    buds: [bell(40, true, r)],
  }
  const stems = [
    stemSprite(320, 16, 10, 6.5, '#8fb56a', '#5b8a55'),
    stemSprite(320, -18, -8, 6.5, '#9abd70', '#628f56'),
    stemSprite(320, 8, -14, 6, '#86ad66', '#558352'),
    stemSprite(320, -10, 14, 6, '#94b86e', '#5d8a58'),
  ]
  const leaves = {
    slim: [paintLeaf(150, 0.17, 0, '#b5cd95', '#88ad7a'), paintLeaf(150, 0.14, 0, '#a7c58b', '#7da373')],
    lobed: [paintLeaf(150, 0.3, 4.5, '#acc98e', '#83a976'), paintLeaf(150, 0.26, 5.5, '#a4c288', '#7ba070')],
    wide: [paintLeaf(190, 0.2, 0, '#a9cb7f', '#79a56a')],
  }
  const blades = [
    blade(220, 5.5, '#8fb86f', '#5f9273'),
    blade(220, 4.5, '#a6c77f', '#6e9f60'),
    blade(220, 5, '#7fae64', '#548a68'),
    blade(220, 4, '#b7d08c', '#7fae64'),
  ]
  const tufts = Array.from({ length: 3 }, () => tuft(170, blades, r))
  await yieldNow()

  const flat = (ctx: CanvasRenderingContext2D, list: Sprite[], n: number, R: number, t0: number) => {
    for (let i = 0; i < n; i++) place(ctx, list[i % list.length], t0 + (i / n) * TAU + (r() - 0.5) * 0.1, R * (0.94 + r() * 0.1))
  }
  const disc = (ctx: CanvasRenderingContext2D, s: Sprite, Rd: number) => {
    const k = (Rd * 2) / s.L
    ctx.drawImage(s.canvas!, (-s.w / 2) * k, (-s.h / 2) * k, s.w * k, s.h * k)
  }
  const far: Record<WcSpecies, Sprite[]> = {
    nemophila: [bakeHead(58, (ctx, R) => {
      flat(ctx, nemo.front, 5, R, 0.3)
      disc(ctx, nemo.center, R * 0.46)
    })],
    cosmos: [bakeHead(58, (ctx, R) => {
      flat(ctx, cosmos.front, 8, R, 0.1)
      disc(ctx, cosmos.disc, R * 0.18)
    })],
    daisy: [bakeHead(58, (ctx, R) => {
      flat(ctx, daisy.front, 15, R, 0.2)
      disc(ctx, daisy.disc, R * 0.3)
    })],
    golden: [bakeHead(58, (ctx, R) => {
      flat(ctx, sun.back, 9, R * 0.96, 0.15)
      flat(ctx, sun.front, 11, R, 0.4)
      disc(ctx, sun.disc, R * 0.4)
    })],
    rose: [bakeHead(58, (ctx, R) => {
      flat(ctx, rose.front, 5, R, 0.2)
      flat(ctx, rose.front, 5, R * 0.68, 0.8)
      disc(ctx, rose.core, R * 0.34)
    })],
    // 远处的绣球：一团不规则的小花，大小、位置都随机，上亮下暗；不要排成整齐的圆盘（远看像徽章）
    hydrangea: [0, 1, 2].map(() => bakeHead(58, (ctx, R) => {
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.scale(1.06, 0.86)
      disc(ctx, hydrangea.ball, R * 0.84)
      ctx.restore()
      const pts = Array.from({ length: 24 }, () => {
        const a = r() * TAU
        const d = Math.sqrt(r()) * R * 0.66
        return { x: Math.cos(a) * d * 1.06, y: Math.sin(a) * d * 0.84 + (r() - 0.5) * R * 0.08, s: R * (0.18 + r() * 0.13), f: Math.floor(r() * 4), turn: r() * TAU }
      })
      pts.sort((p, q) => p.y - q.y)
      for (const p of pts) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.turn)
        ctx.globalAlpha = 0.8 + r() * 0.2
        disc(ctx, hydrangea.florets[p.f], p.s)
        ctx.restore()
      }
      // 下半边背光，暗一点
      ctx.globalCompositeOperation = 'source-atop'
      const g = ctx.createLinearGradient(0, -R, 0, R)
      g.addColorStop(0, 'rgba(255,255,255,0.12)')
      g.addColorStop(0.5, 'rgba(90,96,180,0)')
      g.addColorStop(1, 'rgba(60,64,150,0.32)')
      ctx.fillStyle = g
      ctx.fillRect(-R * 1.25, -R * 1.25, R * 2.5, R * 2.5)
      ctx.globalCompositeOperation = 'source-over'
    })),
    lily: [bakeHead(58, (ctx, R) => {
      const a = lily.arches[0]
      const k = (R * 1.8) / a.stem.L
      ctx.save()
      ctx.translate(-R * 0.15, R * 0.95)
      ctx.drawImage(a.stem.canvas!, -a.stem.ax * k, -a.stem.h * k, a.stem.w * k, a.stem.h * k)
      for (const n of a.nodes) {
        const b = n.bud ? lily.buds[0] : lily.bells[0]
        const bk = k * 1.05 * n.k
        ctx.save()
        ctx.translate(n.dx * k, -n.t * a.stem.h * k)
        ctx.scale(n.side * bk, bk)
        ctx.drawImage(b.canvas!, -b.ax, -(b.h - b.padB))
        ctx.restore()
      }
      ctx.restore()
    })],
  }
  const loose = [nemo.front[0], cosmos.front[0], rose.front[1], nemo.back[0]]
  const dabs = dabColors.map((color) => dab(color, r))
  return { nemo, cosmos, daisy, sun, rose, hydrangea, lily, stems, leaves, blades, tufts, far, loose, dabs }
}

/** 素材里的全部贴图（打进图集用） */
export function allSprites(a: Assets): Sprite[] {
  const set = new Set<Sprite>([
    ...a.nemo.front, ...a.nemo.back, a.nemo.center, ...a.nemo.stamens,
    ...a.cosmos.front, a.cosmos.disc, ...a.daisy.front, a.daisy.disc,
    ...a.sun.front, ...a.sun.back, a.sun.disc, ...a.rose.front, ...a.rose.back, a.rose.core,
    ...a.hydrangea.florets, a.hydrangea.ball,
    ...a.lily.arches.map((x) => x.stem), ...a.lily.bells, ...a.lily.buds,
    ...a.stems, ...a.leaves.slim, ...a.leaves.lobed, ...a.leaves.wide, ...a.blades, ...a.tufts,
    ...Object.values(a.far).flat(), ...a.dabs,
  ])
  return [...set]
}
