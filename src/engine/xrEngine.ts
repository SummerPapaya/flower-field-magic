// 按需加载 8th Wall 引擎（世界追踪）。引擎来自 npm 包 @8thwall/engine-binary，构建时复制到 /xr/（见 vite.config.ts）。
import * as THREE from 'three'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type XR8Api = any

let loading: Promise<XR8Api> | null = null

/** 只在手机和平板上用世界追踪：电脑没有陀螺仪，也没有后置相机。 */
export function arSupported() {
  const ua = navigator.userAgent
  const phone = /iPhone|iPad|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  // 开发时加 ?ar=force，可以在电脑上走一遍切换流程（引擎的桌面模式，没有真实相机）。
  return phone || (import.meta.env.DEV && new URLSearchParams(location.search).get('ar') === 'force')
}

/** 加载引擎（只下载一次）。下载失败返回的 Promise 会 reject，下次调用会重试。 */
export function loadXrEngine(): Promise<XR8Api> {
  if (loading) return loading
  ;(window as any).THREE = THREE // 引擎的 three.js 模块从全局读取
  loading = new Promise<XR8Api>((resolve, reject) => {
    if ((window as any).XR8) {
      resolve((window as any).XR8)
      return
    }
    addEventListener('xrloaded', () => resolve((window as any).XR8), { once: true })
    const s = document.createElement('script')
    s.src = '/xr/xr.js'
    s.async = true
    s.dataset.preloadChunks = 'slam'
    s.onerror = () => {
      loading = null
      reject(new Error('AR 引擎下载失败'))
    }
    document.head.append(s)
  })
  return loading
}
