// 真机排查用：测试版地址带 ?debug 时记录相机和 AR 的关键事件，定时发回电脑（见 CameraView）。正式构建里永远是 false。
export const DIAG = __LAB__ && new URLSearchParams(location.search).has('debug')

const events: unknown[] = []

export function diag(name: string, data?: unknown) {
  if (!__LAB__ || !DIAG || events.length >= 400) return
  events.push({ t: Math.round(performance.now()), name, data })
}

export function takeDiagEvents() {
  return events.splice(0)
}
