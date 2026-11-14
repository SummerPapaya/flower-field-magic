// 开场页的整幅水彩画。分三步：
// 1. 用着色器把天空、远山、草地的湿画法底色画一次。
// 2. 每帧把花摆出来：近处的花每片花瓣都是单独的一片，有自己的朝向和摆动；远处的花是一整张贴图。
// 3. 全屏水彩滤镜（Bousseau 2006）：边缘抖动、边缘积色、颜料浓度随水流/斑驳/纸纹变化。
//    花在纸上动，颜料的颗粒留在纸上，所以动起来也像同一张画。
import { makeCanvas, mulberry32, noiseTile, smooth, type RNG } from './watercolor'
import { allSprites, paintAssets, type Assets, type LilyArch, type Sprite, type Stem, type WcSpecies } from './wcFlowers'
import { loadTitleGlyphs, paintTitle, paintTitleText } from './wcTitle'
import type { Lang } from '../lib/i18n'

const SPECIES: WcSpecies[] = ['nemophila', 'hydrangea', 'daisy', 'lily', 'cosmos', 'golden', 'rose']
// 各种花在画面里的比例：喜林草和雏菊多一些，绣球、铃兰、玫瑰是点缀。
const WEIGHT: Record<WcSpecies, number> = { nemophila: 1.4, cosmos: 1, daisy: 1.1, golden: 0.7, hydrangea: 0.3, lily: 0.5, rose: 0.55 }
// 花头相对大小
const SIZE: Record<WcSpecies, number> = { nemophila: 0.8, cosmos: 0.82, daisy: 0.75, golden: 0.82, hydrangea: 1.95, lily: 0.5, rose: 0.69 }
/** 绣球花球比别的花大多少（小花本身不变大，靠朵数撑起来） */
const HYDRANGEA_GROW = 1.27
// 地平线附近的绣球缩到这个比例，越近越接近原大小
const FAR_HYDRANGEA = 0.6
const DAB_COLORS = ['#7f9fe9', '#f0a0be', '#ffffff', '#f7cd5e', '#b0a6ee']

const ATLAS = 2048
const ROWS = 3 // 每片竖着分几段，才弯得起来
const FLOATS = 6 // x y u v alpha shade
const VERTS = (ROWS + 1) * 2
const MAX_SPRITES = 6000
/** 花头半径小于这个（CSS 像素）就用整张贴图 */
const LOD_R = 10
const L_X = -0.28
const L_Y = 0.56
const L_Z = 0.78

const FULL_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

const NOISE_FN = `
uniform sampler2D uN;
float fb(vec2 p) {
  return texture2D(uN, p).b * 0.52 + texture2D(uN, p * 2.07 + 0.17).b * 0.3 + texture2D(uN, p * 4.3 + 0.41).g * 0.18;
}
float fs(vec2 p) {
  return texture2D(uN, p).b * 0.68 + texture2D(uN, p * 2.07 + 0.17).b * 0.32;
}`

/** 湿画法的底：天空的颜料被水推开，地平线上一抹暖色，三层远山，近大远小的草地和成片的花色。 */
const PAINT_FS = `
precision highp float;
varying vec2 vUv;
uniform float uAspect, uHz;
${NOISE_FN}
const vec3 PAPER = vec3(0.984, 0.973, 0.945);
float sq(float x) { return x * x; }
float ridge(float x, float base, float amp, float seed) {
  return base - amp * (fb(vec2(x * 0.42 + seed, seed * 0.37)) - 0.28);
}
vec3 layer(vec3 col, vec2 uv, float top, vec3 tint, float a, float mist, float n) {
  float m = smoothstep(top - 0.0016, top + 0.0022, uv.y);
  float fade = 1.0 - smoothstep(top, top + mist, uv.y) * 0.72;
  return mix(col, tint, m * a * fade * (0.7 + n * 0.55));
}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float w = fs(p * 0.3 + 0.13);
  float n = fs(p * 0.5 + vec2(w, w * 0.7) * 0.36 + 0.31);
  float n2 = fs(p * 0.28 + vec2(0.61, 0.17) + w * 0.18);
  float up = clamp(1.0 - uv.y / uHz, 0.0, 1.0);

  // 天空：颜料从上往下淡开，留出大片纸白；干后边缘有一圈水痕
  float wet = n * 0.86 + up * 0.44 - 0.1;
  float pig = smoothstep(0.34, 0.6, wet);
  float tide = exp(-sq((wet - 0.36) / 0.01)) * 0.2;
  vec3 skyc = mix(vec3(0.75, 0.85, 0.97), vec3(0.53, 0.68, 0.93), smoothstep(0.44, 0.8, n * 0.66 + up * 0.36));
  vec3 col = mix(PAPER, skyc, clamp(pig * (0.5 + up * 0.5), 0.0, 1.0));
  col = mix(col, vec3(0.66, 0.76, 0.93), tide * (1.0 - up * 0.5));
  // 一点紫，再靠近地平线一抹桃色
  col = mix(col, vec3(0.83, 0.80, 0.95), smoothstep(0.5, 0.74, n2) * 0.26 * (1.0 - up * 0.7));
  float glow = exp(-sq((uv.y - uHz * 0.94) / 0.08));
  col = mix(col, vec3(0.99, 0.89, 0.82), glow * (0.46 + n2 * 0.36));

  // 远山和树影
  float x = uv.x * uAspect;
  col = layer(col, uv, ridge(x, uHz - 0.018, 0.06, 4.2), vec3(0.69, 0.77, 0.89), 0.5, 0.06, n);
  col = layer(col, uv, ridge(x, uHz - 0.004, 0.038, 8.8), vec3(0.58, 0.70, 0.76), 0.56, 0.045, n);
  col = layer(col, uv, ridge(x, uHz + 0.006, 0.02, 1.3), vec3(0.54, 0.69, 0.60), 0.62, 0.03, n);

  // 草地：噪声按透视压扁，越远越细
  float edge = uHz + (fb(vec2(uv.x * 1.3, 0.37)) - 0.5) * 0.014;
  float depth = (uv.y - edge) / (1.0 - uHz);
  float pv = 1.0 / (max(depth, 0.0) + 0.09);
  vec2 pp = vec2((uv.x - 0.5) * uAspect * pv * 0.5, pv * 0.16);
  float h1 = fb(pp * 0.5 + 0.3);
  float h2 = fb(pp * 0.22 + 0.71);
  vec3 g = mix(vec3(0.80, 0.87, 0.64), vec3(0.67, 0.80, 0.56), smoothstep(0.34, 0.66, h1 + depth * 0.18));
  g = mix(g, vec3(0.58, 0.75, 0.66), smoothstep(0.5, 0.72, h2) * 0.5);
  g = mix(g, vec3(0.47, 0.66, 0.47), smoothstep(0.3, 1.0, depth) * 0.72);
  // 成片的花色，湿的时候融进草里
  float far = 1.0 - depth * 0.7;
  g = mix(g, vec3(0.62, 0.72, 0.94), smoothstep(0.53, 0.68, fb(pp * 0.28 + 0.11)) * 0.56 * far);
  g = mix(g, vec3(0.96, 0.72, 0.80), smoothstep(0.55, 0.68, fb(pp * 0.23 + 0.53)) * 0.46 * far);
  g = mix(g, vec3(0.98, 0.86, 0.50), smoothstep(0.57, 0.70, fb(pp * 0.26 + 0.87)) * 0.44 * far);
  col = mix(col, g, smoothstep(-0.006, 0.01, depth) * (0.8 + n * 0.25));
  gl_FragColor = vec4(col, 1.0);
}`

/** 一朵云：上沿像菜花一样有形，下沿化开，带一点冷色的影子。 */
const CLOUD_FS = `
precision highp float;
varying vec2 vUv;
${NOISE_FN}
void main() {
  vec2 q = (vUv - 0.5) * vec2(2.0, 2.0);
  float env = 1.0 - smoothstep(0.1, 1.0, length(q * vec2(1.0, 1.25) + vec2(0.0, 0.18)));
  float n = fb(vUv * vec2(0.46, 0.17) + vec2(0.3, 0.13));
  float s = n * 0.8 + env * 0.62 - 0.4;
  float a = smoothstep(0.16, 0.34, s) * smoothstep(0.0, 0.34, vUv.y);
  vec3 c = mix(vec3(0.74, 0.79, 0.91), vec3(1.0, 0.995, 0.975), smoothstep(0.26, 0.7, vUv.y + n * 0.3));
  a *= 0.9;
  gl_FragColor = vec4(c * a, a);
}`

/** 每帧画底图：风吹过时草地泛起一道浅色的波。 */
const GROUND_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uHz, uT;
uniform vec2 uSize;
uniform vec4 uGust;
uniform float uWind;
void main() {
  float y = 1.0 - vUv.y;
  float near = smoothstep(uHz + 0.004, uHz + 0.13, y);
  float x = vUv.x * uSize.x - (y - uHz) * uSize.y * 0.5;
  float a = (x - uGust.x) / uGust.y;
  float b = (x - uGust.z) / uGust.w;
  float g1 = exp(-a * a);
  float g2 = 0.55 * exp(-b * b);
  float g = (g1 + g2 - g1 * g2) * uWind;
  float wave = sin(y * uSize.y * 0.14 - uT * 2.4 + x * 0.025);
  vec2 uv = vUv;
  uv.x -= near * (0.4 + g) * (1.2 + wave * 1.3) / uSize.x;
  vec3 c = texture2D(uTex, uv).rgb;
  c += near * g * (0.022 + wave * 0.012);
  gl_FragColor = vec4(c, 1.0);
}`

const SPRITE_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aA;
attribute float aS;
uniform vec2 uSize;
varying vec2 vUv;
varying float vA;
varying float vS;
void main() {
  vUv = aUv;
  vA = aA;
  vS = aS;
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
}`

const SPRITE_FS = `
precision mediump float;
varying vec2 vUv;
varying float vA;
varying float vS;
uniform sampler2D uTex;
void main() {
  vec4 c = texture2D(uTex, vUv);
  c.rgb *= vS;
  gl_FragColor = c * vA;
}`

/** 水彩滤镜。颜料浓度 d：1 不变，>1 变深，<1 变淡；纸白（C=1）怎么都还是白的，这正是水彩的特点。 */
const POST_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene, uN;
uniform vec2 uRes;
uniform float uDpr, uReveal;
const vec3 PAPER = vec3(0.984, 0.973, 0.945);
void main() {
  vec2 fc = gl_FragCoord.xy / uDpr;
  vec2 px = 1.0 / uRes;
  vec4 flow = texture2D(uN, fc / 780.0);
  vec4 blot = texture2D(uN, fc / 230.0 + 0.37);
  vec4 fine = texture2D(uN, fc / 74.0 + 0.11);
  float h = texture2D(uN, fc / 340.0).r;
  float h2 = texture2D(uN, (fc + vec2(0.9, -0.9)) / 340.0).r;

  // 边缘不规则：取色时按噪声推开一点
  vec2 wob = (vec2(blot.g, flow.g) - 0.5) * 1.3 + (vec2(fine.g, fine.b) - 0.5) * 0.55;
  vec2 uv = vUv + wob * uDpr * px;
  vec3 c = texture2D(uScene, uv).rgb;

  // 颜料在边缘积得深一点
  vec2 e = px * uDpr * 1.15;
  vec3 gx = texture2D(uScene, uv + vec2(e.x, 0.0)).rgb - texture2D(uScene, uv - vec2(e.x, 0.0)).rgb;
  vec3 gy = texture2D(uScene, uv + vec2(0.0, e.y)).rgb - texture2D(uScene, uv - vec2(0.0, e.y)).rgb;
  float edge = length(gx) + length(gy);

  // 开场：颜料从纸上晕开
  float rv = flow.b * 0.62 + blot.g * 0.38 + abs(vUv.y - 0.5) * 0.5;
  float m = smoothstep(rv - 0.05, rv + 0.05, uReveal * 1.8 - 0.28);
  float rim = 1.0 - abs(m * 2.0 - 1.0);

  float d = 1.0
    + (flow.b - 0.5) * 0.46
    + (blot.g - 0.5) * 0.3
    + (h - 0.5) * 0.42
    + min(edge * 0.7, 0.5)
    + rim * 0.5;
  // 不同颜料沉淀得不一样：色相微微偏移
  vec3 dc = vec3(d) + (blot.b - 0.5) * vec3(0.16, -0.03, -0.14);
  vec3 o = c - (c - c * c) * (dc - 1.0);

  // 纸：冷压纸的起伏，最高的地方笔没碰到，留下一点白
  o *= 1.0 + (h - h2) * 0.075;
  o = mix(o, PAPER, smoothstep(0.84, 0.97, h) * 0.26);
  o = mix(PAPER * (1.0 + (h - h2) * 0.05), o, m);
  gl_FragColor = vec4(o, 1.0);
}`

interface PetalPart {
  kind: 0
  s: Sprite
  cr: number
  sr: number
  len: number
  base: number
  lift: number
  cup: number
  curl: number
  phase: number
  freq: number
  amp: number
  tone: number
}

/** 平贴在头上的一张：花盘、绣球的小花 */
interface FlatPart {
  kind: 1
  s: Sprite
  c: [number, number, number]
  a: [number, number, number]
  b: [number, number, number]
  n: [number, number, number]
  phase: number
  amp: number
  tone: number
}

interface StamenPart {
  kind: 2
  s: Sprite
  dir: [number, number, number]
  len: number
  phase: number
}

type Part = (PetalPart | FlatPart | StamenPart) & { z?: number; layer?: number }

interface Head {
  parts: Part[]
  pitch: number
  yaw: number
  roll: number
  nod: number
}

interface Leaf {
  s: Sprite
  t: number
  side: number
  angle: number
  len: number
  width: number
  curl: number
  phase: number
}

interface Bell {
  s: Sprite
  dx: number
  t: number
  side: number
  size: number
  phase: number
}

interface FlowerPlant {
  kind: 'flower'
  x: number
  y: number
  R: number
  stem: Stem
  h: number
  flex: number
  leaves: Leaf[]
  head: Head
  phase: number
  delay: number
}

interface FarPlant {
  kind: 'far'
  x: number
  y: number
  R: number
  stem: Stem
  h: number
  s: Sprite
  squash: number
  roll: number
  flex: number
  phase: number
  delay: number
}

interface LilyPlant {
  kind: 'lily'
  x: number
  y: number
  arch: LilyArch
  h: number
  mirror: boolean
  bells: Bell[]
  leaves: Leaf[]
  flex: number
  phase: number
  delay: number
}

interface Tuft {
  kind: 'tuft'
  x: number
  y: number
  blades: { s: Sprite; angle: number; len: number; curl: number; phase: number }[]
  delay: number
}

interface FarTuft {
  kind: 'fartuft'
  x: number
  y: number
  s: Sprite
  size: number
  phase: number
  delay: number
}

type Plant = FlowerPlant | FarPlant | LilyPlant | Tuft | FarTuft

interface Floating {
  s: Sprite
  x: number
  y: number
  len: number
  drift: number
  fall: number
  spin: number
  phase: number
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

function packAtlas(list: Sprite[]) {
  const pad = 8
  const area = list.reduce((n, s) => n + (s.w + pad) * (s.h + pad), 0)
  const fit = Math.min(1, Math.sqrt((ATLAS * ATLAS * 0.72) / area))
  const canvas = makeCanvas(ATLAS, ATLAS)
  const ctx = canvas.getContext('2d')!
  let x = pad
  let y = pad
  let row = 0
  for (const s of [...list].sort((a, b) => b.h - a.h)) {
    const w = Math.ceil(s.w * fit)
    const h = Math.ceil(s.h * fit)
    if (x + w + pad > ATLAS) {
      x = pad
      y += row + pad
      row = 0
    }
    ctx.drawImage(s.canvas!, x, y, w, h)
    s.u0 = x / ATLAS
    s.v0 = y / ATLAS
    s.u1 = (x + w) / ATLAS
    s.v1 = (y + h) / ATLAS
    s.canvas = null
    x += w + pad
    row = Math.max(row, h)
  }
  return canvas
}

const pick = <T,>(list: T[], r: RNG) => list[Math.floor(r() * list.length)]
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const gauss2 = (r: RNG) => (r() + r() + r() - 1.5) * 0.9

export class WatercolorMeadow {
  private readonly canvas: HTMLCanvasElement
  private readonly titleEl: HTMLElement | null
  private readonly still: boolean
  private readonly onResize: () => void
  private readonly onVisible: () => void
  private readonly onLost: (e: Event) => void
  private readonly onRestored: () => void
  private gl: WebGLRenderingContext | null = null
  private atlasCanvas: HTMLCanvasElement | null = null
  private noise: ImageData | null = null
  private assets: Assets | null = null
  private plants: Plant[] = []
  private floats: Floating[] = []
  private W = 0
  private H = 0
  private dpr = 1
  private maxDpr = 2
  private horizon = 0
  private raf = 0
  private t0 = 0
  private last = 0
  private stopped = false
  private resizeTimer = 0
  private slowSum = 0
  private slowN = 0
  private fronts = [0, 1, 0, 1]
  /** 风力：进页面时为 0，几秒内慢慢起来 */
  private wind = 0
  private m = new Float64Array(9)
  // GL 资源
  private programs!: ReturnType<WatercolorMeadow['buildPrograms']>
  private quad!: WebGLBuffer
  private vbo!: WebGLBuffer
  private ibo!: WebGLBuffer
  private verts = new Float32Array(MAX_SPRITES * VERTS * FLOATS)
  private nVerts = 0
  private noiseTex!: WebGLTexture
  private atlasTex!: WebGLTexture
  private titleTex: WebGLTexture | null = null
  private titleGlyphs: HTMLImageElement | null = null
  private titleBox = { x: 0, y: 0, w: 0, h: 0 }
  private cloudTarget: Target | null = null
  private bg: Target | null = null
  private scene: Target | null = null
  /** 第一次画好时调用 */
  onPainted: (() => void) | null = null
  /** 手写标题画不出来时调用（设备不支持 WebGL，或字形图没加载到）：页面改用普通文字 */
  onPlainTitle: (() => void) | null = null

  /** 标题用哪种语言画：中文是手写字形，英文是手写体 */
  private lang: Lang

  constructor(canvas: HTMLCanvasElement, titleEl: HTMLElement | null, lang: Lang = 'zh') {
    this.canvas = canvas
    this.titleEl = titleEl
    this.lang = lang
    this.still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    this.onResize = () => {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = window.setTimeout(() => this.layout(), 160)
    }
    this.onVisible = () => {
      if (document.hidden) {
        cancelAnimationFrame(this.raf)
        this.raf = 0
      } else this.resume()
    }
    this.onLost = (e) => {
      e.preventDefault()
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.onRestored = () => {
      this.initGL()
      this.layout()
      this.resume()
    }
    addEventListener('resize', this.onResize)
    document.addEventListener('visibilitychange', this.onVisible)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    void this.prepare()
  }

  private resume() {
    if (this.stopped || this.raf || this.still || !this.scene) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  // 花要画一阵：分几帧画，不卡住页面。WebGL 也放到最后才取，StrictMode 下先卸载的那次不会碰它。
  private async prepare() {
    const begin = performance.now()
    const next = () => new Promise((res) => setTimeout(res, 0))
    const [assets, glyphs] = await Promise.all([paintAssets(mulberry32(2026), DAB_COLORS, next), loadTitleGlyphs()])
    if (this.stopped || !assets) return
    this.titleGlyphs = glyphs
    if (!glyphs && this.lang === 'zh') this.onPlainTitle?.()
    this.assets = assets
    this.atlasCanvas = packAtlas(allSprites(assets))
    this.noise = noiseTile()
    await next()
    if (this.stopped) return
    if (!this.initGL()) {
      this.onPlainTitle?.()
      return
    }
    this.t0 = performance.now()
    this.layout()
    if (import.meta.env.DEV) console.info(`[intro] painted in ${Math.round(performance.now() - begin)} ms`)
    this.onPainted?.()
    this.resume()
  }

  private buildPrograms(gl: WebGLRenderingContext) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const make = (vs: string, fs: string, names: string[]) => {
      const p = gl.createProgram()!
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
      gl.bindAttribLocation(p, 0, 'aPos')
      gl.bindAttribLocation(p, 1, 'aUv')
      gl.bindAttribLocation(p, 2, 'aA')
      gl.bindAttribLocation(p, 3, 'aS')
      gl.linkProgram(p)
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) ?? 'link')
      const u: Record<string, WebGLUniformLocation | null> = {}
      for (const n of names) u[n] = gl.getUniformLocation(p, n)
      return { p, u }
    }
    return {
      paint: make(FULL_VS, PAINT_FS, ['uN', 'uAspect', 'uHz']),
      cloud: make(FULL_VS, CLOUD_FS, ['uN']),
      ground: make(FULL_VS, GROUND_FS, ['uTex', 'uHz', 'uT', 'uSize', 'uGust', 'uWind']),
      sprite: make(SPRITE_VS, SPRITE_FS, ['uTex', 'uSize']),
      post: make(FULL_VS, POST_FS, ['uScene', 'uN', 'uRes', 'uDpr', 'uReveal']),
    }
  }

  private initGL() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
    if (!gl || !this.atlasCanvas || !this.noise) return false
    this.gl = gl
    this.programs = this.buildPrograms(gl)
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    this.vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW)
    this.ibo = gl.createBuffer()!
    const idx = new Uint16Array(MAX_SPRITES * ROWS * 6)
    for (let s = 0, i = 0; s < MAX_SPRITES; s++) {
      for (let row = 0; row < ROWS; row++) {
        const a = s * VERTS + row * 2
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i)
        i += 6
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    this.atlasTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    this.noiseTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.noise)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)

    gl.disable(gl.DEPTH_TEST)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    this.cloudTarget = this.makeTarget(512, 180)
    this.fullscreen(this.programs.cloud, this.cloudTarget, (u) => {
      this.bindTex(0, this.noiseTex, u.uN)
    })
    this.bg = null
    this.scene = null
    this.titleTex = null
    return true
  }

  private makeTarget(w: number, h: number, old?: Target | null): Target {
    const gl = this.gl!
    if (old) {
      gl.deleteTexture(old.tex)
      gl.deleteFramebuffer(old.fbo)
    }
    w = Math.max(1, Math.round(w))
    h = Math.max(1, Math.round(h))
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fbo, w, h }
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl!
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }

  private target(t: Target | null) {
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null)
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height)
  }

  private fullscreen(
    prog: { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> },
    t: Target | null,
    setup: (u: Record<string, WebGLUniformLocation | null>) => void,
  ) {
    const gl = this.gl!
    this.target(t)
    gl.disable(gl.BLEND)
    gl.useProgram(prog.p)
    setup(prog.u)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.disableVertexAttribArray(1)
    gl.disableVertexAttribArray(2)
    gl.disableVertexAttribArray(3)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private layout() {
    if (this.stopped || !this.gl) return
    const gl = this.gl
    const W = this.canvas.clientWidth || innerWidth
    const H = this.canvas.clientHeight || innerHeight
    // 手机地址栏伸缩只改一点高度，不值得重画
    if (this.scene && W === this.W && Math.abs(H - this.H) < 140) return
    this.W = W
    this.H = H
    this.dpr = Math.min(devicePixelRatio || 1, this.maxDpr)
    this.horizon = H * (W > H ? 0.56 : H < 700 ? 0.65 : 0.6)
    this.resizeBuffers()
    this.placePlants()
    this.paintTitleTexture()

    // 底色只画一次，远处的花也烘进去
    this.bg = this.makeTarget(W * this.dpr, H * this.dpr, this.bg)
    this.fullscreen(this.programs.paint, this.bg, (u) => {
      this.bindTex(0, this.noiseTex, u.uN)
      gl.uniform1f(u.uAspect, W / H)
      gl.uniform1f(u.uHz, this.horizon / H)
    })
    this.nVerts = 0
    this.bakeDabs()
    this.flushSprites(this.bg, this.atlasTex, 0, this.nVerts)
    if (this.still) this.draw(100, 0)
  }

  private resizeBuffers() {
    this.canvas.width = Math.round(this.W * this.dpr)
    this.canvas.height = Math.round(this.H * this.dpr)
    this.scene = this.makeTarget(this.canvas.width, this.canvas.height, this.scene)
  }

  /** 换语言：只重画标题 */
  setLang(lang: Lang) {
    if (lang === this.lang) return
    this.lang = lang
    if (!this.gl || !this.scene) return
    this.paintTitleTexture()
    if (this.still) this.draw(100, 0)
  }

  /** 手写标题也画在这张纸上，位置跟着页面里的 h1 走。 */
  private paintTitleTexture() {
    const gl = this.gl!
    if (!this.titleEl || (this.lang === 'zh' && !this.titleGlyphs)) return
    const box = this.titleEl.getBoundingClientRect()
    const own = this.canvas.getBoundingClientRect()
    const k = own.width ? this.W / own.width : 1
    this.titleBox = { x: (box.left - own.left) * k, y: (box.top - own.top) * k, w: box.width * k, h: box.height * k }
    if (!box.width || !box.height) return
    const pw = Math.round(this.titleBox.w * this.dpr)
    const ph = Math.round(this.titleBox.h * this.dpr)
    const canvas = this.lang === 'en' ? paintTitleText(pw, ph, this.titleEl.textContent ?? 'Flower Field Magic') : paintTitle(pw, ph, this.titleGlyphs!)
    if (this.titleTex) gl.deleteTexture(this.titleTex)
    this.titleTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.titleTex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  /** 远处的花：一簇簇色点，越远越小。 */
  private bakeDabs() {
    const { W, H, horizon } = this
    const r = mulberry32(77)
    const groundH = H - horizon
    const dabs = this.assets!.dabs
    const clusters = Math.round((W * groundH) / 1100)
    for (let c = 0; c < clusters; c++) {
      const d0 = Math.pow(r(), 1.5) * 0.5
      const cx = r() * W
      const s = pick(dabs, r)
      const n = 8 + Math.floor(r() * 18)
      for (let i = 0; i < n; i++) {
        const d = Math.max(0.002, d0 + gauss2(r) * (0.006 + d0 * 0.05))
        const x = cx + gauss2(r) * (10 + d * 150)
        const y = horizon + d * groundH + 2
        const R = 0.9 + d * 13 + r() * 0.9
        this.emitStrip(s, x, y + R * 0.65, R * 2, R * 1.3, R, 0, 0.92, 1, false)
        if (this.nVerts >= (MAX_SPRITES - 200) * VERTS) return
      }
    }
  }

  // ---------- 摆花 ----------

  private makeHead(id: WcSpecies, R: number, r: RNG): Head {
    const a = this.assets!
    // 花大多朝上、朝向观者，偶尔有侧着的
    const side = r() < 0.22
    const pitch = side ? 0.8 + r() * 0.3 : 0.15 + r() * 0.5
    const yaw = (r() - 0.5) * (side ? 1.3 : 0.8)
    const roll = r() * Math.PI * 2
    const parts: Part[] = []
    const petal = (s: Sprite, phi: number, len: number, base: number, lift: number, cup: number, curl: number, amp: number, tone: number): PetalPart => ({
      kind: 0, s, cr: Math.cos(phi), sr: Math.sin(phi), len, base, lift, cup, curl,
      phase: r() * 6.28, freq: 2 + r() * 1.6, amp, tone,
    })
    const disc = (s: Sprite, Rd: number, lift: number): FlatPart => {
      const k = (Rd * 2) / s.L
      return {
        kind: 1, s, c: [0, 0, lift], a: [(s.w * k) / 2, 0, 0], b: [0, (s.h * k) / 2, 0], n: [0, 0, 1],
        phase: r() * 6.28, amp: 0, tone: 1,
      }
    }
    const big = R > 22
    switch (id) {
      case 'nemophila': {
        const bowl = side ? 0.82 + r() * 0.2 : 0.26 + r() * 0.2
        const t0 = r() * 6.28
        for (let i = 0; i < 5; i++) {
          parts.push(petal(pick(a.nemo.front, r), t0 + (i / 5) * 6.28 + (r() - 0.5) * 0.16, R * (0.95 + r() * 0.1), R * 0.03, 0, bowl + (r() - 0.5) * 0.1, -0.3 - r() * 0.2, 1, 0.97 + r() * 0.05))
        }
        parts.push(disc(a.nemo.center, R * 0.42, R * 0.02))
        if (big) {
          for (let i = 0; i < 7; i++) {
            const az = r() * 6.28
            const el = 0.72 + r() * 0.42
            parts.push({
              kind: 2, s: pick(a.nemo.stamens, r), dir: [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)],
              len: R * (0.3 + r() * 0.14), phase: r() * 6.28,
            })
          }
        }
        break
      }
      case 'cosmos': {
        const t0 = r() * 6.28
        const cup = side ? 0.62 + r() * 0.14 : 0.14 + r() * 0.16
        for (let i = 0; i < 8; i++) {
          parts.push(petal(pick(a.cosmos.front, r), t0 + (i / 8) * 6.28 + (r() - 0.5) * 0.12, R * (0.94 + r() * 0.12), R * 0.04, 0, cup + (r() - 0.5) * 0.14, -0.14 + r() * 0.16, 1, 0.97 + r() * 0.05))
        }
        parts.push(disc(a.cosmos.disc, R * 0.17, R * 0.04))
        break
      }
      case 'daisy': {
        const n = big ? 17 : 12
        const t0 = r() * 6.28
        const cup = side ? 0.5 + r() * 0.12 : 0.08 + r() * 0.14
        for (let i = 0; i < n; i++) {
          parts.push(petal(pick(a.daisy.front, r), t0 + (i / n) * 6.28 + (r() - 0.5) * 0.14, R * (0.9 + r() * 0.16), R * 0.08, (i % 2) * R * 0.015, cup + (r() - 0.5) * 0.16, -0.1 + r() * 0.2, 1.1, 0.97 + r() * 0.05))
        }
        parts.push(disc(a.daisy.disc, R * 0.29, R * 0.07))
        break
      }
      case 'golden': {
        const t0 = r() * 6.28
        const cup = side ? 0.52 + r() * 0.12 : 0.1 + r() * 0.12
        for (let i = 0; i < 9; i++) {
          parts.push({ ...petal(pick(a.sun.back, r), t0 + ((i + 0.5) / 9) * 6.28, R * (0.92 + r() * 0.08), R * 0.2, -R * 0.03, cup - 0.04, -0.12, 0.7, 0.96), layer: -1 })
        }
        for (let i = 0; i < 11; i++) {
          parts.push(petal(pick(a.sun.front, r), t0 + (i / 11) * 6.28 + (r() - 0.5) * 0.1, R * (0.96 + r() * 0.1), R * 0.2, 0, cup + (r() - 0.5) * 0.12, -0.22 + r() * 0.36, 1, 0.98 + r() * 0.04))
        }
        parts.push(disc(a.sun.disc, R * 0.4, R * 0.08))
        break
      }
      case 'rose': {
        const t0 = r() * 6.28
        const ring = (layer: number, n: number, len: number, base: number, cup: number, curl: number, offset: number, tone: number) => {
          for (let i = 0; i < n; i++) {
            parts.push({
              ...petal(pick(a.rose.front, r), t0 + offset + (i / n) * 6.28 + (r() - 0.5) * 0.16, R * len * (0.96 + r() * 0.08), R * base, 0, cup + (r() - 0.5) * 0.1, curl, 0.7, tone),
              layer,
            })
          }
        }
        ring(0, 5, 1, 0.1, 0.46, -0.55, 0, 1)
        ring(1, 5, 0.84, 0.13, 0.8, -0.42, 0.6, 0.99)
        ring(2, 4, 0.66, 0.14, 1.04, -0.26, 1.1, 0.97)
        ring(3, 4, 0.48, 0.12, 1.2, -0.1, 0.3, 0.95)
        if (big) ring(4, 3, 0.34, 0.08, 1.3, 0, 0.9, 0.93)
        parts.push(disc(a.rose.core, R * 0.17, R * 0.3))
        break
      }
      case 'hydrangea': {
        parts.push(disc(a.hydrangea.ball, R * 0.78, -R * 0.2))
        // 花球大，小花不变：小花的大小按花球放大前算，朵数按面积增加
        const R0 = R / HYDRANGEA_GROW
        const n = Math.round((R0 > 40 ? 52 : R0 > 22 ? 38 : 20) * HYDRANGEA_GROW * HYDRANGEA_GROW)
        const floret = (R0 > 40 ? 0.33 : R0 > 22 ? 0.38 : 0.47) / HYDRANGEA_GROW
        for (let i = 0; i < n; i++) {
          const z = 1 - ((i + 0.5) / n) * 1.25
          const rr = Math.sqrt(Math.max(0, 1 - z * z))
          const az = i * 2.39996
          const nx = Math.cos(az) * rr
          const ny = Math.sin(az) * rr
          // 切平面上的两根轴，转一个随机角度
          const tl = Math.hypot(ny, 1e-3 + nx) || 1
          const ax = [-ny / tl, nx / tl, 0]
          const bx = [ny * ax[2] - z * ax[1], z * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]]
          const rot = r() * 6.28
          const cr = Math.cos(rot)
          const sr = Math.sin(rot)
          const s = pick(a.hydrangea.florets, r)
          const size = R * floret * (0.9 + r() * 0.22) * 0.5 * (s.w / (s.L * 0.5))
          parts.push({
            kind: 1, s, c: [nx * R * 0.84, ny * R * 0.84, z * R * 0.84],
            a: [(ax[0] * cr + bx[0] * sr) * size, (ax[1] * cr + bx[1] * sr) * size, (ax[2] * cr + bx[2] * sr) * size],
            b: [(-ax[0] * sr + bx[0] * cr) * size, (-ax[1] * sr + bx[1] * cr) * size, (-ax[2] * sr + bx[2] * cr) * size],
            n: [nx, ny, z], phase: r() * 6.28, amp: 1, tone: 0.97 + r() * 0.05,
          })
        }
        break
      }
      case 'lily':
        break
    }
    return { parts, pitch, yaw, roll, nod: r() * 6.28 }
  }

  /** 按静止时的前后关系排好绘制顺序，再决定每片露出的是正面还是背面。 */
  private settleHead(head: Head, id: WcSpecies) {
    this.setM(head.pitch, head.yaw, head.roll)
    const m = this.m
    const a = this.assets!
    const backs: Partial<Record<WcSpecies, Sprite[]>> = { nemophila: a.nemo.back, rose: a.rose.back, golden: a.sun.back }
    const r = mulberry32(Math.round(head.nod * 1000))
    const key = new Map<Part, number>()
    for (const p of head.parts) {
      let z = 0
      let layer = p.layer ?? 0
      if (p.kind === 0) {
        const th = p.cup + p.curl * 0.5
        const mid = p.cup + p.curl * 0.3
        const X = p.base + p.len * 0.6 * Math.cos(mid)
        const Z = p.lift + p.len * 0.6 * Math.sin(mid)
        z = m[6] * p.cr * X + m[7] * p.sr * X + m[8] * Z
        const nz = m[6] * (-Math.sin(th) * p.cr) + m[7] * (-Math.sin(th) * p.sr) + m[8] * Math.cos(th)
        const list = backs[id]
        if (nz < -0.05) {
          if (list) p.s = pick(list, r)
          if (id !== 'rose') layer = 100 // 看到的是外侧：它挡在花心前面
        }
      } else if (p.kind === 1) {
        z = m[6] * p.c[0] + m[7] * p.c[1] + m[8] * p.c[2]
        if (id !== 'hydrangea') layer = 50
      } else {
        z = m[6] * p.dir[0] + m[7] * p.dir[1] + m[8] * p.dir[2]
        layer = 60
      }
      key.set(p, layer * 10000 + z)
    }
    head.parts.sort((p, q) => key.get(p)! - key.get(q)!)
  }

  private placePlants() {
    const { W, H, horizon } = this
    const a = this.assets!
    const r = mulberry32(9)
    const groundH = H - horizon
    const hero = Math.min(W * 0.105, H * 0.05, 48)
    const count = Math.min(400, Math.round((180 * W) / 375))
    // 按比例装进袋子再打乱：花种混得匀，不会一片全是同一种
    const bag: WcSpecies[] = []
    for (const id of SPECIES) for (let k = 0; k < Math.round(WEIGHT[id] * 10); k++) bag.push(id)
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    const placed: { x: number; d: number; R: number }[] = []
    const plants: Plant[] = []
    // 绣球花球大，中景和前景各最多一株，多出来的换成别的花
    const NEAR = 0.7
    const swaps: WcSpecies[] = ['cosmos', 'daisy', 'rose', 'golden', 'nemophila']
    const bigHydrangea = [0, 0]
    let swap = 0
    /** 每朵花的花头在屏幕上的位置，补空时看哪里没盖到 */
    const heads: { x: number; y: number; R: number }[] = []
    const addFlower = (id: WcSpecies, x: number, d: number, baseR: number, headY?: number) => addFlowerImpl(this, id, x, d, baseR, headY)
    for (let i = 0; i < count; i++) {
      const d = Math.pow((i + r()) / count, 1.32)
      const baseR = lerp(3.4, hero, Math.pow(d, 1.75))
      // 前排的铃兰单独摆，这里不再随机出现
      let id = bag[i % bag.length]
      if (id === 'lily' && d > NEAR) id = 'nemophila'
      if (id === 'hydrangea' && d > 0.45 && ++bigHydrangea[d > 0.8 ? 1 : 0] > 1) id = swaps[swap++ % swaps.length]
      const gapR = baseR * SIZE[id]
      // 同一深度上挑一个不挤的位置：候选里取离别的花最远的
      let x = 0
      let best = -1
      for (let k = 0; k < 8; k++) {
        const xk = r() * (W + 40) - 20
        let gap = 1e9
        for (const p of placed) {
          const dy = (p.d - d) * groundH * 1.1
          gap = Math.min(gap, Math.hypot(xk - p.x, dy) / (p.R + gapR))
        }
        if (gap > best) {
          best = gap
          x = xk
        }
      }
      placed.push({ x, d, R: gapR })
      addFlower(id, x, d, baseR)
    }
    // 左前方再放一丛绣球，和右前方那丛呼应
    {
      const d = 0.76
      addFlower('hydrangea', W * 0.13 + (r() - 0.5) * W * 0.04, d, lerp(3.4, hero, Math.pow(d, 1.75)))
    }
    // 补空：近处按屏幕上的格子查一遍，花头盖不到的地方补一朵。花头长在茎上，比扎根的地方高，
    // 所以屏幕最下面一条、左右两边容易只剩茎和草；补的花扎根在屏幕下面，花头正好落在空的地方。
    const cell = hero * 1.2
    for (let cy = horizon + groundH * 0.55; cy < H - cell * 0.1; cy += cell * 0.8) {
      const d = Math.min(1, Math.max(0, (cy - horizon) / groundH + 0.1))
      const baseR = lerp(3.4, hero, Math.pow(d, 1.75))
      for (let cx = cell * 0.35; cx < W; cx += cell) {
        const x = cx + (r() - 0.5) * cell * 0.4
        const y = cy + (r() - 0.5) * cell * 0.3
        const covered = heads.some((h) => Math.hypot(x - h.x, y - h.y) < h.R * 0.9 + baseR * 0.45)
        if (covered) continue
        addFlower(swaps[swap++ % swaps.length], x, d, baseR, y)
      }
    }
    function addFlowerImpl(self: WatercolorMeadow, id: WcSpecies, x: number, d: number, baseR: number, headY?: number) {
      // 绣球越远缩得越多：花球大，按近处的比例放到远处，比别的花大一圈，像一颗颗圆盘
      const shrink = id === 'hydrangea' ? lerp(FAR_HYDRANGEA, 1, smooth(0.15, 0.6, d)) : 1
      const R = baseR * SIZE[id] * shrink * (0.86 + r() * 0.28)
      const delay = 0.5 + d * 1.2 + r() * 0.3
      const stem = pick(a.stems, r)
      // 绣球花头大，茎不用那么长
      // 绣球是一丛矮灌木，花球贴着花丛，茎很短；太高会像浮在别的花上面
      const h = R * (id === 'hydrangea' ? 0.72 + r() * 0.3 : 1.6 + r() * 1.9) + 4
      const y = headY == null ? horizon + groundH * (0.04 + d * 1.0) : headY + h
      if (R >= LOD_R && id !== 'lily') heads.push({ x, y: y - h, R })
      const phase = r() * 6.28
      if (id === 'lily' && R >= LOD_R) {
        plants.push(self.makeLily(x, y, R, delay, r))
      } else if (R < LOD_R) {
        plants.push({
          kind: 'far', x, y, R, stem, h, s: pick(a.far[id], r), squash: id === 'hydrangea' ? 0.9 + r() * 0.1 : 0.68 + r() * 0.26,
          // 绣球上亮下暗，不能随便转；别的花从上往下看，怎么转都行
          roll: (r() - 0.5) * (id === 'hydrangea' ? 0.4 : 6.28), flex: 1, phase, delay,
        })
      } else {
        const head = self.makeHead(id, R, r)
        self.settleHead(head, id)
        const nLeaves = R > 18 ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2)
        const list = id === 'nemophila' ? a.leaves.lobed : id === 'hydrangea' ? a.leaves.wide : a.leaves.slim
        const leaves: Leaf[] = []
        for (let k = 0; k < nLeaves; k++) {
          const side = k % 2 ? 1 : -1
          // 绣球的叶子从花球下面向两边伸出来
          const bush = id === 'hydrangea'
          leaves.push({
            s: pick(list, r), t: bush ? 0.1 + k * 0.12 + r() * 0.06 : 0.14 + k * 0.2 + r() * 0.08,
            side, angle: side * (bush ? 0.95 + r() * 0.45 : 0.55 + r() * 0.5),
            len: R * (bush ? 0.55 + r() * 0.25 : 0.9 + r() * 0.5), width: 0.9 + r() * 0.3, curl: side * (0.4 + r() * 0.5), phase: r() * 6.28,
          })
        }
        plants.push({ kind: 'flower', x, y, R, stem, h, flex: id === 'hydrangea' ? 0.6 : 1, leaves, head, phase, delay })
      }
    }
    // 草
    const tufts = Math.round(count * 0.7)
    for (let i = 0; i < tufts; i++) {
      const d = Math.pow((i + r()) / tufts, 1.1)
      const y = horizon + groundH * (0.05 + d * 1.02)
      const size = lerp(7, hero * 2.2, Math.pow(d, 1.9)) * (0.75 + r() * 0.5)
      const x = r() * (W + 60) - 30
      const delay = 0.35 + d * 1 + r() * 0.2
      if (size > 26) {
        const n = 4 + Math.floor(r() * 3)
        plants.push({
          kind: 'tuft', x, y, delay,
          blades: Array.from({ length: n }, (_, k) => ({
            s: pick(a.blades, r), angle: ((k + 0.5) / n - 0.5) * 1 + (r() - 0.5) * 0.2, len: size * (0.7 + r() * 0.5),
            curl: (r() - 0.5) * 0.7, phase: r() * 6.28,
          })),
        })
      } else {
        plants.push({ kind: 'fartuft', x, y, s: pick(a.tufts, r), size, phase: r() * 6.28, delay })
      }
    }
    plants.sort((p, q) => p.y - q.y)
    // 前排的铃兰：小小的几丛，最后画，不会被别的花和草挡住
    const lilies = Math.max(3, Math.min(8, Math.round(W / 150)))
    for (let i = 0; i < lilies; i++) {
      const x = ((i + 0.5 + (r() - 0.5) * 0.5) / lilies) * W
      plants.push(this.makeLily(x, H + 2 + r() * 3, hero * 0.52 * (0.92 + r() * 0.16), 1.5 + r() * 0.4, r))
    }
    this.plants = plants
    if (import.meta.env.DEV && location.search.includes('specimen')) this.placeSpecimens(r)

    const n = Math.round(Math.min(14, Math.max(8, (W * H) / 34000)))
    this.floats = Array.from({ length: n }, () => ({
      s: pick(a.loose, r),
      x: r() * W,
      y: r() * H * 0.95,
      len: hero * (0.2 + r() * 0.26),
      drift: 14 + r() * 24,
      fall: 6 + r() * 11,
      spin: 0.5 + r() * 1.1,
      phase: r() * 6.28,
    }))
  }

  /** 开发用：`?specimen` 把每种花放大排开，调形态时看。上排正面，下排侧面。 */
  private placeSpecimens(r: RNG) {
    const a = this.assets!
    const ids: WcSpecies[] = ['nemophila', 'hydrangea', 'daisy', 'cosmos', 'golden', 'rose']
    const R = Math.min(this.W / 5.4, 70)
    const plants: Plant[] = []
    ids.forEach((id, i) => {
      for (const sideView of [false, true]) {
        const col = i % 3
        const row = Math.floor(i / 3) * 2 + (sideView ? 1 : 0)
        let head = this.makeHead(id, R, r)
        for (let k = 0; k < 40; k++) {
          if ((head.pitch > 0.9) === sideView) break
          head = this.makeHead(id, R, r)
        }
        this.settleHead(head, id)
        const y = 150 + row * R * 2.35
        plants.push({ kind: 'flower', x: (this.W / 3) * (col + 0.5), y, R, stem: a.stems[0], h: R * 0.4, flex: 1, leaves: [], head, phase: i, delay: -5 })
      }
    })
    plants.push(this.makeLily(this.W * 0.5, this.H - 8, R * 0.9, -5, r))
    this.plants = plants
    this.floats = []
  }

  private makeLily(x: number, y: number, R: number, delay: number, r: RNG): LilyPlant {
    const a = this.assets!.lily
    const arch = pick(a.arches, r)
    const h = R * (3 + r() * 0.5)
    const k = h / arch.stem.h
    const bells: Bell[] = arch.nodes.map((n) => ({
      s: n.bud ? a.buds[0] : pick(a.bells, r),
      dx: n.dx * k,
      t: n.t,
      side: n.side,
      size: k * 1.18 * n.k,
      phase: r() * 6.28,
    }))
    const leaves: Leaf[] = [-1, 1].map((side) => ({
      s: this.assets!.leaves.wide[0], t: 0.02, side, angle: side * (0.08 + r() * 0.12),
      len: h * (0.62 + r() * 0.2), width: 0.78, curl: side * (0.16 + r() * 0.2), phase: r() * 6.28,
    }))
    return { kind: 'lily', x, y, arch, h, mirror: r() < 0.5, bells, leaves, flex: 0.9, phase: r() * 6.28, delay }
  }

  // ---------- 写顶点 ----------

  /** 一张竖着分段的贴图：shear 让顶端偏移，越往上偏得越多。x, y 是根部 */
  private emitStrip(s: Sprite, x: number, y: number, w: number, h: number, ax: number, shear: number, alpha: number, shade: number, mirror: boolean) {
    const v = this.verts
    let o = this.nVerts * FLOATS
    const left = x - ax
    const uL = mirror ? s.u1 : s.u0
    const uR = mirror ? s.u0 : s.u1
    for (let row = 0; row <= ROWS; row++) {
      const t = row / ROWS
      const py = y - h * t
      const b = shear * h * Math.pow(t, 1.6)
      const tv = s.v1 + (s.v0 - s.v1) * t
      v[o++] = left + b; v[o++] = py; v[o++] = uL; v[o++] = tv; v[o++] = alpha; v[o++] = shade
      v[o++] = left + w + b; v[o++] = py; v[o++] = uR; v[o++] = tv; v[o++] = alpha; v[o++] = shade
    }
    this.nVerts += VERTS
  }

  /** 一片从 (x,y) 伸出的叶或草：朝 angle（0 = 向上）长，沿途弯曲 */
  private emitBlade(s: Sprite, x: number, y: number, angle: number, len: number, widthK: number, curl: number, alpha: number, shade: number) {
    const v = this.verts
    let o = this.nVerts * FLOATS
    const k = len / s.L
    const halfW = (s.w * k * widthK) / 2
    for (let row = 0; row <= ROWS; row++) {
      const t = row / ROWS
      const q = (t * s.h - s.padB) / s.L
      const mid = angle + curl * q * 0.5
      const th = angle + curl * q
      const px = x + Math.sin(mid) * len * q
      const py = y - Math.cos(mid) * len * q
      const cx = Math.cos(th) * halfW
      const cy = Math.sin(th) * halfW
      const tv = s.v1 + (s.v0 - s.v1) * t
      v[o++] = px - cx; v[o++] = py - cy; v[o++] = s.u0; v[o++] = tv; v[o++] = alpha; v[o++] = shade
      v[o++] = px + cx; v[o++] = py + cy; v[o++] = s.u1; v[o++] = tv; v[o++] = alpha; v[o++] = shade
    }
    this.nVerts += VERTS
  }

  /** 绕支点转动的一张（铃铛） */
  private emitSwing(s: Sprite, px: number, py: number, angle: number, k: number, sideSign: number, alpha: number) {
    const v = this.verts
    let o = this.nVerts * FLOATS
    const c = Math.cos(angle)
    const n = Math.sin(angle)
    const xs = [-s.ax * k * sideSign, (s.w - s.ax) * k * sideSign]
    for (let row = 0; row <= ROWS; row++) {
      const t = row / ROWS
      const ly = (s.padB - t * s.h) * k // 向下为正
      const tv = s.v1 + (s.v0 - s.v1) * t
      for (let side = 0; side < 2; side++) {
        const lx = xs[side]
        v[o++] = px + lx * c - ly * n
        v[o++] = py + lx * n + ly * c
        v[o++] = side ? s.u1 : s.u0
        v[o++] = tv
        v[o++] = alpha
        v[o++] = 1
      }
    }
    this.nVerts += VERTS
  }

  /** M = Ry(yaw) · Rx(-pitch) · Rz(roll)：局部 z 轴是花头朝向 */
  private setM(pitch: number, yaw: number, roll: number) {
    const m = this.m
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    m[0] = cy * cr - sy * sp * sr
    m[1] = -cy * sr - sy * sp * cr
    m[2] = sy * cp
    m[3] = cp * sr
    m[4] = cp * cr
    m[5] = sp
    m[6] = -sy * cr - cy * sp * sr
    m[7] = sy * sr - cy * sp * cr
    m[8] = cy * cp
  }

  /** 一片花瓣：在花头的三维空间里算出弯曲和翻动，再投到屏幕上 */
  private emitPetal(hx: number, hy: number, hs: number, p: PetalPart, t: number, gust: number, alpha: number) {
    const v = this.verts
    const m = this.m
    const s = p.s
    let o = this.nVerts * FLOATS
    const L = p.len * hs
    const halfW = ((s.w * L) / s.L) * 0.5
    const a = p.amp
    const f = p.freq
    const ph = p.phase
    // 迎风的一侧被压下去，背风的一侧被掀起来
    const facing = this.m[0] * p.cr + this.m[1] * p.sr
    const cup = p.cup + Math.sin(t * f + ph) * a * (0.028 + gust * 0.12) - gust * 0.2 * a * facing
    const twist = Math.sin(t * f * 0.73 + ph * 1.7) * a * (0.035 + gust * 0.24)
    const rip = Math.sin(t * f * 1.17 + ph * 2.3) * a * (0.03 + gust * 0.24)
    const base = p.base * hs
    const lift = p.lift * hs
    for (let row = 0; row <= ROWS; row++) {
      const tex = row / ROWS
      const q = (tex * s.h - s.padB) / s.L
      const bendK = p.curl + rip
      const mid = cup + bendK * q * 0.5
      const th = cup + bendK * q
      const X = base + L * q * Math.cos(mid)
      const Z = lift + L * q * Math.sin(mid)
      const lx = p.cr * X
      const ly = p.sr * X
      const sn = Math.sin(th)
      const cn = Math.cos(th)
      const nx = -sn * p.cr
      const ny = -sn * p.sr
      const nz = cn
      const tw = twist * q
      const ctw = Math.cos(tw)
      const stw = Math.sin(tw)
      const wx = (-p.sr * ctw + nx * stw) * halfW
      const wy = (p.cr * ctw + ny * stw) * halfW
      const wz = nz * stw * halfW
      // 明暗：转向光的地方亮一点
      const vx = m[0] * nx + m[1] * ny + m[2] * nz
      const vy = m[3] * nx + m[4] * ny + m[5] * nz
      const vz = m[6] * nx + m[7] * ny + m[8] * nz
      const lit = Math.abs(vx * L_X + vy * L_Y + vz * L_Z)
      const shade = p.tone * (0.9 + 0.13 * lit)
      const tv = s.v1 + (s.v0 - s.v1) * tex
      for (let side = -1; side <= 1; side += 2) {
        const Px = lx + wx * side
        const Py = ly + wy * side
        const Pz = Z + wz * side
        v[o++] = hx + m[0] * Px + m[1] * Py + m[2] * Pz
        v[o++] = hy - (m[3] * Px + m[4] * Py + m[5] * Pz)
        v[o++] = side < 0 ? s.u0 : s.u1
        v[o++] = tv
        v[o++] = alpha
        v[o++] = shade
      }
    }
    this.nVerts += VERTS
  }

  private emitFlat(hx: number, hy: number, hs: number, p: FlatPart, t: number, gust: number, alpha: number) {
    const v = this.verts
    const m = this.m
    const s = p.s
    let o = this.nVerts * FLOATS
    const e1 = p.amp * Math.sin(t * 2.6 + p.phase) * (0.02 + gust * 0.12)
    const e2 = p.amp * Math.sin(t * 2.1 + p.phase * 1.6) * (0.02 + gust * 0.12)
    const lit = Math.abs((m[0] * p.n[0] + m[1] * p.n[1] + m[2] * p.n[2]) * L_X + (m[3] * p.n[0] + m[4] * p.n[1] + m[5] * p.n[2]) * L_Y + (m[6] * p.n[0] + m[7] * p.n[1] + m[8] * p.n[2]) * L_Z)
    const shade = p.tone * (p.amp ? 0.84 + 0.2 * lit : 1)
    const la = Math.hypot(p.a[0], p.a[1], p.a[2])
    const lb = Math.hypot(p.b[0], p.b[1], p.b[2])
    const ax = (p.a[0] + p.n[0] * e1 * la) * hs
    const ay = (p.a[1] + p.n[1] * e1 * la) * hs
    const az = (p.a[2] + p.n[2] * e1 * la) * hs
    const bx = (p.b[0] + p.n[0] * e2 * lb) * hs
    const by = (p.b[1] + p.n[1] * e2 * lb) * hs
    const bz = (p.b[2] + p.n[2] * e2 * lb) * hs
    const cx = p.c[0] * hs
    const cy = p.c[1] * hs
    const cz = p.c[2] * hs
    for (let row = 0; row <= ROWS; row++) {
      const tex = row / ROWS
      const q = tex * 2 - 1
      const tv = s.v1 + (s.v0 - s.v1) * tex
      for (let side = -1; side <= 1; side += 2) {
        const Px = cx + ax * side + bx * q
        const Py = cy + ay * side + by * q
        const Pz = cz + az * side + bz * q
        v[o++] = hx + m[0] * Px + m[1] * Py + m[2] * Pz
        v[o++] = hy - (m[3] * Px + m[4] * Py + m[5] * Pz)
        v[o++] = side < 0 ? s.u0 : s.u1
        v[o++] = tv
        v[o++] = alpha
        v[o++] = shade
      }
    }
    this.nVerts += VERTS
  }

  private emitStamen(hx: number, hy: number, hs: number, p: StamenPart, t: number, gust: number, alpha: number) {
    const v = this.verts
    const m = this.m
    const s = p.s
    let o = this.nVerts * FLOATS
    const L = p.len * hs
    const wig = Math.sin(t * 3.6 + p.phase) * (0.02 + gust * 0.08)
    const dx = p.dir[0] + wig
    const dy = p.dir[1] - wig * 0.6
    const dz = p.dir[2]
    const tx = (m[0] * dx + m[1] * dy + m[2] * dz) * L
    const ty = -(m[3] * dx + m[4] * dy + m[5] * dz) * L
    const l = Math.hypot(tx, ty) || 1
    const halfW = ((s.w * L) / s.L) * 0.5
    const wx = (-ty / l) * halfW
    const wy = (tx / l) * halfW
    for (let row = 0; row <= ROWS; row++) {
      const tex = row / ROWS
      const q = (tex * s.h - s.padB) / s.L
      const tv = s.v1 + (s.v0 - s.v1) * tex
      for (let side = -1; side <= 1; side += 2) {
        v[o++] = hx + tx * q + wx * side
        v[o++] = hy + ty * q + wy * side
        v[o++] = side < 0 ? s.u0 : s.u1
        v[o++] = tv
        v[o++] = alpha
        v[o++] = 1
      }
    }
    this.nVerts += VERTS
  }

  // ---------- 风 ----------

  /** 两阵风从左往右吹过，斜着穿过草地。 */
  private updateGust(t: number) {
    const W = this.W
    const L = Math.max(170, W * 0.42)
    const span = W + this.H * 0.4 + L * 3
    this.fronts[0] = ((t * 120) % span) - L * 1.5 - this.H * 0.2
    this.fronts[1] = L
    this.fronts[2] = (((t + 6.1) * 86) % span) - L * 1.5 - this.H * 0.2
    this.fronts[3] = L * 1.3
  }

  private gustAt(x: number, y: number) {
    const X = x - (y - this.horizon) * 0.5
    const a = (X - this.fronts[0]) / this.fronts[1]
    const b = (X - this.fronts[2]) / this.fronts[3]
    const g1 = Math.exp(-a * a)
    const g2 = 0.55 * Math.exp(-b * b)
    // 两阵风相遇时不叠加：合起来最大还是 1
    return (g1 + g2 - g1 * g2) * this.wind
  }

  private readonly frame = (now: number) => {
    if (this.stopped) return
    const dt = Math.min(0.05, (now - this.last) / 1000)
    const raw = now - this.last
    this.last = now
    const t = (now - this.t0) / 1000
    this.draw(t, dt)
    this.raf = requestAnimationFrame(this.frame)
    // 开场动画之后量一下，太慢就降清晰度
    if (t > 3 && this.dpr > 1) {
      this.slowSum += raw
      if (++this.slowN >= 45) {
        if (this.slowSum / this.slowN > 26) {
          this.dpr = Math.max(1, this.dpr - 0.5)
          this.maxDpr = this.dpr
          this.resizeBuffers()
        }
        this.slowSum = 0
        this.slowN = 0
      }
    }
  }

  private drawFlower(p: FlowerPlant, t: number, grow: number, g: number) {
    const stem = p.stem
    const shear = p.flex * (0.02 + g * 0.1 + Math.sin(t * 1.3 + p.phase) * (0.012 + g * 0.018) + Math.sin(t * 2.9 + p.phase * 1.7) * 0.004)
    const h = p.h * (0.25 + 0.75 * grow)
    const k = h / stem.h
    this.emitStrip(stem, p.x, p.y, stem.w * k, h, stem.ax * k, shear, grow, 1, false)
    const bend = (q: number) => shear * h * Math.pow(q, 1.6)
    const curve = (q: number) => (stem.lean * q + stem.bow * Math.sin(Math.PI * q)) * k
    for (const l of p.leaves) {
      const q = l.t
      const flutter = Math.sin(t * 1.9 + l.phase) * (0.025 + g * 0.14) + g * 0.1
      this.emitBlade(l.s, p.x + curve(q) + bend(q), p.y - h * q, l.angle + flutter, l.len * grow, l.width, l.curl + flutter * 1.4, grow, 1)
    }
    const hx = p.x + curve(1) + bend(1)
    const hy = p.y - h
    const head = p.head
    const nod = Math.sin(t * 1.5 + head.nod)
    this.setM(head.pitch + nod * (0.015 + g * 0.05), head.yaw + g * 0.2 + shear * 0.6, head.roll + nod * (0.01 + g * 0.03))
    const hs = 0.3 + 0.7 * grow
    for (const part of head.parts) {
      if (part.kind === 0) this.emitPetal(hx, hy, hs, part, t, g, grow)
      else if (part.kind === 1) this.emitFlat(hx, hy, hs, part, t, g, grow)
      else this.emitStamen(hx, hy, hs, part, t, g, grow)
    }
  }

  private drawLily(p: LilyPlant, t: number, grow: number, g: number) {
    const shear = p.flex * (0.02 + g * 0.085 + Math.sin(t * 1.2 + p.phase) * (0.012 + g * 0.016))
    const h = p.h * (0.25 + 0.75 * grow)
    const s = p.arch.stem
    const k = h / s.h
    for (const l of p.leaves) {
      const flutter = Math.sin(t * 1.7 + l.phase) * (0.018 + g * 0.1) + g * 0.07
      this.emitBlade(l.s, p.x, p.y, l.angle + flutter, l.len * grow, l.width, l.curl + flutter, grow, 1)
    }
    this.emitStrip(s, p.x, p.y, s.w * k, h, s.ax * k, shear, grow, 1, p.mirror)
    const sign = p.mirror ? -1 : 1
    for (const b of p.bells) {
      const q = b.t
      const px = p.x + b.dx * sign * (0.25 + 0.75 * grow) + shear * h * Math.pow(q, 1.6)
      const py = p.y - h * q
      // 铃铛像钟摆：风来时一起荡，各有各的节奏
      const swing = Math.sin(t * 1.9 + b.phase) * (0.035 + g * 0.16) + g * 0.12
      this.emitSwing(b.s, px, py, swing, b.size * (0.3 + 0.7 * grow), b.side, grow)
    }
  }

  private drawTuft(p: Tuft, t: number, grow: number, g: number) {
    for (const b of p.blades) {
      const flutter = g * 0.24 + Math.sin(t * 1.7 + b.phase) * (0.025 + g * 0.07)
      this.emitBlade(b.s, p.x, p.y, b.angle + flutter * 0.45, b.len * grow, 1, b.curl + flutter, grow, 1)
    }
  }

  private draw(t: number, dt: number) {
    if (import.meta.env.DEV) (window as unknown as { __meadow?: unknown }).__meadow = this
    const gl = this.gl
    if (!gl || !this.bg || !this.scene || !this.cloudTarget) return
    const { W, H } = this
    const reveal = this.still ? 1 : smooth(-0.6, 2.2, t)
    this.wind = this.still ? 0 : smooth(1.5, 8, t)
    this.updateGust(t)

    this.fullscreen(this.programs.ground, this.scene, (u) => {
      this.bindTex(0, this.bg!.tex, u.uTex)
      gl.uniform1f(u.uHz, this.horizon / H)
      gl.uniform1f(u.uT, t)
      gl.uniform2f(u.uSize, W, H)
      gl.uniform4f(u.uGust, this.fronts[0], this.fronts[1], this.fronts[2], this.fronts[3])
      gl.uniform1f(u.uWind, this.wind)
    })

    // 云慢慢飘（贴图上下颠倒存着）
    this.nVerts = 0
    const cloud: Sprite = { canvas: null, L: 1, padB: 0, ax: 0, w: 1, h: 1, u0: 0, v0: 1, u1: 1, v1: 0 }
    const cw = Math.max(W, H) * 0.86
    const span = W + cw
    const c1 = ((t * 6 + span * 0.72) % span) - cw
    const c2 = ((t * 3.4 + span * 0.14) % span) - cw
    this.emitStrip(cloud, c2, H * 0.17, cw * 0.72, cw * 0.72 * 0.35, 0, 0, 0.6, 1, false)
    this.emitStrip(cloud, c1, H * 0.42, cw, cw * 0.35, 0, 0, 0.92, 1, false)
    const clouds = this.nVerts
    this.flushSprites(this.scene, this.cloudTarget.tex, 0, clouds)

    // 标题写在纸上，和花一起过滤镜
    if (this.titleTex) {
      const box = this.titleBox
      const paper: Sprite = { canvas: null, L: 1, padB: 0, ax: 0, w: 1, h: 1, u0: 0, v0: 0, u1: 1, v1: 1 }
      this.emitStrip(paper, box.x, box.y + box.h, box.w, box.h, 0, 0, 1, 1, false)
      this.flushSprites(this.scene, this.titleTex, clouds, this.nVerts)
    }
    const first = this.nVerts

    const limit = (MAX_SPRITES - 60) * VERTS
    for (const p of this.plants) {
      if (this.nVerts > limit) break
      const grow = this.still ? 1 : smooth(0, 1, (t - p.delay) / 1)
      if (grow <= 0) continue
      const g = this.still ? 0 : this.gustAt(p.x, p.y)
      switch (p.kind) {
        case 'flower':
          this.drawFlower(p, t, grow, g)
          break
        case 'lily':
          this.drawLily(p, t, grow, g)
          break
        case 'tuft':
          this.drawTuft(p, t, grow, g)
          break
        case 'far': {
          const shear = p.flex * (0.02 + g * 0.1 + Math.sin(t * 1.3 + p.phase) * (0.012 + g * 0.018))
          const h = p.h * (0.25 + 0.75 * grow)
          const k = h / p.stem.h
          this.emitStrip(p.stem, p.x, p.y, p.stem.w * k, h, p.stem.ax * k, shear, grow, 1, false)
          const hx = p.x + (p.stem.lean + 0) * k + shear * h
          const size = (p.R * 2 * (p.s.w / p.s.L) * (0.3 + 0.7 * grow))
          const sh = size * p.squash
          this.emitStrip(p.s, hx, p.y - h + sh / 2, size, sh, size / 2, shear * 0.2, grow, 1, false)
          break
        }
        case 'fartuft': {
          const shear = 1.4 * (0.02 + g * 0.11 + Math.sin(t * 1.4 + p.phase) * (0.012 + g * 0.022))
          const h = p.size * (0.25 + 0.75 * grow)
          const k = h / p.s.h
          this.emitStrip(p.s, p.x, p.y, p.s.w * k, h, p.s.ax * k, shear, grow, 1, false)
          break
        }
      }
    }
    // 飘动的花瓣
    const flyA = this.still ? 0.94 : smooth(0.8, 2.2, t) * 0.94
    for (const p of this.floats) {
      const g = this.gustAt(p.x, p.y)
      p.x += (p.drift + g * 60) * dt
      p.y += (p.fall + Math.sin(t * 0.9 + p.phase) * 10) * dt
      if (p.x > W + 40) p.x = -40
      if (p.y > H + 30) p.y = -20
      const flip = Math.cos(t * p.spin + p.phase)
      this.emitBlade(p.s, p.x, p.y, t * p.spin * 0.55 + p.phase, p.len, 0.3 + Math.abs(flip) * 0.7, flip * 0.5, flyA, 1)
    }
    this.flushSprites(this.scene, this.atlasTex, first, this.nVerts)

    this.fullscreen(this.programs.post, null, (u) => {
      this.bindTex(0, this.scene!.tex, u.uScene)
      this.bindTex(1, this.noiseTex, u.uN)
      gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height)
      gl.uniform1f(u.uDpr, this.dpr)
      gl.uniform1f(u.uReveal, reveal)
    })
  }

  private flushSprites(t: Target, tex: WebGLTexture, firstVert: number, endVert: number) {
    const gl = this.gl!
    const count = endVert - firstVert
    if (count <= 0) return
    this.target(t)
    gl.enable(gl.BLEND)
    const prog = this.programs.sprite
    gl.useProgram(prog.p)
    gl.uniform2f(prog.u.uSize, this.W, this.H)
    this.bindTex(0, tex, prog.u.uTex)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, firstVert * FLOATS * 4, this.verts.subarray(firstVert * FLOATS, endVert * FLOATS))
    for (let i = 0; i < 4; i++) gl.enableVertexAttribArray(i)
    const stride = FLOATS * 4
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16)
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo)
    const sprites = count / VERTS
    gl.drawElements(gl.TRIANGLES, sprites * ROWS * 6, gl.UNSIGNED_SHORT, (firstVert / VERTS) * ROWS * 6 * 2)
  }

  dispose() {
    this.stopped = true
    cancelAnimationFrame(this.raf)
    clearTimeout(this.resizeTimer)
    removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    // 进相机后不再需要：把显存和大图都还回去，相机页要用 WebGL
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
    this.gl = null
    this.atlasCanvas = null
    this.noise = null
    this.assets = null
    this.plants = []
  }
}
