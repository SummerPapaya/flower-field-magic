export interface StrokeHandlers {
  /** 开始新的一笔，返回笔的编号 */
  begin(): number
  /** 沿路径开一朵花；delay 让同一段里的花依次绽放 */
  place(x: number, y: number, delay: number, stroke: number): void
  /** 点一下（没有移动） */
  tap(x: number, y: number, stroke: number): void
  /** 第一次画（用来收起提示） */
  onFirstStroke?(): void
  pinchStart(): void
  /** ratio：两指间距相对开始时的倍数 */
  pinch(ratio: number): void
  pinchEnd(): void
}

const SPACING = 22 // 滑动时每隔多少像素开一朵
const MOVE_SLOP = 8 // 移动超过这个距离才算滑动，否则算点按

/**
 * 施法笔画输入：一根手指点一下开一簇、滑动沿路径开花；两根手指只做缩放，不画花，
 * 等手指全部离开后才重新开始画。点击、滑动、以后的手势识别都走这一条路。
 */
export function attachStrokeInput(el: HTMLElement, h: StrokeHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>()
  let drag: { id: number; x: number; y: number; sx: number; sy: number; moved: boolean; stroke: number } | null = null
  let pinch: { d0: number } | null = null
  let gestureLock = false
  let started = false

  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const distance = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const first = () => {
    if (!started) {
      started = true
      h.onFirstStroke?.()
    }
  }

  // 清掉所有手势状态。iOS 偶尔不发手指抬起的事件，留下的“幽灵手指”会让之后的单指都被当成双指，
  // 所以不能只靠 pointerup：下面几处能确定屏幕上已经没有手指时，都会调用它。
  const reset = () => {
    pointers.clear()
    drag = null
    pinch = null
    gestureLock = false
  }

  const down = (e: PointerEvent) => {
    // isPrimary：这是当前唯一按着的手指，之前记着的都已经不在屏幕上了。
    if (e.isPrimary) reset()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 合成事件没有真实指针，忽略
    }
    pointers.set(e.pointerId, local(e))
    if (pointers.size >= 2) {
      drag = null
      gestureLock = true
      pinch = { d0: Math.max(20, distance()) }
      h.pinchStart()
      return
    }
    if (gestureLock) return
    const p = local(e)
    drag = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, stroke: h.begin() }
  }

  const move = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return
    const p = local(e)
    pointers.set(e.pointerId, p)
    if (pinch && pointers.size >= 2) {
      h.pinch(distance() / pinch.d0)
      return
    }
    if (!drag || drag.id !== e.pointerId) return
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > MOVE_SLOP) drag.moved = true
    const dx = p.x - drag.x
    const dy = p.y - drag.y
    const d = Math.hypot(dx, dy)
    if (d < SPACING) return
    first()
    const steps = Math.floor(d / SPACING)
    for (let i = 1; i <= steps; i++) {
      const t = (i * SPACING) / d
      const j = (Math.random() - 0.5) * 12 // 垂直于路径的随机偏移，花不会排成一条直线
      h.place(drag.x + dx * t - (dy / d) * j, drag.y + dy * t + (dx / d) * j, (i - 1) * 25, drag.stroke)
    }
    drag.x += (dx * steps * SPACING) / d
    drag.y += (dy * steps * SPACING) / d
  }

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (drag && drag.id === e.pointerId && !drag.moved && !cancelled && !gestureLock) {
      first()
      const p = local(e)
      h.tap(p.x, p.y, drag.stroke)
    }
    if (drag && drag.id === e.pointerId) drag = null
    pointers.delete(e.pointerId)
    if (pointers.size < 2 && pinch) {
      pinch = null
      h.pinchEnd()
    }
    if (pointers.size === 0) gestureLock = false
  }
  const up = (e: PointerEvent) => end(e, false)
  const cancel = (e: PointerEvent) => end(e, true)
  const stopGesture = (e: Event) => e.preventDefault() // 不让 Safari 把双指当成整页缩放
  // 触摸事件的 touches 是系统给的准确数字：归零就说明所有手指都离开了（pointerup 先于它触发，点按不受影响）。
  const touchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) reset()
  }
  const visibility = () => {
    if (document.hidden) reset()
  }

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', cancel)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(t, stopGesture)
  window.addEventListener('touchend', touchEnd)
  window.addEventListener('touchcancel', touchEnd)
  document.addEventListener('visibilitychange', visibility)
  return () => {
    window.removeEventListener('touchend', touchEnd)
    window.removeEventListener('touchcancel', touchEnd)
    document.removeEventListener('visibilitychange', visibility)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', cancel)
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(t, stopGesture)
  }
}
