// 花田引擎：一种花一次绘制（实例化），开花、生长、风、消失都在顶点着色器里算，
// 所以绘制次数不随花的数量增加，CPU 每帧只更新一个时间。
// 每朵花、每片草都记着属于哪一笔，撤销时整笔一起缩小消失，然后把位置腾出来。
// 总量超限时不会整片消失：只让多出来的那部分花陆续枯萎，优先挑不在视野里的。
import * as THREE from 'three'
import { SPECIES, SPECIES_DENSITY, SPECIES_SHARE, SPECIES_SIZE, SPECIES_VARIANTS, skyGeometry, type SkyForm, type SpeciesGeo, type SpeciesId } from './species'

const TAU = Math.PI * 2
const VARIANTS = 3 // 每种花做几个形状变体（茎高、花头倾斜不同）
const NEVER = 1e9 // 还没有消失时间
// 种花前查一下附近已经有的花：花头会撞在一起（水平离得近、高度也差不多）就不种，免得花瓣互相穿过去。
// 花头半径（米，按 1 倍大小）；铃兰的花串往一侧伸，按大一点算。
const HEAD_R: Record<SpeciesId, number> = { nemophila: 0.055, daisy: 0.064, cosmos: 0.062, golden: 0.052, hydrangea: 0.11, lily: 0.08, freesia: 0.07, tulipBlush: 0.04, ranunculus: 0.072, tulip: 0.036, rose: 0.066 }
const HEAD_CELL = 0.25 // 米：查找用的格子
const HEAD_GAP = 0.66 // 两个花头中心离得比（半径之和 × 这个）还近就算撞上
const HEAD_LAYER = 0.75 // 高度差超过（半径之和 × 这个）就是上下错开的，不算撞
const FADE = 0.45 // 单朵花消失的时长（秒），和着色器里一致
const WITHER = 3 // 超限时，这一批花在几秒内陆续枯萎
const UP = new THREE.Vector3(0, 1, 0)

const EASE = /* glsl */ `
  float easeOut(float t) { t = clamp(t, 0., 1.); return 1. - (1. - t) * (1. - t) * (1. - t); }
  float backOut(float t) { t = clamp(t, 0., 1.); float k = t - 1.; return 1. + 2.70158 * k * k * k + 1.70158 * k * k; }
`

const FLOWER_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPart;
  attribute vec4 aInst;  // 根部位置 xyz，朝向 w
  attribute vec4 aInst2; // 大小、开花时间、随机数、消失时间
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec3 uAxis;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogMax;
  varying vec3 vColor;
  varying float vFog;
  varying float vPart;
  ${EASE}
  void main() {
    float age = uTime - aInst2.y;
    float dying = clamp((uTime - aInst2.w) / ${FADE.toFixed(2)}, 0., 1.);
    if (age < 0. || dying >= 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
    vPart = step(abs(aPart - 1.), 0.5); // 1 = 花
    float grow = easeOut(age / 0.5);
    float open = backOut((age - 0.25) / 0.7);
    vec3 p = position;
    if (vPart > 0.5) {
      // 花苞：花瓣朝花头的轴收拢并翘起，开花时展开。
      vec3 d = p - uCenter;
      float h = dot(d, uAxis);
      vec3 rad = d - h * uAxis;
      float o = min(open, 1.1);
      p = uCenter + rad * mix(0.3, 1., o) + uAxis * (h + (1. - min(o, 1.)) * length(rad) * 0.85);
    }
    p *= vec3(mix(0.6, 1., grow), grow, mix(0.6, 1., grow));
    float sc = aInst2.x * (1. - dying);
    float c = cos(aInst.w);
    float s = sin(aInst.w);
    vec3 w = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c) * sc;
    vec3 n = vec3(normal.x * c + normal.z * s, normal.y, -normal.x * s + normal.z * c);
    // 风：越高摆得越多。
    float hk = p.y / 0.3;
    float phase = aInst.x * 1.1 + aInst.z * 0.9 + aInst2.z * 6.28;
    w.x += sin(uTime * 1.4 + phase) * 0.012 * hk * hk * sc;
    w.z += sin(uTime * 1.1 + phase * 1.3) * 0.009 * hk * hk * sc;
    vec4 mv = modelViewMatrix * vec4(w + aInst.xyz, 1.);
    float tone = 0.93 + 0.14 * aInst2.z;
    vColor = aColor * tone * (0.8 + 0.28 * abs(dot(n, normalize(vec3(0.35, 0.85, 0.4)))));
    vFog = clamp((length(mv.xyz) - uFogNear) / (uFogFar - uFogNear), 0., uFogMax);
    gl_Position = projectionMatrix * mv;
  }
`

const FLOWER_FRAG = /* glsl */ `
  uniform vec3 uFogColor;
  uniform vec3 uBack;
  varying vec3 vColor;
  varying float vFog;
  varying float vPart;
  void main() {
    // 背面：花按各自的颜色染（比如铃铛内壁的淡紫白），茎和叶只是略暗。
    vec3 c = gl_FrontFacing ? vColor : vColor * mix(vec3(0.92), uBack, vPart);
    gl_FragColor = vec4(mix(c, uFogColor, vFog), 1.);
  }
`

// 天空花（也用于不带茎叶、贴地的花）：可以朝任意方向，所以用四元数；几何以花头中心为原点。
const SKY_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPart;
  attribute vec4 aPos;  // 位置 xyz，大小 w
  attribute vec4 aQuat;
  attribute vec4 aLife; // 开花时间、消失时间、随机数、动作（0 不动，0.5 只漂浮，1 漂浮并慢慢翻转）
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogMax;
  varying vec3 vColor;
  varying float vFog;
  varying float vPart;
  ${EASE}
  vec3 qrot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
  vec3 turn(vec3 v, vec3 k, float a) { return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1. - cos(a)); }
  void main() {
    float age = uTime - aLife.x;
    float dying = clamp((uTime - aLife.y) / ${FADE.toFixed(2)}, 0., 1.);
    if (age < 0. || dying >= 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
    vPart = step(abs(aPart - 1.), 0.5);
    float open = backOut(age / 0.7);
    float seed = aLife.z;
    vec3 p = position;
    vec3 n = normal;
    if (vPart > 0.5) {
      float o = min(open, 1.1);
      float r = length(p.xz);
      p.xz *= mix(0.3, 1., o);
      p.y += (1. - min(o, 1.)) * r * 0.85;
    }
    float spin = step(0.75, aLife.w);
    if (spin > 0.5) {
      vec3 k = normalize(vec3(sin(seed * 12.9), cos(seed * 78.2) + 0.01, sin(seed * 37.7)));
      float a = (uTime - aLife.x) * 0.22;
      p = turn(p, k, a);
      n = turn(n, k, a);
    }
    float sc = aPos.w * (1. - dying) * min(easeOut(age / 0.35) * 0.4 + 0.6, 1.);
    vec3 w = qrot(aQuat, p) * sc + aPos.xyz;
    w.y += step(0.25, aLife.w) * sin(uTime * 1.1 + seed * 6.28) * aPos.w * 0.025;
    vec3 wn = qrot(aQuat, n);
    vec4 mv = modelViewMatrix * vec4(w, 1.);
    float tone = 0.93 + 0.14 * seed;
    vColor = aColor * tone * (0.8 + 0.28 * abs(dot(wn, normalize(vec3(0.35, 0.85, 0.4)))));
    vFog = clamp((length(mv.xyz) - uFogNear) / (uFogFar - uFogNear), 0., uFogMax);
    gl_Position = projectionMatrix * mv;
  }
`

// 天空花背后的光晕：始终朝向镜头的软光片。用普通半透明混合：叠加混合在亮背景上、花又密时会叠成一片纯白。
const GLOW_VERT = /* glsl */ `
  attribute vec4 aPos;  // 位置 xyz，大小 w
  attribute vec2 aLife; // 开花时间、消失时间
  uniform float uTime;
  varying vec2 vUv;
  varying float vA;
  ${EASE}
  void main() {
    float age = uTime - aLife.x;
    float dying = clamp((uTime - aLife.y) / ${FADE.toFixed(2)}, 0., 1.);
    if (age < 0. || dying >= 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
    float g = easeOut(age / 0.6) * (1. - dying);
    vUv = position.xz;
    vA = g;
    vec4 mv = modelViewMatrix * vec4(aPos.xyz, 1.);
    mv.xy += position.xz * aPos.w * g;
    gl_Position = projectionMatrix * mv;
  }
`
const GLOW_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vA;
  void main() {
    float d = max(0., 1. - length(vUv));
    gl_FragColor = vec4(0.84, 0.9, 1., d * d * 0.3 * vA);
  }
`

const GRASS_VERT = /* glsl */ `
  attribute vec4 aRoot;  // 根部 xyz，朝向 w
  attribute vec4 aBlade; // 高、宽、生长时间、随机数
  attribute float aDie;  // 消失时间
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogMax;
  varying vec3 vColor;
  varying float vFog;
  ${EASE}
  void main() {
    float age = uTime - aBlade.z;
    float dying = clamp((uTime - aDie) / ${FADE.toFixed(2)}, 0., 1.);
    if (age < 0. || dying >= 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
    float t = position.y;
    float h = aBlade.x * easeOut(age / 0.7) * (1. - dying);
    float bend = 0.2 + 0.5 * fract(aBlade.w * 7.31);
    float wind = sin(uTime * 1.5 + aRoot.x * 1.3 + aRoot.z * 0.9) * 0.1 + sin(uTime * 3.1 + aRoot.x * 3.7 + aBlade.w * 6.) * 0.03;
    float forward = (bend + wind) * h * t * t;
    vec3 lp = vec3(position.x * aBlade.y * (1. - t * t * 0.9), h * t * (1. - bend * t * 0.25), forward);
    float c = cos(aRoot.w);
    float s = sin(aRoot.w);
    vec3 w = vec3(lp.x * c + lp.z * s, lp.y, -lp.x * s + lp.z * c) + aRoot.xyz;
    vec4 mv = modelViewMatrix * vec4(w, 1.);
    vec3 root = vec3(0.235, 0.46, 0.2);
    vec3 tip = mix(vec3(0.52, 0.72, 0.33), vec3(0.66, 0.82, 0.42), fract(aBlade.w * 3.7));
    vColor = mix(root, tip, smoothstep(0., 0.85, t)) * (0.86 + 0.28 * aBlade.w);
    vFog = clamp((length(mv.xyz) - uFogNear) / (uFogFar - uFogNear), 0., uFogMax);
    gl_Position = projectionMatrix * mv;
  }
`

const GRASS_FRAG = /* glsl */ `
  uniform vec3 uFogColor;
  varying vec3 vColor;
  varying float vFog;
  void main() { gl_FragColor = vec4(mix(vColor, uFogColor, vFog), 1.); }
`

// 土地：相机模式下垫在花下面的一块柔边阴影。有草时是暗暗的绿色，没草时只是一点灰影——
// 花和真实地面之间要有“接触”的痕迹，不然看着像飘在空中。中间最深，往外很快淡掉，不铺满整片。
const SOIL_VERT = /* glsl */ `
  attribute vec4 aDisc; // 中心 xyz，半径 w
  attribute vec2 aLife; // 出现时间、消失时间
  uniform float uTime;
  varying vec2 vUv;
  varying float vA;
  void main() {
    float g = clamp((uTime - aLife.x) / 1.2, 0., 1.) * (1. - clamp((uTime - aLife.y) / ${FADE.toFixed(2)}, 0., 1.));
    vUv = position.xz;
    vA = g;
    vec3 w = vec3(position.x, 0., position.z) * aDisc.w * (0.4 + 0.6 * g) + aDisc.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.);
  }
`
const SOIL_FRAG = /* glsl */ `
  uniform float uGrass;
  varying vec2 vUv;
  varying float vA;
  void main() {
    float d = length(vUv);
    float fall = 1. - smoothstep(0.15, 1., d);
    vec3 c = mix(vec3(0.12, 0.13, 0.1), vec3(0.17, 0.27, 0.13), uGrass);
    gl_FragColor = vec4(c, vA * mix(0.26, 0.46, uGrass) * fall * fall);
  }
`

// 花脚下的小阴影：没草时每株花底下一小团很淡的影子，像真的长在地上（比一整片灰影自然）。
const FOOT_FRAG = /* glsl */ `
  varying vec2 vUv;
  varying float vA;
  void main() {
    float d = length(vUv);
    float fall = 1. - smoothstep(0., 1., d);
    gl_FragColor = vec4(0.07, 0.08, 0.06, vA * 0.3 * fall * fall);
  }
`

// 简单的值噪声，用来画出花的“成片”分布。
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function noise(x: number, y: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = hash(xi, yi)
  const b = hash(xi + 1, yi)
  const c = hash(xi, yi + 1)
  const d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 一组实例的缓冲。写满后从最早的开始覆盖；只上传改过的那一段，滑动时不会每次传整个缓冲。
 * strokes 记着每个槽位属于哪一笔。
 */
class Instances {
  readonly attrs: THREE.InstancedBufferAttribute[]
  readonly strokes: Int32Array
  readonly cap: number
  private cursor = 0
  private first = -1
  private wrapped = false
  count = 0

  constructor(cap: number, sizes: number[]) {
    this.cap = cap
    this.strokes = new Int32Array(cap)
    this.attrs = sizes.map((s) => new THREE.InstancedBufferAttribute(new Float32Array(cap * s), s).setUsage(THREE.DynamicDrawUsage))
  }

  next(stroke: number) {
    const i = this.cursor
    if (this.first < 0) this.first = i
    this.cursor = (this.cursor + 1) % this.cap
    if (this.cursor === 0) this.wrapped = true
    this.count = Math.min(this.cap, this.count + 1)
    this.strokes[i] = stroke
    return i
  }

  /** 把这一轮写过的范围交给 GPU；返回是否有改动 */
  flush() {
    if (this.first < 0) return false
    for (const a of this.attrs) {
      if (!this.wrapped) a.addUpdateRange(this.first * a.itemSize, (this.cursor - this.first) * a.itemSize)
      a.needsUpdate = true
    }
    this.first = -1
    this.wrapped = false
    return true
  }

  /** 给属于这些笔的实例写上消失时间（attr 第 attrIndex 个属性的第 comp 个分量）。 */
  markDying(strokes: Set<number>, attrIndex: number, comp: number, time: number) {
    const a = this.attrs[attrIndex]
    let hit = false
    for (let i = 0; i < this.count; i++) {
      if (strokes.has(this.strokes[i])) {
        ;(a.array as Float32Array)[i * a.itemSize + comp] = time
        hit = true
      }
    }
    if (hit) {
      a.clearUpdateRanges()
      a.needsUpdate = true
    }
  }

  /**
   * 从这一笔里随机挑一部分（fraction）转入“枯萎”：改记到 tomb 标签下，并写上陆续消失的时间。
   * spareNewest = true 时不动最新的那 30%（正在画的这一笔，刚开的花不会马上枯萎）。返回挑中的数量。
   */
  wither(stroke: number, fraction: number, tomb: number, attrIndex: number, comp: number, at: number, spareNewest: boolean) {
    const slots: number[] = []
    const start = this.count === this.cap ? this.cursor : 0
    for (let k = 0; k < this.count; k++) {
      const i = (start + k) % this.cap
      if (this.strokes[i] === stroke) slots.push(i)
    }
    if (!slots.length) return 0
    const pool = spareNewest ? slots.slice(0, Math.ceil(slots.length * 0.7)) : slots
    const n = Math.min(pool.length, Math.round(slots.length * fraction))
    const a = this.attrs[attrIndex]
    const arr = a.array as Float32Array
    for (let j = 0; j < n; j++) {
      const r = j + Math.floor(Math.random() * (pool.length - j))
      ;[pool[j], pool[r]] = [pool[r], pool[j]]
      const i = pool[j]
      this.strokes[i] = tomb
      arr[i * a.itemSize + comp] = at + Math.random() * WITHER
    }
    if (n) {
      a.clearUpdateRanges()
      a.needsUpdate = true
    }
    return n
  }

  /** 去掉属于这些笔的实例，其余的紧凑地排到前面（按新旧顺序）。返回是否有改动。 */
  remove(strokes: Set<number>) {
    const start = this.count === this.cap ? this.cursor : 0
    const order: number[] = []
    for (let k = 0; k < this.count; k++) {
      const i = (start + k) % this.cap
      if (!strokes.has(this.strokes[i])) order.push(i)
    }
    if (order.length === this.count) return false
    for (const a of this.attrs) {
      const s = a.itemSize
      const arr = a.array as Float32Array
      const src = arr.slice()
      order.forEach((from, to) => arr.set(src.subarray(from * s, (from + 1) * s), to * s))
      a.clearUpdateRanges()
      a.needsUpdate = true
    }
    const old = this.strokes.slice()
    order.forEach((from, to) => (this.strokes[to] = old[from]))
    this.count = order.length
    this.cursor = this.count % this.cap
    this.first = -1
    this.wrapped = false
    return true
  }

  reset() {
    this.cursor = 0
    this.count = 0
    this.first = -1
    this.wrapped = false
  }
}

interface Batch {
  mesh: THREE.Mesh
  inst: Instances
  tris: number
}

interface FlowerBatch extends Batch, SpeciesGeo {
  id: SpeciesId
}

/** 一个花头的位置和大小（用来避免花头互相穿过去） */
interface Head {
  x: number
  y: number
  z: number
  r: number
  stroke: number
}

export type Arrangement = 'mix' | 'drift'
const MIX_VARIATION = 0.25

export interface BrushSettings {
  /** 每平方米的花数、草叶数 */
  flowers: number
  grass: number
  arrangement: Arrangement
  species: SpeciesId[]
  /** 大小倍数（花和草一起缩放） */
  size: number
  /** 地面花是否带茎叶；false 时只开花朵（默认带） */
  stems?: boolean
  /** 是否铺草底下的那层底色（默认铺；远处贴着地面看会压成一条绿带） */
  soil?: boolean
}

export interface MeadowOptions {
  flowerCap?: number
  grassCap?: number
  soil?: boolean
  fog?: { near: number; far: number; max: number }
  /** 同时存在的三角形上限：超出时多出来的花陆续枯萎 */
  maxTris?: number
}

/** 天空花的造型：auto = 按花种默认（只有花，铃兰留着弧形花茎）；head = 只有花；full = 带茎叶 */
export type SkyStyle = 'auto' | 'head' | 'full'

export class Meadow {
  readonly group = new THREE.Group()
  private readonly batches: FlowerBatch[] = []
  private readonly skyBatches = new Map<string, Batch>()
  private readonly grass: Instances
  private readonly grassGeo: THREE.InstancedBufferGeometry
  private readonly grassMesh: THREE.Mesh
  private readonly soil: Instances
  private readonly soilGeo: THREE.InstancedBufferGeometry
  private soilMesh: THREE.Mesh | null = null
  private readonly feet: Instances
  private readonly feetGeo: THREE.InstancedBufferGeometry
  private feetMesh: THREE.Mesh | null = null
  private readonly soilGrass = { value: 1 }
  /** 已经种下的花头，按格子分组 */
  private readonly heads = new Map<string, Head[]>()
  private readonly glow: Instances
  private readonly glowGeo: THREE.InstancedBufferGeometry
  private readonly glowMesh: THREE.Mesh
  /** 三角形上限，可以随时调整（下调时用 trim() 让多出来的花枯萎） */
  maxTris: number
  private grassVisible = true
  private tombId = -1
  // 还在场上的每一笔用了多少、大概在哪里（Map 的顺序就是先后顺序）
  private readonly live = new Map<number, { tris: number; blades: number; x: number; y: number; z: number }>()
  private readonly viewPos = new THREE.Vector3()
  private readonly viewDir = new THREE.Vector3(0, 0, -1)
  private dying: { strokes: Set<number>; at: number }[] = []
  private readonly shared = {
    uTime: { value: 0 },
    uFogNear: { value: 7 },
    uFogFar: { value: 30 },
    uFogMax: { value: 0.75 },
    uFogColor: { value: new THREE.Color() },
  }

  constructor(fogColor: string, opts: MeadowOptions = {}) {
    const flowerCap = opts.flowerCap ?? 1500 // 每个变体的上限；6 种 × 3 变体，共 27000 朵
    const grassCap = opts.grassCap ?? 90000
    this.maxTris = opts.maxTris ?? Infinity
    if (opts.fog) {
      this.shared.uFogNear.value = opts.fog.near
      this.shared.uFogFar.value = opts.fog.far
      this.shared.uFogMax.value = opts.fog.max
    }
    // 颜色直接按 sRGB 写进着色器，不做色彩空间转换（花也是这样），所以这里按原值解析。
    this.shared.uFogColor.value.setStyle(fogColor, THREE.LinearSRGBColorSpace)

    for (const id of Object.keys(SPECIES) as SpeciesId[]) {
      for (let v = 0; v < (SPECIES_VARIANTS[id] ?? VARIANTS); v++) {
        const sp = SPECIES[id](v)
        const inst = new Instances(flowerCap, [4, 4])
        const geo = new THREE.InstancedBufferGeometry()
        geo.index = sp.geo.index
        for (const name of ['position', 'normal', 'aColor', 'aPart']) geo.setAttribute(name, sp.geo.attributes[name])
        geo.setAttribute('aInst', inst.attrs[0])
        geo.setAttribute('aInst2', inst.attrs[1])
        geo.instanceCount = 0
        const mat = new THREE.ShaderMaterial({
          vertexShader: FLOWER_VERT,
          fragmentShader: FLOWER_FRAG,
          side: THREE.DoubleSide,
          uniforms: {
            ...this.shared,
            uCenter: { value: sp.center },
            uAxis: { value: sp.axis },
            uBack: { value: new THREE.Vector3(sp.back.r, sp.back.g, sp.back.b) },
          },
        })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.frustumCulled = false
        mesh.visible = false
        this.group.add(mesh)
        this.batches.push({ ...sp, id, mesh, inst, tris: sp.geo.index!.count / 3 })
      }
    }

    // 草叶：7 个顶点、5 个三角形。x = 左右（-1…1），y = 沿叶片（0…1）。
    this.grass = new Instances(grassCap, [4, 4, 1])
    this.grassGeo = new THREE.InstancedBufferGeometry()
    this.grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, 0, 0, 1, 0, 0, -1, 0.38, 0, 1, 0.38, 0, -1, 0.72, 0, 1, 0.72, 0, 0, 1, 0], 3))
    this.grassGeo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6])
    this.grassGeo.setAttribute('aRoot', this.grass.attrs[0])
    this.grassGeo.setAttribute('aBlade', this.grass.attrs[1])
    this.grassGeo.setAttribute('aDie', this.grass.attrs[2])
    this.grassGeo.instanceCount = 0
    this.grassMesh = new THREE.Mesh(this.grassGeo, new THREE.ShaderMaterial({
      vertexShader: GRASS_VERT, fragmentShader: GRASS_FRAG, side: THREE.DoubleSide, uniforms: { ...this.shared },
    }))
    this.grassMesh.frustumCulled = false
    this.group.add(this.grassMesh)

    const quad = () => {
      const g = new THREE.InstancedBufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1], 3))
      g.setIndex([0, 2, 1, 1, 2, 3])
      g.instanceCount = 0
      return g
    }
    this.feet = new Instances(30000, [4, 2])
    this.feetGeo = quad()
    this.feetGeo.setAttribute('aDisc', this.feet.attrs[0])
    this.feetGeo.setAttribute('aLife', this.feet.attrs[1])
    if (opts.soil) {
      this.feetMesh = new THREE.Mesh(this.feetGeo, new THREE.ShaderMaterial({
        vertexShader: SOIL_VERT, fragmentShader: FOOT_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uTime: this.shared.uTime },
      }))
      this.feetMesh.frustumCulled = false
      this.feetMesh.renderOrder = -1
      this.feetMesh.visible = false
      this.group.add(this.feetMesh)
    }
    this.soil = new Instances(256, [4, 2])
    this.soilGeo = quad()
    this.soilGeo.setAttribute('aDisc', this.soil.attrs[0])
    this.soilGeo.setAttribute('aLife', this.soil.attrs[1])
    if (opts.soil) {
      this.soilMesh = new THREE.Mesh(this.soilGeo, new THREE.ShaderMaterial({
        vertexShader: SOIL_VERT, fragmentShader: SOIL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uTime: this.shared.uTime, uGrass: this.soilGrass },
      }))
      this.soilMesh.frustumCulled = false
      this.soilMesh.renderOrder = -1
      this.group.add(this.soilMesh)
    }

    this.glow = new Instances(1500, [4, 2])
    this.glowGeo = quad()
    this.glowGeo.setAttribute('aPos', this.glow.attrs[0])
    this.glowGeo.setAttribute('aLife', this.glow.attrs[1])
    this.glowMesh = new THREE.Mesh(this.glowGeo, new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: this.shared.uTime },
    }))
    this.glowMesh.frustumCulled = false
    this.glowMesh.renderOrder = 2
    this.glowMesh.visible = false
    this.group.add(this.glowMesh)
  }

  get stats() {
    let flowers = 0
    let tris = 0
    for (const b of [...this.batches, ...this.skyBatches.values()]) {
      flowers += b.inst.count
      tris += b.inst.count * b.tris
    }
    return { flowers, blades: this.grass.count, tris: tris + this.grass.count * 5 }
  }

  /** 场上还有没有花（不算正在消失的） */
  get hasFlowers() {
    return this.live.size > 0
  }

  private now() {
    return this.shared.uTime.value
  }

  private note(stroke: number, tris: number, blades: number, x: number, y: number, z: number) {
    const e = this.live.get(stroke)
    if (e) {
      e.tris += tris
      e.blades += blades
    } else {
      this.live.set(stroke, { tris, blades, x, y, z })
    }
  }

  // 选花种。drift 是同种花连成大片（像 GARDEN）；mix 是打散混种，比例按 SPECIES_SHARE。
  private pick(x: number, z: number, s: BrushSettings): SpeciesId {
    if (s.arrangement === 'drift') {
      let best = s.species[0]
      let top = -Infinity
      s.species.forEach((id, k) => {
        const score = noise(x * 0.42 + k * 37.3, z * 0.42 - k * 19.1) + Math.random() * 0.12
        if (score > top) {
          top = score
          best = id
        }
      })
      return best
    }
    // 之后还会按 SPECIES_DENSITY 随机跳过一部分，这里先除掉，最后的比例才是目标值。
    // 权重随位置轻轻起伏，留一点自然的疏密，但不会同种花扎堆。
    const weights = s.species.map((id, k) => {
      const wave = 1 + MIX_VARIATION * (2 * noise(x * 1.6 + k * 37.3, z * 1.6 - k * 19.1) - 1)
      return (SPECIES_SHARE[id] / (SPECIES_DENSITY[id] ?? 1)) * wave
    })
    let r = Math.random() * weights.reduce((a, b) => a + b, 0)
    for (let k = 0; k < weights.length; k++) {
      r -= weights[k]
      if (r <= 0) return s.species[k]
    }
    return s.species[s.species.length - 1]
  }

  private plant(x: number, z: number, scale: number, born: number, s: BrushSettings, stroke: number) {
    const id = this.pick(x, z, s)
    if (Math.random() > (SPECIES_DENSITY[id] ?? 1)) return
    if (s.stems === false) {
      // 单个铃铛认不出来，也不好看：不带茎叶时不开铃兰。
      if (id === 'lily') return
      // 不带茎叶：花朵朝上开。有草时开在草尖的高度（看不到茎），没有草时贴着地面。
      const k = scale * s.size
      const y = this.grassVisible ? (0.14 + Math.random() * 0.14) * s.size : 0.016 * k
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(Math.cos(x * 9), 0, Math.sin(x * 9)), (Math.random() * 0.6))
      this.putSky(id, 'head', x, y, z, k, q, born, 0, stroke)
      return
    }
    this.put(id, x, z, Math.random() * TAU, scale * s.size, born, -1, stroke)
  }

  private put(id: SpeciesId, x: number, z: number, yaw: number, scale: number, born: number, variant: number, stroke: number) {
    const group = this.batches.filter((b) => b.id === id)
    const b = group[variant >= 0 ? variant % group.length : Math.floor(Math.random() * group.length)]
    const k = scale * (SPECIES_SIZE[id] ?? 1)
    const head = { x: x + b.center.x * k, y: b.center.y * k, z: z + b.center.z * k, r: HEAD_R[id] * k, stroke }
    if (variant < 0 && this.crowded(head)) return
    this.addHead(head)
    const i = b.inst.next(stroke)
    b.inst.attrs[0].setXYZW(i, x, 0, z, yaw)
    b.inst.attrs[1].setXYZW(i, scale * (SPECIES_SIZE[id] ?? 1), born, Math.random(), NEVER)
    // 脚下的影子：在茎和花头投影之间，花头越大影子越大
    const f = this.feet.next(stroke)
    this.feet.attrs[0].setXYZW(f, (x + head.x) / 2, 0.0015, (z + head.z) / 2, head.r * 0.9)
    this.feet.attrs[1].setXY(f, born, NEVER)
    this.note(stroke, b.tris + 2, 0, x, 0, z)
  }

  private skyBatch(id: SpeciesId, variant: number, form: SkyForm): Batch {
    const key = `${id}:${variant}:${form}`
    let b = this.skyBatches.get(key)
    if (b) return b
    const sp = this.batches.filter((x) => x.id === id)[variant]
    const src = skyGeometry(sp, form)
    const inst = new Instances(form === 'head' ? 1000 : 300, [4, 4, 4])
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = src.index
    for (const name of ['position', 'normal', 'aColor', 'aPart']) geo.setAttribute(name, src.attributes[name])
    geo.setAttribute('aPos', inst.attrs[0])
    geo.setAttribute('aQuat', inst.attrs[1])
    geo.setAttribute('aLife', inst.attrs[2])
    geo.instanceCount = 0
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: FLOWER_FRAG,
      side: THREE.DoubleSide,
      uniforms: { ...this.shared, uBack: { value: new THREE.Vector3(sp.back.r, sp.back.g, sp.back.b) } },
    }))
    mesh.frustumCulled = false
    this.group.add(mesh)
    b = { mesh, inst, tris: src.index!.count / 3 }
    this.skyBatches.set(key, b)
    return b
  }

  private putSky(id: SpeciesId, form: SkyForm, x: number, y: number, z: number, scale: number, q: THREE.Quaternion, born: number, motion: number, stroke: number) {
    const b = this.skyBatch(id, Math.floor(Math.random() * (SPECIES_VARIANTS[id] ?? VARIANTS)), form)
    const i = b.inst.next(stroke)
    b.inst.attrs[0].setXYZW(i, x, y, z, scale * (SPECIES_SIZE[id] ?? 1))
    b.inst.attrs[1].setXYZW(i, q.x, q.y, q.z, q.w)
    b.inst.attrs[2].setXYZW(i, born, NEVER, Math.random(), motion)
    this.note(stroke, b.tris, 0, x, y, z)
  }

  private blade(x: number, z: number, heightK: number, born: number, size: number, stroke: number) {
    const i = this.grass.next(stroke)
    this.grass.attrs[0].setXYZW(i, x, 0, z, Math.random() * TAU)
    this.grass.attrs[1].setXYZW(i, (0.17 + Math.random() * 0.2) * heightK * size, (0.0035 + Math.random() * 0.003) * size, born, Math.random())
    this.grass.attrs[2].setX(i, NEVER)
    this.note(stroke, 0, 1, x, 0, z)
  }

  /** 检查造型用：在指定位置种一株指定的花（variant 选第几个形状）。 */
  specimen(id: SpeciesId, x: number, z: number, yaw: number, variant: number) {
    this.put(id, x, z, yaw, 1, this.now(), variant, 0)
    this.flush()
  }

  /** 草和土地的开关：立刻生效，已经长出来的也一起隐藏；隐藏时不占绘制。 */
  setGrassVisible(v: boolean) {
    this.grassVisible = v
    this.grassMesh.visible = v
    // 没草时不画整片的土地（灰色的一大片在真实桌面上显得假），改成每株花脚下一小团淡影
    this.soilGrass.value = v ? 1 : 0
    if (this.soilMesh) this.soilMesh.visible = v
    if (this.feetMesh) this.feetMesh.visible = !v
  }

  /**
   * 以 (cx, cz) 为中心铺开一片：像魔法一样从中心向外扩散，边缘的花更小、更稀，边界不规则。
   */
  bloomPatch(cx: number, cz: number, radius: number, s: BrushSettings, waveSpeed = 1.5, stroke = 0) {
    const t0 = this.now()
    const edge = (x: number, z: number) => {
      const dx = x - cx
      const dz = z - cz
      const d = Math.hypot(dx, dz)
      const a = Math.atan2(dz, dx)
      const wobble = 0.8 + 0.34 * noise(Math.cos(a) * 1.7 + cx, Math.sin(a) * 1.7 + cz)
      return { d, k: 1 - smooth(radius * wobble * 0.72, radius * wobble, d) }
    }
    const spacing = Math.sqrt(1 / Math.max(1, s.flowers)) * 1.07
    const row = spacing * 0.866
    for (let iz = -Math.ceil(radius / row); iz <= radius / row; iz++) {
      for (let ix = -Math.ceil(radius / spacing); ix <= radius / spacing; ix++) {
        // 随机挪动不超过间距的 0.6：两株花不会挨得太近、花头互相穿过去
        const x = cx + (ix + (iz & 1) * 0.5) * spacing + (Math.random() - 0.5) * spacing * 0.6
        const z = cz + iz * row + (Math.random() - 0.5) * row * 0.6
        const { d, k } = edge(x, z)
        if (k <= 0 || Math.random() > 0.25 + 0.75 * k) continue
        this.plant(x, z, (0.72 + Math.random() * 0.55) * (0.5 + 0.5 * k), t0 + d / waveSpeed + Math.random() * 0.35, s, stroke)
      }
    }
    const blades = Math.round(s.grass * Math.PI * radius * radius * 1.3)
    for (let i = 0; i < blades; i++) {
      const a = Math.random() * TAU
      // 草只长在花片里面，不往外铺（以前铺到花片外面，绿色一大圈）
      const r = Math.sqrt(Math.random()) * radius * 1.1
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      const { d, k } = edge(x, z)
      if (k <= 0 && Math.random() > 0.1) continue
      this.blade(x, z, 0.5 + 0.6 * k, t0 + (d / (waveSpeed * 1.2)) * 0.9 + Math.random() * 0.2, s.size, stroke)
    }
    if (s.soil !== false) this.addSoil(cx, cz, radius * 1.06, t0, stroke)
    this.finish(stroke)
  }

  /** 沿地面的一段路径铺一条花带（滑动时调用）。 */
  bloomBand(x0: number, z0: number, x1: number, z1: number, width: number, s: BrushSettings, stroke = 0) {
    const t0 = this.now()
    const len = Math.hypot(x1 - x0, z1 - z0)
    if (len < 1e-3) return
    const nx = -(z1 - z0) / len
    const nz = (x1 - x0) / len
    const n = s.flowers * len * width
    for (let i = 0; i < n; i++) {
      const t = Math.random()
      // 中间密、两边稀：两个随机数相加接近正态分布
      const o = (Math.random() + Math.random() - 1) * width
      const k = 1 - Math.abs(o) / width
      this.plant(x0 + (x1 - x0) * t + nx * o, z0 + (z1 - z0) * t + nz * o, (0.72 + Math.random() * 0.55) * (0.55 + 0.45 * k),
        t0 + Math.random() * 0.3, s, stroke)
    }
    const blades = s.grass * len * width * 1.2
    for (let i = 0; i < blades; i++) {
      const t = Math.random()
      const o = (Math.random() + Math.random() - 1) * width * 1.15
      this.blade(x0 + (x1 - x0) * t + nx * o, z0 + (z1 - z0) * t + nz * o, 0.5 + 0.6 * (1 - Math.abs(o) / (width * 1.15)), t0 + Math.random() * 0.2, s.size, stroke)
    }
    if (s.soil !== false) this.addSoil((x0 + x1) / 2, (z0 + z1) / 2, width * 1.15, t0, stroke)
    this.finish(stroke)
  }

  /**
   * 开一朵天空花：dir 是从相机指向这朵花的方向（选花种时用），toCamera 是花朝向相机的方向。
   * 返回是否开了（可能因为花种密度或总量上限被跳过）。
   */
  bloomSky(point: THREE.Vector3, toCamera: THREE.Vector3, scale: number, delay: number, s: BrushSettings, style: SkyStyle, stroke: number) {
    // 空中不开铃兰：它要靠弧形花茎才认得出来，飘在空中很奇怪。
    const species = s.species.filter((sp) => sp !== 'lily')
    if (!species.length) return false
    const id = this.pick(toCamera.x * 2.5, (toCamera.z + toCamera.y) * 2.5, { ...s, species })
    if (Math.random() > (SPECIES_DENSITY[id] ?? 1)) return false
    const k = scale * s.size
    const born = this.now() + delay
    const q = new THREE.Quaternion()
    let form: SkyForm = 'head'
    let motion = 1
    if (style === 'full') {
      // 整株要保持竖直，只朝相机倾斜一点，慢慢漂浮。
      form = 'full'
      motion = 0.5
      const side = new THREE.Vector3().crossVectors(UP, toCamera).normalize()
      q.setFromAxisAngle(side, 0.25 + Math.random() * 0.4)
      q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * TAU))
    } else {
      // 只有花朵：放出来时正脸大致朝着手机，之后慢慢翻转。
      q.setFromUnitVectors(UP, toCamera)
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.9, Math.random() * TAU, (Math.random() - 0.5) * 0.9)))
    }
    this.putSky(id, form, point.x, point.y, point.z, k, q, born, motion, stroke)
    const g = this.glow.next(stroke)
    this.glow.attrs[0].setXYZW(g, point.x, point.y, point.z, 0.14 * k)
    this.glow.attrs[1].setXY(g, born, NEVER)
    return true
  }

  /** 一批天空花写完后调用。 */
  finishSky(stroke: number) {
    this.finish(stroke)
  }

  private addSoil(x: number, z: number, r: number, t0: number, stroke: number) {
    const i = this.soil.next(stroke)
    this.soil.attrs[0].setXYZW(i, x, 0.001, z, r)
    this.soil.attrs[1].setXY(i, t0, NEVER)
  }

  private allInstances() {
    return [
      ...this.batches.map((b) => ({ inst: b.inst, geo: b.mesh.geometry as THREE.InstancedBufferGeometry, mesh: b.mesh as THREE.Mesh | null, attr: 1, comp: 3, tris: b.tris })),
      ...[...this.skyBatches.values()].map((b) => ({ inst: b.inst, geo: b.mesh.geometry as THREE.InstancedBufferGeometry, mesh: b.mesh as THREE.Mesh | null, attr: 2, comp: 1, tris: b.tris })),
      { inst: this.grass, geo: this.grassGeo, mesh: null, attr: 2, comp: 0, tris: 5 },
      { inst: this.soil, geo: this.soilGeo, mesh: null, attr: 1, comp: 1, tris: 2 },
      { inst: this.feet, geo: this.feetGeo, mesh: null, attr: 1, comp: 1, tris: 2 },
      { inst: this.glow, geo: this.glowGeo, mesh: this.glowMesh, attr: 1, comp: 1, tris: 2 },
    ]
  }

  private sync(e: ReturnType<Meadow['allInstances']>[number]) {
    e.geo.instanceCount = e.inst.count
    if (e.mesh) e.mesh.visible = e.inst.count > 0 // 没有实例的批次连状态切换都省掉
  }

  private flush() {
    for (const e of this.allInstances()) if (e.inst.flush()) this.sync(e)
  }

  private total() {
    let t = 0
    for (const v of this.live.values()) t += v.tris + (this.grassVisible ? v.blades * 5 : 0)
    return t
  }

  private finish(stroke: number) {
    this.flush()
    this.trim(stroke)
  }

  /** 相机现在的位置和朝向：超限时优先让看不见的花枯萎。 */
  setView(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.viewPos.copy(pos)
    this.viewDir.copy(dir)
  }

  // 下一批让谁枯萎：不在视野里的优先，其次最早的；正在画的这一笔排最后。
  private pickVictim(current: number | null) {
    let hidden: number | null = null
    let oldest: number | null = null
    const v = new THREE.Vector3()
    for (const [id, e] of this.live) {
      if (id === current) continue
      if (oldest == null) oldest = id
      v.set(e.x - this.viewPos.x, e.y - this.viewPos.y, e.z - this.viewPos.z)
      if (hidden == null && v.dot(this.viewDir) / (v.length() || 1) < 0.4) hidden = id
    }
    return hidden ?? oldest ?? current
  }

  /** 超过上限时，只让多出来的那部分花陆续枯萎，不会整片一起消失。 */
  trim(current: number | null = null) {
    let excess = this.total() - this.maxTris
    while (excess > 0) {
      const id = this.pickVictim(current)
      const e = id == null ? null : this.live.get(id)
      if (id == null || !e) return
      const size = e.tris + (this.grassVisible ? e.blades * 5 : 0)
      if (size <= 0) {
        this.live.delete(id)
        continue
      }
      const fraction = Math.min(1, (excess * 1.1) / size) // 多留一点余量，不用每开一朵都触发
      const removed = this.wither(id, fraction, id === current)
      if (removed <= 0) return
      excess -= removed
    }
  }

  private wither(id: number, fraction: number, spareNewest: boolean) {
    const e = this.live.get(id)!
    const at = this.now()
    const tomb = this.tombId--
    const size = () => e.tris + (this.grassVisible ? e.blades * 5 : 0)
    const before = size()
    for (const x of this.allInstances()) {
      if (x.inst === this.soil) continue
      const n = x.inst.wither(id, fraction, tomb, x.attr, x.comp, at, spareNewest)
      if (x.inst === this.grass) e.blades -= n
      else if (x.inst !== this.glow) e.tris -= n * x.tris
    }
    this.dying.push({ strokes: new Set([tomb]), at: at + WITHER })
    // 这一笔快没了：连同草地下的土地一起收掉。
    if (fraction >= 0.999 || e.tris + e.blades * 5 < 200) this.fadeOut(new Set([id]))
    return before - (this.live.has(id) ? size() : 0)
  }

  /** 附近有没有会撞上的花头 */
  private crowded(h: Head) {
    const cx = Math.floor(h.x / HEAD_CELL)
    const cz = Math.floor(h.z / HEAD_CELL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const e of this.heads.get(`${cx + dx},${cz + dz}`) ?? []) {
          const sum = h.r + e.r
          if (Math.abs(h.y - e.y) < sum * HEAD_LAYER && Math.hypot(h.x - e.x, h.z - e.z) < sum * HEAD_GAP) return true
        }
      }
    }
    return false
  }

  private addHead(h: Head) {
    const key = `${Math.floor(h.x / HEAD_CELL)},${Math.floor(h.z / HEAD_CELL)}`
    const list = this.heads.get(key)
    if (list) list.push(h)
    else this.heads.set(key, [h])
  }

  private fadeOut(strokes: Set<number>) {
    // 消失的花不再挡着新花
    for (const [key, list] of this.heads) {
      const keep = list.filter((h) => !strokes.has(h.stroke))
      if (keep.length) this.heads.set(key, keep)
      else this.heads.delete(key)
    }
    const at = this.now()
    for (const e of this.allInstances()) e.inst.markDying(strokes, e.attr, e.comp, at)
    for (const s of strokes) this.live.delete(s)
    this.dying.push({ strokes, at })
  }

  /** 撤销最近一笔。 */
  undo() {
    const keys = [...this.live.keys()]
    if (keys.length) this.fadeOut(new Set([keys[keys.length - 1]]))
  }

  /** 清空。immediate = false 时花缩小消失；true 时立刻清掉（实验页重新开花用）。 */
  clear(immediate = false) {
    if (!immediate) {
      if (this.live.size) this.fadeOut(new Set(this.live.keys()))
      return
    }
    for (const e of this.allInstances()) {
      e.inst.reset()
      this.sync(e)
    }
    this.heads.clear()
    this.live.clear()
    this.dying = []
  }

  tick(seconds: number) {
    this.shared.uTime.value = seconds
    // 消失动画结束后，把位置腾出来，这些花不再占顶点计算。
    const due = this.dying.filter((d) => seconds - d.at > FADE + 0.05)
    if (due.length) {
      this.dying = this.dying.filter((d) => seconds - d.at <= FADE + 0.05)
      const strokes = new Set(due.flatMap((d) => [...d.strokes]))
      for (const e of this.allInstances()) if (e.inst.remove(strokes)) this.sync(e)
    }
  }
}
