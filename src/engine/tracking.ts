import * as THREE from 'three'

/**
 * 追踪模块：决定虚拟相机的朝向（和以后的位置）。
 * 现在有陀螺仪（3DoF）；之后的 8th Wall SLAM、原生 ARKit 也实现这个接口，开花引擎不用改。
 */
export interface Tracker {
  readonly kind: 'gyro'
  /** 是否已经收到传感器数据；没有时相机保持平视 */
  readonly active: boolean
  update(camera: THREE.Object3D): void
  dispose(): void
}

const Z_AXIS = new THREE.Vector3(0, 0, 1)
// 设备坐标系 → 相机：手机竖直时后置相机看向水平前方。
const SCREEN_TO_CAMERA = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))
const DEG = Math.PI / 180

/** 陀螺仪：手机转动时，虚拟相机跟着转，花就固定在空间方向上。 */
export class GyroTracker implements Tracker {
  readonly kind = 'gyro'
  private ori: { alpha: number; beta: number; gamma: number } | null = null
  private readonly euler = new THREE.Euler()
  private readonly target = new THREE.Quaternion()
  private readonly screenTurn = new THREE.Quaternion()
  private first = true

  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return
    this.ori = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma }
  }

  /** 切后台回来后调用：丢掉旧读数，等新的读数到了再用，并且直接对齐不平滑。 */
  resync() {
    this.ori = null
    this.first = true
  }

  constructor() {
    addEventListener('deviceorientation', this.onOrientation)
  }

  get active() {
    return this.ori != null
  }

  update(camera: THREE.Object3D) {
    if (!this.ori) {
      camera.quaternion.identity()
      return
    }
    const { alpha, beta, gamma } = this.ori
    const orient = (screen.orientation?.angle ?? 0) * DEG
    this.euler.set(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ')
    this.target.setFromEuler(this.euler).multiply(SCREEN_TO_CAMERA)
    this.target.multiply(this.screenTurn.setFromAxisAngle(Z_AXIS, -orient))
    // 轻微平滑，滤掉传感器的抖动；第一次直接对齐。
    if (this.first) {
      camera.quaternion.copy(this.target)
      this.first = false
    } else {
      camera.quaternion.slerp(this.target, 0.5)
    }
  }

  dispose() {
    removeEventListener('deviceorientation', this.onOrientation)
  }
}
