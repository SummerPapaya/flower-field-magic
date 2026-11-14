// 程序化水彩的基础笔法：很多层半透明、边缘随机变形的色块叠出颜料晕开的感觉（Tyler Hobbs 的生成水彩法）。
// 真正让画面像水彩的是最后一步的全屏滤镜（见 wcMeadow.ts），这里只负责把颜色铺对。

export type RNG = () => number
export type P = [number, number]

/** 固定种子的伪随机数，让画面每次都一样。 */
export function mulberry32(seed: number): RNG {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 近似标准正态分布 */
export const gauss = (r: RNG) => (r() + r() + r() + r() - 2) * 1.73

export const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/** 在每条边中点沿法线随机推一下，重复 depth 次：边缘就有了颜料自然晕开的不规则感。 */
export function deform(pts: P[], depth: number, variance: number, r: RNG): P[] {
  let cur = pts
  for (let d = 0; d < depth; d++) {
    const next: P[] = []
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i]
      const b = cur[(i + 1) % cur.length]
      const k = gauss(r) * variance
      next.push(a, [(a[0] + b[0]) / 2 - (b[1] - a[1]) * k, (a[1] + b[1]) / 2 + (b[0] - a[0]) * k])
    }
    cur = next
  }
  return cur
}

export function fillPoly(ctx: CanvasRenderingContext2D, pts: P[]) {
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.closePath()
  ctx.fill()
}

export interface WashOptions {
  layers: number
  alpha: number
  /** 边缘晕开的程度 */
  spread: number
}

/** 一块水彩：同一个底形变形出很多层，每层很淡，叠起来中间实、边缘虚。color 可以是渐变。 */
export function wash(ctx: CanvasRenderingContext2D, pts: P[], color: string | CanvasGradient, o: WashOptions, r: RNG) {
  const base = deform(pts, 1, o.spread, r)
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha *= o.alpha
  for (let l = 0; l < o.layers; l++) fillPoly(ctx, deform(base, 2, o.spread, r))
  ctx.restore()
}

/** 一滴湿颜料：中心浓、边缘完全化开。 */
export function drop(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, color: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, R)
  g.addColorStop(0, rgba(color, a))
  g.addColorStop(0.55, rgba(color, a * 0.55))
  g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(x - R, y - R, R * 2, R * 2)
}

/** 周期噪声的格点：一张 period×period 的随机数表，取值时首尾相接，贴图就能无缝平铺。 */
function lattice(period: number, r: RNG) {
  const t = new Float32Array(period * period)
  for (let i = 0; i < t.length; i++) t[i] = r()
  return { t, period }
}
function sample(l: { t: Float32Array; period: number }, u: number, v: number) {
  const x = u * l.period
  const y = v * l.period
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const p = l.period
  const x1 = (xi + 1) % p
  const y1 = (yi + 1) % p
  const a = l.t[yi * p + xi]
  const b = l.t[yi * p + x1]
  const c = l.t[y1 * p + xi]
  const d = l.t[y1 * p + x1]
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

const stretch = (v: number, k: number) => Math.max(0, Math.min(255, (0.5 + (v - 0.5) * k) * 255))

/**
 * 一张可平铺的噪声图，滤镜和湿画法都从这里取值：
 * R = 纸纹（细颗粒），G = 中尺度的斑驳，B = 大尺度的水流。
 */
export function noiseTile(size = 512): ImageData {
  const r = mulberry32(11)
  const fine = [lattice(256, r), lattice(128, r), lattice(64, r)]
  const mid = [lattice(10, r), lattice(20, r), lattice(40, r), lattice(80, r)]
  const low = [lattice(4, r), lattice(8, r), lattice(16, r)]
  const img = new ImageData(size, size)
  for (let y = 0; y < size; y++) {
    const v = y / size
    for (let x = 0; x < size; x++) {
      const u = x / size
      const i = (y * size + x) * 4
      const grain = r() * 0.42 + sample(fine[0], u, v) * 0.3 + sample(fine[1], u, v) * 0.18 + sample(fine[2], u, v) * 0.1
      const blot = sample(mid[0], u, v) * 0.5 + sample(mid[1], u, v) * 0.27 + sample(mid[2], u, v) * 0.15 + sample(mid[3], u, v) * 0.08
      const flow = sample(low[0], u, v) * 0.58 + sample(low[1], u, v) * 0.29 + sample(low[2], u, v) * 0.13
      img.data[i] = stretch(grain, 1.9)
      img.data[i + 1] = stretch(blot, 2.1)
      img.data[i + 2] = stretch(flow, 2.1)
      img.data[i + 3] = 255
    }
  }
  return img
}

/** 一笔水彩做的按钮底：中间实、边缘有点不规整，颜料往一侧积得深一点。 */
export function brushButton(w: number, h: number, color: string, deep: string): string {
  const pad = 22
  const c = makeCanvas(w + pad * 2, h + pad * 2)
  const ctx = c.getContext('2d')!
  const r = mulberry32(5)
  const pts: P[] = []
  const rad = h / 2
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI
    pts.push([pad + w - rad + Math.cos(a) * rad, pad + rad + Math.sin(a) * rad])
  }
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI / 2 + (i / 10) * Math.PI
    pts.push([pad + rad + Math.cos(a) * rad, pad + rad + Math.sin(a) * rad])
  }
  wash(ctx, pts, color, { layers: 24, alpha: 0.13, spread: 0.022 }, r)
  ctx.globalCompositeOperation = 'source-atop'
  const g = ctx.createLinearGradient(pad, 0, pad + w, h)
  g.addColorStop(0, rgba(deep, 0))
  g.addColorStop(1, rgba(deep, 0.6))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, c.width, c.height)
  for (let i = 0; i < 26; i++) {
    const k = r()
    drop(ctx, pad + r() * w, pad + r() * h, h * (0.14 + r() * 0.3), k < 0.6 ? deep : '#ffffff', 0.05 + r() * 0.09)
  }
  return c.toDataURL('image/png')
}
