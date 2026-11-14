import type { Strings } from './i18n'

type PermissionResult = 'granted' | 'denied'

// iOS 13+ 的 DeviceMotionEvent / DeviceOrientationEvent 有 requestPermission，TS 的 DOM 类型里没有。
interface NeedsPermission {
  requestPermission?: () => Promise<PermissionResult>
}

export type MotionPermission = PermissionResult | 'not-needed'

/**
 * 申请陀螺仪权限。iOS 上必须在用户点按的处理函数里调用；
 * 运动和方向共用同一个授权，第一个同意后第二个会直接返回 granted。
 */
export async function requestMotionPermission(): Promise<MotionPermission> {
  const motion = globalThis.DeviceMotionEvent as unknown as NeedsPermission | undefined
  const orientation = globalThis.DeviceOrientationEvent as unknown as NeedsPermission | undefined
  if (!motion?.requestPermission && !orientation?.requestPermission) return 'not-needed'
  try {
    const first = motion?.requestPermission ? await motion.requestPermission() : await orientation!.requestPermission!()
    if (first === 'granted' && orientation?.requestPermission) await orientation.requestPermission()
    return first
  } catch {
    return 'denied'
  }
}

export function cameraErrorText(e: unknown, t: Strings['errors']): string {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return t.notSecure
  const name = e instanceof DOMException ? e.name : ''
  switch (name) {
    case 'NotAllowedError':
      return t.notAllowed
    case 'NotFoundError':
    case 'OverconstrainedError':
      return t.notFound
    case 'NotReadableError':
      return t.notReadable
    default:
      return t.other(name)
  }
}
