// 手写标题：四个字取自 851 GBai 马克笔体（只存这四个字的图形，不带字体文件）。
// “魔”字右下角原字形的竖弯钩是断开的，字形图里已经补上了这一笔。
// 上水彩色之后和整幅画一起过滤镜。
import glyphsUrl from './title-glyphs.png'
import { drop, makeCanvas, mulberry32, rgba } from './watercolor'

/** 字形图里每格的边长（像素）：字的墨迹约占 350 像素 */
const CELL = 480
/** 每格换算成排版坐标的大小 */
const CELL_U = 136

/** 花、田、魔、法 */
const GLYPHS = [
  { cx: 52, cy: 58, k: 1.02, rot: -0.02 },
  { cx: 161, cy: 60, k: 1, rot: -0.015 },
  { cx: 273, cy: 56, k: 1.04, rot: 0.01 },
  { cx: 381, cy: 60, k: 1.02, rot: -0.01 },
]
/** 四个字排起来的总宽高（排版坐标） */
const SPAN = 432
const SPAN_H = 119

const TAU = Math.PI * 2

export function loadTitleGlyphs(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = glyphsUrl
  })
}

/** 字上的一朵小花 */
function blossom(ctx: CanvasRenderingContext2D, R: number, turn: number) {
  for (let i = 0; i < 5; i++) {
    ctx.save()
    ctx.rotate((i / 5) * TAU + turn)
    const w = R * 0.56
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.bezierCurveTo(w * 0.9, -R * 0.18, w * 1.15, -R * 0.82, 0, -R)
    ctx.bezierCurveTo(-w * 1.15, -R * 0.82, -w * 0.9, -R * 0.18, 0, 0)
    ctx.closePath()
    ctx.fillStyle = '#fffdf8'
    ctx.fill()
    const g = ctx.createLinearGradient(0, 0, 0, -R)
    g.addColorStop(0, rgba('#8fb0f0', 0.08))
    g.addColorStop(0.5, rgba('#8fb0f0', 0.5))
    g.addColorStop(1, '#7f9ee9')
    ctx.fillStyle = g
    ctx.fill()
    ctx.strokeStyle = rgba('#4a66cc', 0.85)
    ctx.lineWidth = R * 0.05
    ctx.stroke()
    ctx.restore()
  }
  ctx.fillStyle = '#f6d36a'
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.17, 0, TAU)
  ctx.fill()
}

/** 把标题画到一张透明图上。w、h 是像素，字按比例居中。 */
export function paintTitle(w: number, h: number, glyphs: HTMLImageElement): HTMLCanvasElement {
  const r = mulberry32(21)
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const k = Math.min(w / SPAN, h / SPAN_H)
  const originX = (w - SPAN * k) / 2
  const originY = (h - SPAN_H * k) / 2
  ctx.save()
  ctx.translate(originX, originY)
  ctx.scale(k, k)
  GLYPHS.forEach((g, i) => {
    ctx.save()
    ctx.translate(g.cx, g.cy)
    ctx.rotate(g.rot)
    const size = CELL_U * g.k
    ctx.drawImage(glyphs, i * CELL, 0, CELL, CELL, -size / 2, -size / 2, size, size)
    ctx.restore()
  })
  ctx.restore()

  tint(ctx, w, h, r)

  // 魔字右下角一朵小花
  ctx.save()
  ctx.translate(originX, originY)
  ctx.scale(k, k)
  ctx.translate(GLYPHS[2].cx + 38, GLYPHS[2].cy + 47)
  blossom(ctx, 13.5, 0.3)
  ctx.restore()
  return c
}

/** 上色：靛蓝往紫里走，笔画里有深有浅（只染已经画上去的笔画） */
function tint(ctx: CanvasRenderingContext2D, w: number, h: number, r: () => number) {
  ctx.globalCompositeOperation = 'source-in'
  const g = ctx.createLinearGradient(0, 0, w, h * 0.4)
  g.addColorStop(0, '#2f46a3')
  g.addColorStop(0.36, '#3a40a6')
  g.addColorStop(0.68, '#5546b0')
  g.addColorStop(1, '#3f5cbc')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-atop'
  const blob = h * 0.2
  for (let i = 0; i < 110; i++) {
    const x = r() * w
    const y = r() * h
    const pick = r()
    if (pick < 0.42) drop(ctx, x, y, blob * (0.25 + r() * 0.6), '#1d2870', 0.22 + r() * 0.3)
    else if (pick < 0.8) drop(ctx, x, y, blob * (0.2 + r() * 0.55), '#86a2ee', 0.24 + r() * 0.34)
    else drop(ctx, x, y, blob * (0.2 + r() * 0.5), '#a086e4', 0.24 + r() * 0.32)
  }
  ctx.globalCompositeOperation = 'source-over'
}

// 英文标题用手写体（系统自带的，不打包字体）：iPhone 和 Mac 上是 Snell Roundhand，别的设备退到相近的手写体
const SCRIPT = '"Snell Roundhand", "Apple Chancery", "Segoe Script", "Brush Script MT", "Dancing Script", cursive'

/** 英文标题：手写体写一行字，和中文标题一样上水彩色，末尾一朵小花。 */
export function paintTitleText(w: number, h: number, text: string): HTMLCanvasElement {
  const r = mulberry32(21)
  const c = makeCanvas(w, h)
  const ctx = c.getContext('2d')!
  let size = h * 0.6
  ctx.font = `600 ${size}px ${SCRIPT}`
  const fit = ctx.measureText(text).width
  if (fit > w * 0.9) size *= (w * 0.9) / fit
  ctx.font = `600 ${size}px ${SCRIPT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  ctx.lineJoin = 'round'
  ctx.lineWidth = size * 0.035 // 手写体的笔画很细，描一圈加粗一点
  ctx.fillText(text, w / 2, h * 0.54)
  ctx.strokeText(text, w / 2, h * 0.54)
  tint(ctx, w, h, r)
  const tw = ctx.measureText(text).width
  const R = size * 0.2
  ctx.save()
  ctx.translate(Math.min(w - R * 1.2, w / 2 + tw / 2 + R * 0.4), h * 0.54 - size * 0.42)
  blossom(ctx, R, 0.3)
  ctx.restore()
  return c
}
