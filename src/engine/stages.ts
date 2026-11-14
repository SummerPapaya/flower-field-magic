import * as THREE from 'three'
import type { FlowerField } from './field'
import { GyroTracker, type Tracker } from './tracking'
import { smoothstep } from './geometry'
import type { XR8Api } from './xrEngine'
import { DIAG as DIAG_URL, diag } from '../lib/diag'

// 测试版才有的排查记录；正式构建里是常量 false，相关代码打包时去掉
const DIAG = __LAB__ && DIAG_URL

const CAMERA_HEIGHT = 1.4 // 假设手机离地 1.4 米，场景单位 = 米
// 引擎的尺度：responsive = 按假设的手机高度推算；absolute = 用运动传感器估真实的米数。
// 真机上 absolute 反复重新初始化、位置跳出几十米，所以用 responsive；测试版地址加 ?scale=absolute 可以对比。
const XR_SCALE = __LAB__ && new URLSearchParams(location.search).get('scale') === 'absolute' ? 'absolute' : 'responsive'
// 切后台期间手机转了多少，只能靠指南针（陀螺仪回来后参考方向会变，真机上前后差出一百多度）。
// 做法：切走前记下“画面朝向 + 指南针读数”（两者一个逆时针为正、一个顺时针为正，手机怎么转，和都不变）；
// 回来后等指南针读数稳定下来（刚回来那半秒的读数很乱），再算一次，差多少就把画面转回去多少。
// 以前是回来时只取半秒的读数，乱的读数一多就整组不信，转偏的 20° 没补回来。
const COMPASS_MAX_TILT_GAP = 30 // 度：切走前后手机倾斜差太多就不用（iPhone 的读数会随倾斜变）
const COMPASS_MAX_SPREAD = 12 // 度：切走前那一组读数离平均值最远不超过这么多
const COMPASS_FIX_SPREAD = 5 // 度：回来后要稳定到这个程度才用
const COMPASS_FIX_WINDOW = 0.6 // 秒
const COMPASS_FIX_WAIT = 10 // 秒：回来后最多等这么久
const COMPASS_FIX_MIN = 4 // 度：差得比这少就不转
// 切走的手势（上滑、按键）会让手机动一下：位置、朝向、指南针都取切走前这么久的
const HIDE_LOOKBACK = 0.35 // 秒
const RECENT_KEEP = 1.5 // 秒
const LONG_SIDE_FOV = (67 * Math.PI) / 180 // 主摄（1×）画面长边的视角，阶段 0 真机验证过地平线

/**
 * 陀螺仪舞台：系统相机画面 + 透明 WebGL 画布。打开就能用，但只跟踪转动：
 * 花固定在空间方向上，人走动时花会跟着走。AR 引擎下载好后换成 XrStage。
 */
export class GyroStage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400)
  private zoomRatio = 1
  private readonly canvas: HTMLCanvasElement
  private readonly video: HTMLVideoElement
  private readonly field: FlowerField
  private readonly tracker: Tracker
  /** 画了多少帧（排查用） */
  frames = 0

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, field: FlowerField, tracker: Tracker) {
    this.canvas = canvas
    this.video = video
    this.field = field
    this.tracker = tracker
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    // 花和草的颜色都直接写 sRGB 值，全程不转换。
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.camera.position.set(0, CAMERA_HEIGHT, 0)
    field.attach(this.scene, this.camera)
    this.resize()
    this.renderer.setAnimationLoop(this.frame)
  }

  /** 画布尺寸或相机画面尺寸变化时调用，让虚拟相机的视角和真实画面对齐。 */
  resize() {
    const W = this.canvas.clientWidth || 1
    const H = this.canvas.clientHeight || 1
    this.renderer.setSize(W, H, false)
    this.camera.aspect = W / H
    const vw = this.video.videoWidth || 3
    const vh = this.video.videoHeight || 4
    // 画面以 object-fit: cover 铺满屏幕：按真实镜头视角算出屏幕上的焦距，再换成竖直视角。
    const s = Math.max(W / vw, H / vh)
    const focal = (Math.max(vw, vh) / 2 / Math.tan(LONG_SIDE_FOV / 2)) * s * this.zoomRatio
    this.camera.fov = (2 * Math.atan(H / 2 / focal) * 180) / Math.PI
    this.camera.updateProjectionMatrix()
  }

  /** 拍照：把相机画面和花叠在一起，得到一张 JPEG（只在手机上，不上传）。 */
  screenshot(maxDimension = 1600, quality = 0.9): Promise<Blob | null> {
    const W = this.canvas.width
    const H = this.canvas.height
    if (!W || !H) return Promise.resolve(null)
    const k = Math.min(1, maxDimension / Math.max(W, H))
    const out = document.createElement('canvas')
    out.width = Math.round(W * k)
    out.height = Math.round(H * k)
    const ctx = out.getContext('2d')!
    // 相机画面按 object-fit: cover 铺满
    const vw = this.video.videoWidth
    const vh = this.video.videoHeight
    if (vw && vh) {
      const s = Math.max(out.width / vw, out.height / vh)
      ctx.drawImage(this.video, (out.width - vw * s) / 2, (out.height - vh * s) / 2, vw * s, vh * s)
    }
    // 画布没有保留上一帧，所以现画一帧再立刻拷贝
    this.renderer.render(this.scene, this.camera)
    ctx.drawImage(this.canvas, 0, 0, out.width, out.height)
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/jpeg', quality))
  }

  /** 相机变焦倍数（相对开始时）。 */
  setZoomRatio(r: number) {
    this.zoomRatio = r
    this.resize()
  }

  dispose() {
    this.renderer.setAnimationLoop(null)
    this.renderer.dispose()
  }

  private readonly frame = () => {
    this.frames++
    this.tracker.update(this.camera)
    this.field.tick()
    this.renderer.render(this.scene, this.camera)
  }
}

const MAX_TURN_GAP = (12 * Math.PI) / 180 // 一帧里引擎和陀螺仪转过的角度相差这么多，就是引擎跳了
// 引擎的水平朝向也会慢慢“滑”：每帧差得不多，一秒内却能差几十度。累计引擎和陀螺仪水平转角之差，超过就当跳变。
const SLIP_TAU = 0.7 // 秒
const MAX_SLIP = (8 * Math.PI) / 180
// 引擎刚启动（或卡住）时会一直给同一个位置和朝向，手机转了它也不动；这时转动交给陀螺仪，不然这段转动就丢了。
const FROZEN_AFTER = 0.25 // 秒
const FROZEN_TURN = (2 * Math.PI) / 180
const STILL_RATE = 4 // 度/秒
const STILL_ACCEL = 0.25 // 米/秒²
const STILL_AFTER = 0.35 // 持续这么多秒才算放着不动
const MOTION_STALE = 0.5 // 这么多秒没有传感器数据，就不算放着不动
const FLAT_ENTER = 25 // 度：屏幕朝上放平
const FLAT_EXIT = 32
// 平放而且完全不动 = 放在桌上，摄像头贴着桌面，引擎的位置不可信。拿在手里平着拍地面（手总会有点抖）不算，照常跟。
// 真机放在桌上：转速 0～0.4 度/秒，加速度读数却有 0.02～0.2 的噪声；手拿着不动时转速一般在 1 度/秒以上。所以主要看转速。
const REST_RATE = 0.8 // 度/秒
const REST_ACCEL = 0.25 // 米/秒²
const ACCEL_PEAK_TAU = 0.6 // 秒：走路时两步之间加速度很小，要记得住上一步
// 手机转得很快时（画面糊了），引擎算出的平移不可信：位置停住，转动交给陀螺仪
const SPIN_RATE = 120 // 度/秒
const SPIN_HOLD = 0.8 // 秒：转完以后引擎还会乱一阵，多停一会儿
// 摄像头被挡过（放在桌上）：拿起来竖好以后，引擎还要一秒左右重新定位，位置会再跳一下，这段时间也不跟
const COVERED_AFTER = 0.9 // 秒
// 引擎的位置几乎不变（摄像头被桌面挡住时它还会有一点点抖动，不是一模一样）
const QUIET_MOVE = 1e-3 // 每帧，相对引擎眼里的手机高度
// 平常拿手机的高度：手机竖着（倾斜 40° 以上）时显示高度的慢速平均。摄像头被挡过之后，拿起来就回到这个高度
const NORMAL_TILT = 40 // 度
const NORMAL_TAU = 5 // 秒
const QUIET_TURN = (0.03 * Math.PI) / 180
// 补指南针的转角时，慢慢转过去
const TURN_TAU = 0.25 // 秒
const REST_AFTER = 0.5 // 秒
const REST_MIN = 0.1 // 秒：放下超过这么久，拿起来时才等手机竖起来
const SETTLE_TILT = 50 // 度：放下后拿起来，要竖到这个角度才算拿好；拿起来的这段路不跟
const SETTLE_MAX = 1 // 秒：最多等这么久
const LAYDOWN_LOOKBACK = 2 // 秒：放下时，位置退回到手机开始往下放的地方，最多往回找这么久
const LAYDOWN_DROP = 30 // 度：倾斜减小了这么多才算是“放下去”
const LAYDOWN_NOISE = 2 // 度：倾斜读数的抖动
const WARMUP = 1 // 秒：引擎刚启动时朝向还在对准，这段时间不判断跳变
const EARLY = 4 // 秒：引擎刚启动的这几秒会重新估计手机高度，尺度估计跟得很快
const EARLY_SCALE_TAU = 0.3 // 秒
const HOLD_AFTER = 0.3 // 秒：恢复正常后多等一会儿，等引擎稳定
const BLEND_AFTER = 0.5 // 秒：恢复后这段时间慢慢把俯仰和翻滚对回引擎的结果
// 引擎的长度单位会漂：真机上开机几十秒，它算出的手机离地高度就从 1.4 涨到 20 左右，走路速度、蹲下的幅度也同比例变大。
// 所以按“引擎眼里手机离地多高”换算成米：系数 = 1.4 / 这个高度。这个高度只在可信时慢慢跟，走动时跟得快一些。
const SCALE_TAU = 40 // 秒：站着不动时跟得很慢，蹲下一会儿再站起来不会差太多
const SCALE_DIST = 0.8 // 米：走动时，每走这么远就跟上 1/e
const ENGINE_H_MIN = 0.5
const ENGINE_H_MAX = 80
const SCALE_MIN = 1.4 / ENGINE_H_MAX
const SCALE_MAX = 1.4 / ENGINE_H_MIN
// 手机离地的高度直接按引擎算：高度 = 1.4 × 引擎眼里的高度 ÷ 上面那个慢慢跟的估计。
// 蹲下、放低、站起都照实跟，而且是对称的：站起来就回到原来的高度（以前是一点点累加，往下跟了、往上没跟全，花就一直显得很近）。
// 引擎慢慢漂的部分会被尺度估计吸收。停住的时候高度也停住，恢复后 1.5 秒内接回引擎的高度。
const OFFSET_TAU = 1.5 // 秒
const RESCALE_JUMP = 1.3 // 跳变前后引擎的高度之比超过这个，就当引擎换了尺度，尺度估计跟着一起换
const HEIGHT_MIN = 0.25
const HEIGHT_MAX = 2.2
const VEL_TAU = 0.3 // 秒：平滑速度
const BOOT_TIMEOUT = 8000 // 毫秒：引擎这么久还没出第一帧，就算启动失败
const STALL_AFTER = 3000 // 毫秒：手机明明在动，引擎给的位置却一点没变，就是相机画面停住了
const STALL_RATE = 15 // 度/秒：转得比这快才算“明明在动”

// 水平朝向锁在陀螺仪上。真机数据：三分钟里“陀螺仪 + 指南针”只变 ±3°，引擎的水平转角放平或甩动时却会跳一百多度，
// 以前每次都把差值吸收进校正角，花田的朝向就一次次累计偏掉 10～20°。现在校正角一直往“陀螺仪的朝向”靠。
const YAW_TAU = 0.4 // 秒
const YAW_LOCK_MISS = 4 // 度：引擎和陀螺仪的上方向差这么多以内，才把两者的关系记下来（引擎刚启动时俯仰还没对准）
// 手机慢慢动时朝向直接用陀螺仪：真机静止时引擎的朝向偶尔会抖 1～2°，陀螺仪不会。转得快时用引擎的，它和相机画面同一时刻。
const GYRO_CALM = 25 // 度/秒
const GYRO_FAST = 70 // 度/秒
// 跳变按一小段时间算：引擎的位置不是每帧均匀更新，有时停两帧再一步走完，按单帧算会把正常移动当成跳变。
// 速度上限看手机有没有真的在加速：加速度计几乎没动静，引擎的位置却在快速变，就是引擎自己错了。
const MOVE_WINDOW = 0.12 // 秒
const MOVE_BASE = 0.8 // 米/秒
const MOVE_PER_ACCEL = 1.5 // 每 1 米/秒² 的加速度，上限放宽这么多
const MOVE_MAX = 3.7 // 米/秒
const CLIMB_BASE = 0.4 // 米/秒
const CLIMB_PER_ACCEL = 1.5
const CLIMB_MAX = 3.5 // 米/秒
const HARD_JUMP = 0.35 // 米：一帧走这么远，不用再看别的
const SPIN_HARD = 200 // 度/秒：转得这么快时引擎常常整个换尺度，停住期间高度的变化算引擎的
const RECOVER_TAU = 0.25 // 秒：放平时退回原处，慢慢退过去
// 位置的小死区：手机不动时引擎的位置也有 ±2 厘米的抖动，手轻轻晃时花也跟着晃，看起来就飘。
// 目标位置离显示位置不到半径时不动，超出时只跟超出的部分；移动快时半径缩小，不会有拖尾。差距有上限，不会累积。
const DEAD_R = 0.05 // 米
const DEAD_V0 = 0.2 // 米/秒
const DEAD_V1 = 0.6 // 米/秒
const DEAD_SPEED_TAU = 0.15 // 秒

const UP_AXIS = new THREE.Vector3(0, 1, 0)
const DEG = Math.PI / 180

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** 角度差折到 -π…π */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
/** 朝向绕竖直轴的转角（弧度） */
export const yawTwist = (q: THREE.Quaternion) => 2 * Math.atan2(q.y, q.w)

/** 排查用：跳变的种类 */
const JUMP_KINDS = ['move', 'climb', 'turn', 'slip', 'frozen', 'spin'] as const

/**
 * 位置过滤器。引擎的位置靠摄像头画面算：放在桌上时它会跳，追踪恢复后也不回到原来的位置；
 * 边走边用时，它的长度单位和高度还会漂。所以它算出的“相对运动”可以信，“跳变”和“慢漂”不能信：
 * - 正常时：每一帧把引擎的移动量换算成米（见 SCALE_*），转过水平校正角，累加到显示的位置上；
 *   高度单独处理（见 HEIGHT_*）。俯仰和翻滚始终用引擎的（它知道重力方向）。
 * - 不可信时（放在桌上、引擎在重新初始化或停住、刚出现跳变）：位置停在原处，转动交给陀螺仪（放着不动时不转），
 *   同时更新水平校正角。恢复后画面是连续的，花田留在原处，俯仰和翻滚慢慢对回引擎的结果。
 * 跳变只比较“这一帧和上一帧”的变化，不和显示的结果比，所以不会因为一次误判一直锁住；刚启动的一秒不判断。
 */
export class PoseFilter {
  /** 显示的位置（目标位置过了死区之后） */
  readonly pos = new THREE.Vector3()
  /** 目标位置：累加引擎的移动量得到 */
  private readonly tgt = new THREE.Vector3()
  private readonly smoothTgt = new THREE.Vector3()
  readonly quat = new THREE.Quaternion()
  private offYaw = 0
  /** 显示的水平朝向 - 陀螺仪的水平朝向；记下来以后，朝向就一直锁在陀螺仪上 */
  private gyroC = 0
  private yawLocked = false
  private readonly gyroDisp = new THREE.Quaternion()
  private readonly upA = new THREE.Vector3()
  private readonly upB = new THREE.Vector3()
  /** 最近一小段时间每帧的移动量（米），判断跳变用 */
  private readonly moves: { t: number; dt: number; x: number; y: number; z: number }[] = []
  /** 还没退完的位移（米，显示坐标） */
  private readonly catchUp = new THREE.Vector3()
  private readonly tmpV = new THREE.Vector3()
  private readonly offQuat = new THREE.Quaternion()
  private readonly rawPos = new THREE.Vector3()
  private readonly rawQuat = new THREE.Quaternion()
  private readonly lastGyro = new THREE.Quaternion()
  private readonly turnRaw = new THREE.Quaternion()
  private readonly turnGyro = new THREE.Quaternion()
  private readonly step = new THREE.Vector3()
  private readonly candQuat = new THREE.Quaternion()
  private readonly tmp = new THREE.Quaternion()
  private hasPose = false
  private hasGyro = false
  private anchor: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null
  private start = 0
  private last = 0
  private quietSince = -1
  private lyingSince = -1
  /** 手机是否完全不动（放在桌上那种） */
  lying = false
  /** 最近的加速度峰值（慢慢衰减）、这一刻的转速和加速度（排查用） */
  private accelPeak = 0
  rateNow = 0
  accelNow = 0
  /** 引擎是否“停住”：位置和朝向一点没变（摄像头被挡住、刚启动还没开始追踪） */
  stale = false
  /** 摄像头是否像被挡住了：平放着，而且引擎的位置几乎不动 */
  covered = false
  /** 平常拿手机的高度（显示的，米） */
  private normalH = CAMERA_HEIGHT
  private poseQuietSince = -1
  /** 还没转完的水平校正角（切 App 回来后按指南针补） */
  private pendingYaw = 0
  private lastMotion = 0
  private holdUntil = 0
  private blendUntil = 0
  /** 放在桌上：开始和结束的时间，放得够不够久 */
  private resting = false
  private restStart = 0
  private restEnd = -Infinity
  private restLong = false
  /** 引擎和陀螺仪水平转角之差（累计，会慢慢衰减） */
  private slip = 0
  /** 引擎的位置最后一次变化的时间，以及那时显示的朝向和陀螺仪的朝向 */
  private poseSince = 0
  private readonly freezeQuat = new THREE.Quaternion()
  private readonly freezeGyro = new THREE.Quaternion()
  private freezeHasGyro = false
  private frozen = false
  /** 最近一点时间里显示的位置和倾斜，放下时用来退回去 */
  private readonly trail: { t: number; x: number; z: number; h: number; tilt: number }[] = []
  /** 引擎眼里手机离地多高（引擎的单位），慢慢跟 */
  private engineH = CAMERA_HEIGHT
  /** 显示的高度和按引擎算出的高度之差：停住时用来保持画面连续，之后慢慢归零 */
  private offY = 0
  /** 这一段停住开始时引擎的高度、尺度估计，以及停住的原因 */
  private wasHolding = false
  private holdY0 = 0
  private holdH0 = 0
  private holdRest = false
  private holdCovered = false
  private holdFlat = false
  /** 这一段停住里有没有真正的跳变（位置或高度一帧里突然变很多） */
  private holdJump = false
  private holdInit = false
  /** 平滑后的引擎位置（去掉抖动，用来算走了多远）和水平速度（米/秒） */
  private readonly smoothRaw = new THREE.Vector3()
  private readonly smoothPrev = new THREE.Vector3()
  private speed = 0
  /** 这一帧是否停着没跟引擎（排查用） */
  holding = false
  /** 手机现在是否放着不动 */
  still = false
  /** 桌面模式：手机只在桌子上方小范围移动，没有人走路，手的移动不该让尺度估计跟着变 */
  desk = false
  /** 手机是否屏幕朝上放平 */
  flat = false
  /** 手机屏幕和水平面的夹角（度）：0 = 平放，90 = 竖着 */
  tilt = 90
  /** 引擎是否报告追踪受限（只用于排查：引擎经常报受限，但相对运动依然可用） */
  limited = false
  /** 引擎是否在重新初始化：这时它的位置和尺度都会换，不能跟 */
  initializing = false
  /** 排查用：吸收过多少次跳变，以及各种类的次数（见 JUMP_KINDS） */
  jumps = 0
  readonly jumpKinds = JUMP_KINDS.map(() => 0)

  /** 传感器数据：转速（度/秒）和去掉重力后的加速度（米/秒²）。now 是秒。 */
  motion(rate: number, accel: number, now: number) {
    this.accelPeak = Math.max(accel, this.accelPeak * Math.exp(-Math.max(0, now - this.lastMotion) / ACCEL_PEAK_TAU))
    this.rateNow = rate
    this.accelNow = accel
    this.lastMotion = now
    if (rate < STILL_RATE && accel < STILL_ACCEL) {
      if (this.quietSince < 0) this.quietSince = now
      this.still = now - this.quietSince >= STILL_AFTER
    } else {
      this.quietSince = -1
      this.still = false
    }
    if (rate < REST_RATE && accel < REST_ACCEL) {
      if (this.lyingSince < 0) this.lyingSince = now
      this.lying = now - this.lyingSince >= REST_AFTER
    } else {
      this.lyingSince = -1
      this.lying = false
    }
  }

  /** 手机的倾斜（度）。 */
  orientation(beta: number, gamma: number) {
    const limit = this.flat ? FLAT_EXIT : FLAT_ENTER
    this.flat = Math.abs(beta) < limit && Math.abs(gamma) < limit
    // 屏幕法线和竖直方向的夹角
    this.tilt = Math.acos(clamp(Math.cos(beta * DEG) * Math.cos(gamma * DEG), -1, 1)) / DEG
  }

  /**
   * 引擎（重新）启动时调用。anchor = 切后台前看到的位置和朝向：新的追踪世界的第一帧对齐到它，
   * 不管引擎自己把原点放在哪里，花田都接得上。
   */
  reset(anchor: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null) {
    this.anchor = anchor
    this.hasPose = false
    this.hasGyro = false
    this.offYaw = 0
    this.offQuat.identity()
    this.gyroC = 0
    this.yawLocked = false
    this.moves.length = 0
    this.catchUp.set(0, 0, 0)
    this.holdUntil = 0
    this.blendUntil = 0
    this.resting = false
    this.restEnd = -Infinity
    this.restLong = false
    this.stale = false
    this.pendingYaw = 0
    this.slip = 0
    this.frozen = false
    this.freezeHasGyro = false
    this.trail.length = 0
    this.speed = 0
    this.offY = 0
    this.wasHolding = false
    this.limited = false
    this.initializing = false
  }

  /** 引擎的单位换算成米的系数 */
  get scale() {
    return clamp(CAMERA_HEIGHT / this.engineH, SCALE_MIN, SCALE_MAX)
  }

  /** 排查用：现在的校正量 */
  get offset() {
    return [this.offYaw, this.scale, this.engineH, this.pos.y, this.speed, this.gyroC, this.yawLocked ? 1 : 0].map((v) => Math.round(v * 1000) / 1000)
  }

  /** 每帧在引擎更新相机之后调用，把结果写回相机。gyro 是陀螺仪给的朝向（没有时为 null），now 是秒。 */
  apply(camera: THREE.Object3D, gyro: THREE.Quaternion | null, now: number) {
    const p = camera.position
    const q = camera.quaternion
    if (!this.hasPose) {
      this.hasPose = true
      this.start = now
      this.last = now
      this.engineH = clamp(p.y, ENGINE_H_MIN, ENGINE_H_MAX)
      // 先记下引擎的原始位置和朝向：p、q 就是相机本身，下面写回显示的结果后就变了。
      // （以前在写回之后才记，切回来时下一帧会把“显示位置和引擎位置之差”当成一步移动，花田整片被挪开几米。）
      this.rawPos.copy(p)
      this.rawQuat.copy(q)
      this.poseQuietSince = now
      if (this.anchor) {
        // 水平转角和位置接到切走前，俯仰和翻滚用引擎的
        this.tmp.copy(q).invert().premultiply(this.anchor.quat)
        this.offYaw = yawTwist(this.tmp)
        this.offQuat.setFromAxisAngle(UP_AXIS, this.offYaw)
        this.tgt.copy(this.anchor.pos)
        this.anchor = null
      } else {
        this.tgt.copy(p)
      }
      this.tgt.y = clamp(this.tgt.y, HEIGHT_MIN, HEIGHT_MAX)
      this.offY = this.tgt.y - (CAMERA_HEIGHT * p.y) / this.engineH
      this.pos.copy(this.tgt)
      this.smoothTgt.copy(this.tgt)
      this.smoothRaw.copy(p)
      this.quat.copy(this.offQuat).multiply(q)
      camera.position.copy(this.pos)
      camera.quaternion.copy(this.quat)
      this.poseSince = now
      this.freezeQuat.copy(this.quat)
      this.hasGyro = this.freezeHasGyro = !!gyro
      if (gyro) {
        this.lastGyro.copy(gyro)
        this.freezeGyro.copy(gyro)
      }
      return
    }
    const dt = Math.min(0.1, Math.max(0.001, now - this.last))
    this.last = now
    const warm = now - this.start > WARMUP
    // 传感器没有新数据时不能继续算放着不动，否则画面会一直卡住
    if (now - this.lastMotion > MOTION_STALE) this.still = this.lying = false

    // 这一帧引擎自己转了多少、陀螺仪转了多少（都在相机自己的坐标里）
    this.turnRaw.copy(this.rawQuat).invert().multiply(q)
    let gyroTurn = false
    let slipped = false
    if (gyro && this.hasGyro) {
      this.turnGyro.copy(this.lastGyro).invert().multiply(gyro)
      gyroTurn = true
      // 水平转角：引擎和陀螺仪各自转了多少，差值累计起来
      const gap = wrap(yawTwist(q) - yawTwist(this.rawQuat)) - wrap(yawTwist(gyro) - yawTwist(this.lastGyro))
      this.slip = this.slip * Math.exp(-dt / SLIP_TAU) + gap
      if (Math.abs(this.slip) > MAX_SLIP) {
        slipped = true
        this.slip = 0
      }
    }
    // 引擎是不是停住了：位置和朝向一点没变，陀螺仪却转了
    const same = p.equals(this.rawPos) && q.equals(this.rawQuat)
    let snapped = false
    const frozen =
      same && !!gyro && this.freezeHasGyro && now - this.poseSince > FROZEN_AFTER &&
      angleOf(this.tmp.copy(this.freezeGyro).invert().multiply(gyro)) > FROZEN_TURN
    if (frozen && !this.frozen) {
      // 引擎停住以后手机转过的角度补回来
      this.quat.copy(this.freezeQuat).multiply(this.tmp.copy(this.freezeGyro).invert().multiply(gyro))
      snapped = true
      this.jumpKinds[4]++
    }
    this.frozen = frozen

    // 这一帧引擎移动了多少，换算成米
    const k = this.scale
    const prevY = this.rawPos.y
    this.step.copy(p).sub(this.rawPos).multiplyScalar(k)
    // 引擎的位置几乎不动的时间
    if (p.distanceTo(this.rawPos) > QUIET_MOVE * this.engineH || angleOf(this.turnRaw) > QUIET_TURN) this.poseQuietSince = now
    // 最近一小段时间的平均速度
    const moves = this.moves
    moves.push({ t: now, dt, x: this.step.x, y: this.step.y, z: this.step.z })
    while (moves.length > 1 && now - moves[0].t > MOVE_WINDOW) moves.shift()
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    let span = 0
    for (const m of moves) {
      sumX += m.x
      sumY += m.y
      sumZ += m.z
      span += m.dt
    }
    const kinds = [
      this.step.length() > HARD_JUMP || Math.hypot(sumX, sumZ) / span > Math.min(MOVE_MAX, MOVE_BASE + MOVE_PER_ACCEL * this.accelPeak),
      Math.abs(sumY) / span > Math.min(CLIMB_MAX, CLIMB_BASE + CLIMB_PER_ACCEL * this.accelPeak),
      gyroTurn && Math.abs(angleOf(this.turnRaw) - angleOf(this.turnGyro)) > MAX_TURN_GAP,
      slipped,
    ]
    const jumped = warm && kinds.some(Boolean)
    if (jumped) moves.length = 0
    this.rawPos.copy(p)
    this.rawQuat.copy(q)
    if (gyro) {
      this.lastGyro.copy(gyro)
      this.hasGyro = true
    }
    if (jumped) {
      this.jumps++
      kinds.forEach((hit, i) => hit && this.jumpKinds[i]++)
      this.holdUntil = now + HOLD_AFTER
    }
    if (warm && this.rateNow > SPIN_RATE) {
      if (now >= this.holdUntil) this.jumpKinds[5]++
      this.holdUntil = Math.max(this.holdUntil, now + SPIN_HOLD)
    }
    // 引擎停住（位置一点没变）：摄像头被桌面挡住了，或者刚启动还没开始追踪。这时它给的高度不能用来估尺度。
    const stale = same && now - this.poseSince > FROZEN_AFTER
    this.stale = stale

    // 放在桌上：平放而且完全不动，或者引擎停住了。刚放下时退回到放下之前；放得够久的话，拿起来时等手机竖起来再跟。
    // 摄像头被挡住（平放在桌上）：引擎报告追踪受限，或者位置几乎不动。之后它的高度常常整体偏一截，不能照用
    const covered = this.flat && now - this.poseQuietSince > FROZEN_AFTER
    this.covered = covered
    // 手机平放（在桌上或拿在手里低头看）时引擎最不可靠：真机上它的水平转角会滑一百多度，位置也跟着滑。
    // 所以平放这一段位置停住，放下去的那段退回去，抬起来的那段不跟，一来一回花田留在原处。
    const resting = this.flat || stale || covered
    if (resting && !this.resting) {
      this.restStart = now
      if (warm) this.rewindLaydown(now)
    }
    if (resting && now - this.restStart >= REST_MIN) this.restLong = true
    if (!resting && this.resting) this.restEnd = now
    this.resting = resting
    if (!resting && this.restLong && (now - this.restEnd >= SETTLE_MAX || this.tilt >= SETTLE_TILT)) {
      this.restLong = false
      if (this.holdCovered) this.holdUntil = Math.max(this.holdUntil, now + COVERED_AFTER)
    }
    const settling = !resting && this.restLong
    if (warm && (resting || settling || this.initializing)) this.holdUntil = Math.max(this.holdUntil, now + HOLD_AFTER)

    // 走了多远：用平滑后的引擎位置算，手机的抖动不算（以前抖动也算进去，尺度估计跟得太快，蹲下的幅度被吃掉）
    const ease = 1 - Math.exp(-dt / VEL_TAU)
    this.smoothPrev.copy(this.smoothRaw)
    this.smoothRaw.lerp(p, ease)
    const walked = Math.min(0.2, Math.hypot(this.smoothRaw.x - this.smoothPrev.x, this.smoothRaw.z - this.smoothPrev.z) * k)
    this.speed += (walked / dt - this.speed) * ease

    this.holding = now < this.holdUntil
    if (this.holding && !this.wasHolding) {
      this.holdY0 = prevY
      this.holdH0 = this.engineH
      this.holdRest = this.holdInit = this.holdCovered = this.holdFlat = this.holdJump = false
    }
    if (this.holding) {
      if ((jumped && (kinds[0] || kinds[1])) || this.rateNow >= SPIN_HARD) this.holdJump = true
      if (resting || settling) this.holdRest = true
      if (covered || stale) this.holdCovered = true
      if (this.flat) this.holdFlat = true
      if (this.initializing) this.holdInit = true
    }

    // 引擎的尺度：只要引擎在正常追踪就慢慢跟（跳变时也跟，否则尺度一错就一直被当成跳变），走动时跟得快，刚启动时跟得最快
    if (!resting && !settling && !this.initializing && !frozen && !stale && p.y > 0.2) {
      const early = now - this.start < EARLY
      // 走动的那部分只在手机拿在平常高度时算：放低、举高时手机也会前后移，那不是走路，不该让尺度估计跟着变
      const ratio = p.y / this.engineH - 1
      const walking = this.desk ? 0 : walked * Math.exp(-((ratio / 0.35) ** 2))
      const a = 1 - Math.exp(-(dt / (early ? EARLY_SCALE_TAU : SCALE_TAU) + walking / SCALE_DIST))
      this.engineH += (clamp(p.y, ENGINE_H_MIN, ENGINE_H_MAX) - this.engineH) * a
    }

    if (this.holding) {
      // 不可信：位置停住；放着不动时转动也停住，否则转动交给陀螺仪（引擎这时的朝向会漂）。
      if (!this.still && !snapped) this.quat.multiply(gyroTurn ? this.turnGyro : this.turnRaw)
      // 把引擎这段时间的转角偏差算进水平校正角
      this.tmp.copy(q).invert().premultiply(this.quat)
      this.offYaw = yawTwist(this.tmp)
      this.offQuat.setFromAxisAngle(UP_AXIS, this.offYaw)
      this.blendUntil = now + BLEND_AFTER
    } else {
      if (this.wasHolding) {
        // 刚恢复：引擎的高度在停住前后差很多，说明它换了尺度（或重新初始化了），尺度估计按同样的比例换
        const f = this.holdY0 > 0.2 && p.y > 0.2 ? p.y / this.holdY0 : 1
        // 只有引擎真的跳了（或重新初始化），才当它换了尺度。快速转动、拿起手机这些停住期间，手机本来就可能真的升降了，
        // 以前也按比例换尺度，结果尺度越换越小（真机上从 1.0 掉到 0.5），之后移动手机花只跟着动一半，像在漂
        if (!this.holdRest && (this.holdInit || (this.holdJump && (f > RESCALE_JUMP || f < 1 / RESCALE_JUMP)))) {
          this.engineH = clamp(this.holdH0 * (this.holdInit ? f : clamp(f, 1 / 3, 3)), ENGINE_H_MIN, ENGINE_H_MAX)
        } else if ((this.holdCovered || this.holdFlat) && p.y > 0.2) {
          // 摄像头被挡过：引擎恢复后的高度常常整体偏一截（真机上从 1.4 米变成 0.77 米）。
          // 拿起来的手机一般回到平常的高度，所以按平常的高度重新对尺度
          const want = (CAMERA_HEIGHT * p.y) / this.normalH
          this.engineH = clamp(clamp(want, this.holdH0 / 3, this.holdH0 * 3), ENGINE_H_MIN, ENGINE_H_MAX)
        }
        // 画面接上停住时的高度，之后慢慢接回引擎的高度
        this.offY = this.tgt.y - (CAMERA_HEIGHT * p.y) / this.engineH
      }
      // 水平校正角往陀螺仪靠（第一次先记下两者的关系）
      if (gyro && warm && !this.yawLocked) {
        // 只比倾斜的大小：两者的水平转角本来就差着一个常数，上方向的朝向也跟着差
        const tiltGap = Math.acos(clamp(this.upA.copy(UP_AXIS).applyQuaternion(q).y, -1, 1)) - Math.acos(clamp(this.upB.copy(UP_AXIS).applyQuaternion(gyro).y, -1, 1))
        if (Math.abs(tiltGap) < YAW_LOCK_MISS * DEG) {
          this.gyroC = wrap(this.offYaw - yawTwist(this.tmp.copy(q).invert().premultiply(gyro)))
          this.yawLocked = true
        }
      }
      if (gyro && this.yawLocked) {
        const gap = wrap(this.gyroC + yawTwist(this.tmp.copy(q).invert().premultiply(gyro)) - this.offYaw)
        this.offYaw = wrap(this.offYaw + gap * (1 - Math.exp(-dt / YAW_TAU)))
        this.offQuat.setFromAxisAngle(UP_AXIS, this.offYaw)
      }
      this.step.applyQuaternion(this.offQuat)
      this.tgt.x += this.step.x
      this.tgt.z += this.step.z
      this.offY *= Math.exp(-dt / OFFSET_TAU)
      this.tgt.y = clamp((CAMERA_HEIGHT * p.y) / this.engineH + this.offY, HEIGHT_MIN, HEIGHT_MAX)
      if (this.tilt >= NORMAL_TILT && warm) this.normalH += (this.tgt.y - this.normalH) * (1 - Math.exp(-dt / NORMAL_TAU))
      this.candQuat.copy(this.offQuat).multiply(q)
      if (now < this.blendUntil) this.quat.slerp(this.candQuat, 0.2)
      else this.quat.copy(this.candQuat)
      // 手机慢慢动时朝向直接用陀螺仪
      if (gyro && this.yawLocked && warm && now - this.lastMotion <= MOTION_STALE) {
        const w = 1 - smoothstep(GYRO_CALM, GYRO_FAST, this.rateNow)
        if (w > 0) this.quat.slerp(this.gyroDisp.setFromAxisAngle(UP_AXIS, this.gyroC).multiply(gyro), w)
      }
    }
    // 要补的位移慢慢补上（高度只有停住时才归这里管，平时直接按引擎算）
    if (this.catchUp.lengthSq() > 1e-8) {
      this.tmpV.copy(this.catchUp).multiplyScalar(1 - Math.exp(-dt / RECOVER_TAU))
      this.tgt.x += this.tmpV.x
      this.tgt.z += this.tmpV.z
      if (this.holding) this.tgt.y += this.tmpV.y
      this.catchUp.sub(this.tmpV)
    }
    // 按指南针补的水平转角：绕着手机所在的竖直轴慢慢转过去
    if (this.pendingYaw !== 0) {
      const turn = Math.abs(this.pendingYaw) < 0.002 ? this.pendingYaw : this.pendingYaw * (1 - Math.exp(-dt / TURN_TAU))
      this.pendingYaw -= turn
      this.offYaw += turn
      if (this.yawLocked) this.gyroC = wrap(this.gyroC + turn)
      this.offQuat.setFromAxisAngle(UP_AXIS, this.offYaw)
      this.quat.premultiply(this.tmp.setFromAxisAngle(UP_AXIS, turn))
    }
    this.wasHolding = this.holding
    this.follow(dt)
    camera.position.copy(this.pos)
    camera.quaternion.copy(this.quat)
    if (!same) {
      this.poseSince = now
      this.freezeQuat.copy(this.quat)
      this.freezeHasGyro = !!gyro
      if (gyro) this.freezeGyro.copy(gyro)
    }
    const trail = this.trail
    while (trail.length && now - trail[0].t > LAYDOWN_LOOKBACK) trail.shift()
    trail.push({ t: now, x: this.tgt.x, z: this.tgt.z, h: this.tgt.y, tilt: this.tilt })
  }

  /** 让画面绕竖直轴再转 delta 弧度（向左为正），几帧内转完。 */
  turnWorld(delta: number) {
    this.pendingYaw += delta
  }

  /**
   * 刚放到桌上：放下去的那段移动（手机往下、往前）已经跟上了，拿起来那段却不跟，
   * 回到原来的角度后花田就偏了。所以退回到手机开始往下放的地方：最近一段时间里手机竖得最高的最后一刻。
   * 如果这段时间里倾斜没怎么变（本来就平着拿），就不退。
   */
  private rewindLaydown(now: number) {
    const trail = this.trail.filter((e) => now - e.t <= LAYDOWN_LOOKBACK)
    if (!trail.length) return
    const top = Math.max(...trail.map((e) => e.tilt))
    if (top - this.tilt < LAYDOWN_DROP) return
    let at = trail[0]
    for (const e of trail) if (e.tilt >= top - LAYDOWN_NOISE) at = e
    // 手里拿着放平时画面看得见，慢慢退回去，不要一下跳过去
    this.catchUp.set(at.x - this.tgt.x, at.h - this.tgt.y, at.z - this.tgt.z)
  }

  /** 目标位置过死区，得到显示的位置。 */
  private follow(dt: number) {
    this.smoothTgt.lerp(this.tgt, 1 - Math.exp(-dt / DEAD_SPEED_TAU))
    const v = this.smoothTgt.distanceTo(this.tgt) / DEAD_SPEED_TAU
    const r = DEAD_R * (1 - smoothstep(DEAD_V0, DEAD_V1, v))
    const gap = this.tgt.distanceTo(this.pos)
    if (gap > r) this.pos.lerp(this.tgt, 1 - r / gap)
  }
}

/** 一个转动的角度（弧度，0…π） */
function angleOf(q: THREE.Quaternion) {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)))
}

const FORWARD = new THREE.Vector3()
/** 相机朝向的俯仰角（弧度，向上为正） */
function pitchOf(q: THREE.Quaternion) {
  return Math.asin(clamp(FORWARD.set(0, 0, -1).applyQuaternion(q).y, -1, 1))
}

/** 两级平滑（一阶低通，时间常数 tau 秒）再减掉慢变化，只留下走路时一步一步的晃动。 */
class Band {
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly slow = new THREE.Vector3()
  readonly out = new THREE.Vector3()
  private primed = false
  push(v: THREE.Vector3, dt: number) {
    if (!this.primed) {
      this.a.copy(v)
      this.b.copy(v)
      this.slow.copy(v)
      this.primed = true
    }
    const fast = 1 - Math.exp(-dt / 0.06)
    this.a.lerp(v, fast)
    this.b.lerp(this.a, fast)
    this.slow.lerp(this.b, 1 - Math.exp(-dt / 0.3))
    return this.out.copy(this.b).sub(this.slow)
  }
}

/**
 * 排查用：比较引擎算出的加速度和加速度计读数（同样的滤波），估计引擎的一个单位相当于几米。
 * 只有走动时晃动够大才有意义。take() 返回 [引擎的晃动, 加速度计的晃动]，两者之比 = 每米多少个引擎单位。
 */
class ScaleProbe {
  private readonly last = new THREE.Vector3()
  private readonly vel = new THREE.Vector3()
  private readonly lastVel = new THREE.Vector3()
  private readonly acc = new THREE.Vector3()
  private readonly dev = new THREE.Vector3()
  private readonly velBand = new Band()
  private readonly devBand = new Band()
  private engineAt = -1
  private deviceAt = -1
  private sumE = 0
  private nE = 0
  private sumD = 0
  private nD = 0

  engine(p: THREE.Vector3, now: number) {
    const dt = now - this.engineAt
    this.engineAt = now
    if (dt <= 0 || dt > 0.2) {
      this.last.copy(p)
      return
    }
    this.vel.copy(p).sub(this.last).divideScalar(dt)
    this.last.copy(p)
    // 先平滑速度，再求加速度，最后只留晃动
    const v = this.velBand.push(this.vel, dt)
    this.acc.copy(v).sub(this.lastVel).divideScalar(dt)
    this.lastVel.copy(v)
    this.sumE += this.acc.lengthSq()
    this.nE++
  }

  device(x: number, y: number, z: number, now: number) {
    const dt = now - this.deviceAt
    this.deviceAt = now
    if (dt <= 0 || dt > 0.2) return
    const a = this.devBand.push(this.dev.set(x, y, z), dt)
    this.sumD += a.lengthSq()
    this.nD++
  }

  take() {
    const r = [this.nE ? Math.sqrt(this.sumE / this.nE) : 0, this.nD ? Math.sqrt(this.sumD / this.nD) : 0].map((v) => Math.round(v * 100) / 100)
    this.sumE = this.nE = this.sumD = this.nD = 0
    return r
  }
}

export interface XrCallbacks {
  /** 第一帧 AR 画面出来了：可以把陀螺仪舞台收掉。resumed = 这是切后台回来后的重启 */
  onReady: (resumed: boolean) => void
  /** 启动失败、运行出错或相机画面停住 */
  onFail: (reason: string) => void
  /** 追踪状态：false = 还没认出地面 */
  onTracking: (ok: boolean) => void
  /** 切后台回来，正在重新启动 */
  onResuming: () => void
}

/** 手机当前的位置和朝向，用来在引擎重启时把花田接上。 */
interface Pose {
  x: number
  y: number
  z: number
  yaw: number
  /** 指南针读数（度）；切后台期间手机转了多少靠它补 */
  heading: number | null
}

/** 水平朝向（绕 Y 轴的转角）。 */
function yawOf(camera: THREE.Camera) {
  return yawOfQuat(camera.getWorldQuaternion(new THREE.Quaternion()))
}

function yawOfQuat(q: THREE.Quaternion) {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  // 低头时前方的水平分量很小，加上“手机顶部”的方向才算得稳；抬头时顶部朝后，就不加了。
  if (dir.y < 0) dir.add(new THREE.Vector3(0, 1, 0).applyQuaternion(q))
  return Math.atan2(-dir.x, -dir.z)
}

const CIRCLE = 360
/** 几个指南针读数的平均（度），要考虑 359° 和 1° 其实很近。 */
function meanHeading(list: number[]) {
  let x = 0
  let y = 0
  for (const h of list) {
    x += Math.cos((h * Math.PI) / 180)
    y += Math.sin((h * Math.PI) / 180)
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + CIRCLE) % CIRCLE
}

/** 一组指南针读数离平均值最远多少度（读数稳不稳） */
function headingSpread(list: number[], mean: number) {
  return list.reduce((m, h) => Math.max(m, Math.abs(((h - mean + 540) % 360) - 180)), 0)
}

/**
 * AR 舞台：8th Wall 世界追踪，花真正固定在地上，可以绕着走。
 * 引擎自己开相机、自己画相机画面。为了衔接自然，它先在隐藏的画布上启动，第一帧出来后才接手花田。
 *
 * 切到别的 App 时相机会被系统收回，引擎的 pause/resume 恢复不了（画面不再刷新、追踪跑飞），
 * 所以切后台时直接停掉并记下位置，回来后在新画布上重启，让新的追踪世界对齐到记下的位置。
 */
export class XrStage {
  renderer: THREE.WebGLRenderer | null = null
  private readonly XR8: XR8Api
  private readonly host: HTMLElement
  private readonly field: FlowerField
  private readonly cb: XrCallbacks
  private readonly filter = new PoseFilter()
  private readonly probe = new ScaleProbe()
  /** 排查用：每 0.1 秒一行的轨迹 */
  private trace: number[][] = []
  private traceAt = 0
  /** 排查用：切后台前陀螺仪的水平转角，回来后和新读数比，看陀螺仪的参考方向会不会变 */
  private hideGyroYaw: number | null = null
  private gyroBack = false
  private readonly gyro = new GyroTracker()
  private readonly gyroPose = new THREE.Object3D()
  private headings: number[] = []
  /** 最近一点时间里每一帧显示的位置、朝向和传感器读数，切走时取手势之前的 */
  private recent: { t: number; pos: number[]; quat: number[]; heading: number | null; beta: number | null }[] = []
  private hideSpread: number | null = null
  /** 切走前的“画面朝向 + 指南针读数”（度）；回来后用来补转角 */
  private hideSum: number | null = null
  private fixUntil = 0
  private fixSamples: { t: number; sum: number }[] = []
  /** 手机前后倾斜（度）；切后台前的和回来后的几次读数，用来判断指南针可不可信 */
  private beta: number | null = null
  private hideBeta: number | null = null
  private betas: number[] = []
  private canvas: HTMLCanvasElement | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private pose: Pose
  /** 切后台前看到的位置和朝向，重启后接上它 */
  private anchor: { pos: THREE.Vector3; quat: THREE.Quaternion } | null = null
  private heading: number | null = null
  private running = false
  private started = false
  private disposed = false
  private resumeTimer = 0
  private updates = 0
  private raw: number[] = []
  private pixel: number[] = []
  private pixelAt = 0
  private feed: HTMLVideoElement | null = null
  private bootTimer = 0
  private lastPose = [NaN, NaN, NaN, NaN, NaN, NaN, NaN]
  private poseChangedAt = 0
  private movedSincePose = false
  private readonly watchTimer: number

  constructor(XR8: XR8Api, host: HTMLElement, field: FlowerField, from: THREE.PerspectiveCamera, cb: XrCallbacks) {
    this.XR8 = XR8
    this.host = host
    this.field = field
    this.cb = cb
    this.pose = { x: from.position.x, y: CAMERA_HEIGHT, z: from.position.z, yaw: yawOf(from), heading: null }
    addEventListener('resize', this.sizeCanvas)
    addEventListener('devicemotion', this.onMotion)
    addEventListener('deviceorientation', this.onOrientation)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.watchTimer = window.setInterval(this.watch, 500)
    this.start()
  }

  /** 看门狗：手机在转，引擎给的位置却完全不变，说明相机画面停住了。 */
  private readonly watch = () => {
    if (this.disposed || !this.running || !this.started || document.hidden) return
    const stuck = performance.now() - this.poseChangedAt
    if (!this.movedSincePose || stuck < STALL_AFTER / 2) return
    // 可能只是视频被系统暂停了，先试着接上
    if (this.feed?.paused) this.feed.play().catch(() => {})
    if (stuck >= STALL_AFTER) this.fail('相机画面停住了')
  }

  /** 记下引擎这一帧给的原始位置（要在防抖之前调用）。 */
  private notePose(camera: THREE.PerspectiveCamera) {
    const { x, y, z } = camera.position
    const q = camera.quaternion
    const pose = [x, y, z, q.x, q.y, q.z, q.w]
    if (pose.some((v, i) => v !== this.lastPose[i])) {
      this.lastPose = pose
      this.poseChangedAt = performance.now()
      this.movedSincePose = false
    }
  }

  /** 排查用：引擎跑了多少帧、算出来的原始位置、防抖是否锁着、画面中心的颜色有没有变 */
  diagState() {
    const v = this.feed
    return {
      running: this.running, started: this.started, updates: this.updates, raw: this.raw, still: this.filter.still, flat: this.filter.flat, limited: this.filter.limited, jumps: this.filter.jumps, kinds: this.filter.jumpKinds, offset: this.filter.offset, tilt: Math.round(this.filter.tilt), probe: this.probe.take(), trace: this.trace.splice(0), pixel: this.pixel,
      feed: v ? { paused: v.paused, ready: v.readyState, time: Math.round(v.currentTime * 100) / 100 } : null,
      poseAge: Math.round(performance.now() - this.poseChangedAt),
    }
  }

  private start() {
    const XR8 = this.XR8
    const canvas = document.createElement('canvas')
    canvas.className = 'pending'
    if (DIAG) {
      diag('xr.start', { resumed: this.started })
      canvas.addEventListener('webglcontextlost', () => diag('xr.contextlost'))
    }
    this.host.append(canvas)
    this.canvas = canvas
    this.sizeCanvas()
    const pose = this.pose
    const resumed = this.started
    let ready = false
    let scene: THREE.Scene | null = null
    let camera: THREE.PerspectiveCamera | null = null
    this.running = true
    this.filter.reset(resumed ? this.anchor : null)
    this.poseChangedAt = performance.now()
    this.movedSincePose = false
    clearTimeout(this.bootTimer)
    this.bootTimer = window.setTimeout(() => {
      if (!ready) this.fail('引擎启动超时')
    }, BOOT_TIMEOUT)
    // 拍照用：引擎把相机画面和花画在同一块画布上，截下来就是照片（只在手机上，不上传）
    XR8.CanvasScreenshot.configure({ maxDimension: 1600, jpgCompression: 90 })
    XR8.addCameraPipelineModule(XR8.CanvasScreenshot.pipelineModule())
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      {
        name: 'flowerfield',
        onStart: () => {
          diag('xr.onStart')
          const xr = XR8.Threejs.xrScene()
          scene = xr.scene
          camera = xr.camera
          this.renderer = xr.renderer
          // 重启时引擎从原点开始，对齐交给过滤器；第一次启动时让 AR 世界接上陀螺仪阶段的朝向。
          // 高度总是给 1.4 米：引擎按这个高度定它的尺度，给别的值尺度就跟着错。
          camera!.position.set(resumed ? 0 : pose.x, CAMERA_HEIGHT, resumed ? 0 : pose.z)
          // 让 AR 世界接上记下的位置和朝向，已开的花大致留在原处。只取水平转角：重力方向引擎自己知道。
          camera!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), resumed ? 0 : pose.yaw)
          XR8.XrController.updateCameraProjectionMatrix({ origin: camera!.position, facing: camera!.quaternion })
        },
        onUpdate: () => {
          if (!scene || !camera) return
          this.updates++
          this.notePose(camera)
          if (DIAG) this.raw = [camera.position.x, camera.position.y, camera.position.z, camera.quaternion.y, camera.quaternion.w].map((v) => Math.round(v * 1000) / 1000)
          if (!ready) {
            diag('xr.firstFrame')
            ready = true
            clearTimeout(this.bootTimer)
            this.started = true
            this.camera = camera
            this.field.attach(scene, camera)
            // 新画面出来了，才收掉旧画布，中间不会黑屏。
            for (const el of [...this.host.children]) if (el !== canvas) el.remove()
            canvas.classList.remove('pending')
            this.cb.onReady(resumed)
            this.fixSamples = []
            this.fixUntil = resumed && this.hideSum != null ? performance.now() / 1000 + COMPASS_FIX_WAIT : 0
          }
          let gyro: THREE.Quaternion | null = null
          if (this.gyro.active) {
            this.gyro.update(this.gyroPose)
            gyro = this.gyroPose.quaternion
            if (DIAG && !this.gyroBack && this.hideGyroYaw != null) {
              this.gyroBack = true
              diag('xr.gyroBack', { before: Math.round(this.hideGyroYaw / DEG), after: Math.round(yawTwist(gyro) / DEG) })
            }
          }
          const now = performance.now() / 1000
          this.filter.desk = this.field.settings.scene === '桌面'
          let rawRow: number[] | null = null
          if (DIAG) {
            this.probe.engine(camera.position, now)
            if (now - this.traceAt >= 0.1) rawRow = [...camera.position.toArray(), yawTwist(camera.quaternion) / DEG, pitchOf(camera.quaternion) / DEG]
          }
          this.filter.apply(camera, gyro, now)
          this.recent.push({ t: now, pos: camera.position.toArray(), quat: camera.quaternion.toArray(), heading: this.heading, beta: this.beta })
          if (now < this.fixUntil) this.compassFix(now, camera.quaternion)
          else if (this.fixUntil) {
            diag('xr.compassFix', { gaveUp: true })
            this.fixUntil = 0
          }
          while (this.recent.length && now - this.recent[0].t > RECENT_KEEP) this.recent.shift()
          if (rawRow) {
            this.traceAt = now
            const f = this.filter
            const row = [now * 1000, ...rawRow, gyro ? yawTwist(gyro) / DEG : NaN, gyro ? pitchOf(gyro) / DEG : NaN, ...f.pos.toArray(), yawTwist(f.quat) / DEG, pitchOf(f.quat) / DEG, f.scale * 1000, f.tilt]
            this.trace.push([...row.map((v) => Math.round(v * 100) / 100), (f.holding ? 1 : 0) + (f.flat ? 2 : 0) + (f.still ? 4 : 0) + (f.lying ? 8 : 0) + (f.stale ? 16 : 0) + (f.covered ? 32 : 0), this.heading == null ? NaN : Math.round(this.heading), Math.round(f.rateNow * 10) / 10, Math.round(f.accelNow * 100) / 100])
            if (this.trace.length > 400) this.trace.splice(0, this.trace.length - 400)
          }
          this.field.tick()
        },
        ...(DIAG
          ? {
              onRender: () => {
                const now = performance.now()
                if (now - this.pixelAt < 1000 || !this.renderer) return
                this.pixelAt = now
                const gl = this.renderer.getContext()
                const px = new Uint8Array(4)
                gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
                this.pixel = [...px]
              },
            }
          : {}),
        onCameraStatusChange: ({ status, video, stream }: { status: string; video?: HTMLVideoElement; stream?: MediaStream }) => {
          diag('xr.camera', status)
          if (video) this.feed = video
          if (DIAG && stream) {
            for (const n of ['mute', 'unmute', 'ended']) stream.getVideoTracks()[0]?.addEventListener(n, () => diag(`xr.track.${n}`))
          }
          if (status === 'failed') this.fail('相机打不开')
        },
        onException: (e: unknown) => {
          diag('xr.exception', e instanceof Error ? e.message : JSON.stringify(e))
          this.fail(e instanceof Error ? e.message : JSON.stringify(e))
        },
        listeners: [
          {
            event: 'reality.trackingstatus',
            process: ({ detail }: { detail: { status: string; reason?: string } }) => {
              diag('xr.tracking', detail)
              this.filter.limited = detail.status !== 'NORMAL'
              this.filter.initializing = detail.status !== 'NORMAL' && detail.reason === 'INITIALIZING'
              this.cb.onTracking(detail.status === 'NORMAL')
            },
          },
        ],
      },
    ])
    try {
      XR8.XrController.configure({ scale: XR_SCALE })
      diag('xr.scale', XR_SCALE)
      XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY })
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e))
    }
  }

  private fail(reason: string) {
    diag('xr.fail', reason)
    if (this.disposed) return
    this.dispose()
    this.cb.onFail(reason)
  }

  private halt() {
    if (!this.running) return
    this.running = false
    try {
      this.XR8.stop()
      this.XR8.clearCameraPipelineModules()
    } catch {
      // 引擎还没真正跑起来时，stop 可能抛错，可以忽略
    }
  }

  private readonly sizeCanvas = () => {
    if (!this.canvas) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(innerWidth * dpr)
    this.canvas.height = Math.round(innerHeight * dpr)
  }

  private readonly onMotion = (e: DeviceMotionEvent) => {
    const r = e.rotationRate
    const a = e.acceleration
    if (!r || !a) return
    const rate = Math.max(Math.abs(r.alpha ?? 0), Math.abs(r.beta ?? 0), Math.abs(r.gamma ?? 0))
    const accel = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0)
    this.filter.motion(rate, accel, performance.now() / 1000)
    if (DIAG) this.probe.device(a.x ?? 0, a.y ?? 0, a.z ?? 0, performance.now() / 1000)
    if (rate > STALL_RATE) this.movedSincePose = true
  }

  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta != null && e.gamma != null) {
      this.filter.orientation(e.beta, e.gamma)
      this.beta = e.beta
      if (!this.running) this.betas.push(e.beta)
    }
    const h = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
    if (typeof h === 'number') {
      this.heading = h
      if (!this.running) this.headings.push(h)
    }
  }

  private readonly onVisibility = () => {
    diag('xr.visibility', document.hidden)
    if (this.disposed) return
    clearTimeout(this.resumeTimer)
    if (document.hidden) {
      if (this.camera) {
        // 取切走手势之前的那一帧：位置、朝向、指南针（取那之前一小段的平均）、倾斜
        const now = performance.now() / 1000
        const list = this.recent
        let at = list.length ? list[0] : null
        for (const e of list) if (e.t <= now - HIDE_LOOKBACK) at = e
        const pos = at ? new THREE.Vector3().fromArray(at.pos) : this.camera.position.clone()
        const quat = at ? new THREE.Quaternion().fromArray(at.quat) : this.camera.quaternion.clone()
        const hs = at ? list.filter((e) => e.t <= at.t && e.t >= at.t - 0.4 && e.heading != null).map((e) => e.heading!) : []
        const heading = hs.length ? meanHeading(hs) : this.heading
        this.hideSpread = hs.length ? headingSpread(hs, heading!) : null
        // 画面朝向 + 指南针读数，取手势之前一小段的平均；读数在晃就不用
        const sums = at
          ? list.filter((e) => e.t <= at.t && e.t >= at.t - COMPASS_FIX_WINDOW && e.heading != null)
              .map((e) => (yawTwist(new THREE.Quaternion().fromArray(e.quat)) / DEG + e.heading! + 720) % 360)
          : []
        const sum = sums.length ? meanHeading(sums) : null
        this.hideSum = sum != null && headingSpread(sums, sum) <= COMPASS_MAX_SPREAD ? sum : null
        const y = Math.max(0.6, Math.min(2.4, pos.y))
        this.pose = { x: pos.x, y, z: pos.z, yaw: yawOfQuat(quat), heading }
        this.anchor = { pos, quat }
        this.hideBeta = at?.beta ?? this.beta
        this.hideGyroYaw = this.gyro.active ? yawTwist(this.gyroPose.quaternion) : null
        this.gyroBack = false
        // 回来后陀螺仪要等新读数：旧读数和新读数之间的跳变不能当成手机在转
        this.gyro.resync()
        diag('xr.hide', this.pose)
      }
      this.halt()
      return
    }
    if (this.running) return
    this.cb.onResuming()
    this.headings = []
    this.betas = []
    // 等一下，多取几个指南针读数求平均：切后台期间手机转了多少，这里补回来。
    this.resumeTimer = window.setTimeout(() => {
      const h0 = this.pose.heading
      if (h0 != null && this.headings.length && this.anchor) {
        const h1 = meanHeading(this.headings)
        const spread1 = headingSpread(this.headings, h1)
        const turned = ((h1 - h0 + 540) % 360) - 180 // 向右转时指南针读数变大，绕竖直轴的转角是负的
        const b0 = this.hideBeta
        const b1 = this.betas.length ? this.betas.reduce((a, b) => a + b, 0) / this.betas.length : null
        const trusted =
          b0 != null && b1 != null &&
          Math.abs(b1 - b0) <= COMPASS_MAX_TILT_GAP &&
          (this.hideSpread ?? 0) <= COMPASS_MAX_SPREAD &&
          spread1 <= COMPASS_MAX_SPREAD
        // 这里只记录；真正补转角在回来后指南针稳定时（compassFix）
        diag('xr.resume', { h0, h1, turned, b0, b1, spread0: this.hideSpread, spread1, trusted, samples: this.headings.length, hideSum: this.hideSum })
      }
      this.start()
    }, 600)
  }

  /** 拍照：截一张当前的 AR 画面（JPEG）。引擎没在跑时返回 null。 */
  async screenshot(): Promise<Blob | null> {
    if (!this.running || !this.started) return null
    try {
      const data: string = await this.XR8.CanvasScreenshot.takeScreenshot()
      const b64 = data.replace(/^data:image\/\w+;base64,/, '')
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: 'image/jpeg' })
    } catch {
      return null
    }
  }

  /** 切回来后：等指南针读数稳定，把画面转回切走前和指南针的对应关系。 */
  private compassFix(now: number, quat: THREE.Quaternion) {
    if (this.hideSum == null || this.heading == null) return
    if (this.beta == null || this.hideBeta == null || Math.abs(this.beta - this.hideBeta) > COMPASS_MAX_TILT_GAP) {
      this.fixSamples = []
      return
    }
    const list = this.fixSamples
    list.push({ t: now, sum: (yawTwist(quat) / DEG + this.heading + 720) % 360 })
    while (list.length && now - list[0].t > COMPASS_FIX_WINDOW) list.shift()
    if (now - list[0].t < COMPASS_FIX_WINDOW * 0.8) return
    const sums = list.map((e) => e.sum)
    const mean = meanHeading(sums)
    if (headingSpread(sums, mean) > COMPASS_FIX_SPREAD) return
    const delta = ((this.hideSum - mean + 540) % 360) - 180
    if (Math.abs(delta) >= COMPASS_FIX_MIN) this.filter.turnWorld(delta * DEG)
    diag('xr.compassFix', { hideSum: Math.round(this.hideSum), now: Math.round(mean), delta: Math.round(delta * 10) / 10, applied: Math.abs(delta) >= COMPASS_FIX_MIN })
    this.fixUntil = 0
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.resumeTimer)
    clearTimeout(this.bootTimer)
    clearInterval(this.watchTimer)
    this.gyro.dispose()
    removeEventListener('resize', this.sizeCanvas)
    removeEventListener('devicemotion', this.onMotion)
    removeEventListener('deviceorientation', this.onOrientation)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.halt()
    this.host.replaceChildren()
  }
}
