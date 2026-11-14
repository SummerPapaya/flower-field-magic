/**
 * 仅开发用：电脑上没有后置相机（或浏览器不给用）时，用一张画出来的“草地 + 天空”当相机画面，
 * 地平线在画面正中，方便在电脑上预览开花效果。地址加 ?fakecam 启用。
 */
export function wantsFakeCamera() {
  return import.meta.env.DEV && new URLSearchParams(location.search).has('fakecam')
}

export function fakeCameraStream(): MediaStream {
  const c = document.createElement('canvas')
  c.width = 1440
  c.height = 1920
  const ctx = c.getContext('2d')!
  const H = c.height
  const sky = ctx.createLinearGradient(0, 0, 0, H / 2)
  sky.addColorStop(0, '#9fc3ec')
  sky.addColorStop(1, '#e3eef8')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, c.width, H / 2)
  const meadow = ctx.createLinearGradient(0, H / 2, 0, H)
  meadow.addColorStop(0, '#b7cfa4')
  meadow.addColorStop(1, '#6f9a5c')
  ctx.fillStyle = meadow
  ctx.fillRect(0, H / 2, c.width, H / 2)
  // 草地上的一点纹理，让远近感更明显
  for (let i = 0; i < 1400; i++) {
    const t = Math.random()
    const y = H / 2 + t * t * (H / 2)
    ctx.fillStyle = `rgba(60, 100, 50, ${0.08 + t * 0.15})`
    ctx.fillRect(Math.random() * c.width, y, 2 + t * 10, 1 + t * 4)
  }
  return c.captureStream(15)
}
