import { useEffect, useRef, useState } from 'react'
import { cameraErrorText } from '../lib/permissions'
import { fakeCameraStream, wantsFakeCamera } from '../lib/fakeCamera'
import { DEFAULT_SETTINGS, FlowerField, type FieldSettings, type PaletteName, type SceneKind, type StemMode } from '../engine/field'
import { DENSITY, PRESETS, type BrushKind, type DensityName } from '../engine/presets'
import { SINGLE_SPECIES, type SpeciesId } from '../engine/species'
import { useI18n } from '../lib/i18n'
import { GyroStage, XrStage } from '../engine/stages'
import { GyroTracker } from '../engine/tracking'
import { attachStrokeInput } from '../engine/strokes'
import { arSupported, loadXrEngine } from '../engine/xrEngine'
import { diag, takeDiagEvents } from '../lib/diag'

interface Props {
  onExit: () => void
}

const STEMS: StemMode[] = ['auto', 'always', 'never']
const PALETTES = [...Object.keys(PRESETS), '单种'] as PaletteName[]
type PinchTarget = '花朵' | '画面'

// 地址加 ?debug 时显示帧率，开发时还能把结果发回电脑。
const DEBUG = __LAB__ && new URLSearchParams(location.search).has('debug')

// Safari 的相机变焦（MediaTrack 的 zoom）还不在 TS 的 DOM 类型里。
type ZoomCaps = MediaTrackCapabilities & { zoom?: { min: number; max: number } }
type ZoomSettings = MediaTrackSettings & { zoom?: number }

function Seg<T extends string>(props: { label: string; options: readonly T[]; value: T; names?: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      <span>{props.label}</span>
      {props.options.map((o) => (
        <button key={o} className={o === props.value ? 'on' : ''} onClick={() => props.onChange(o)}>
          {props.names ? props.names[o] : o}
        </button>
      ))}
    </div>
  )
}

/** 数码变焦时照片要和屏幕上看到的一样：从中间裁出 1/z，再放回原尺寸。 */
async function cropCenter(blob: Blob, z: number): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const sw = bmp.width / z
  const sh = bmp.height / z
  c.getContext('2d')!.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, c.width, c.height)
  bmp.close()
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.92))
}

/** 照片文件名里的时间：20261112-183045 */
function stamp() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 开发排查：每秒记一次状态，进入相机后第 3、8、15 秒各发回一次，之后每 15 秒发一次。 */
function startDiagReports(video: HTMLVideoElement, stream: () => MediaStream | null, stage: () => object) {
  const t0 = performance.now()
  let frames = 0
  let stopped = false
  const countFrame = () => {
    frames++
    if (!stopped) video.requestVideoFrameCallback?.(countFrame)
  }
  video.requestVideoFrameCallback?.(countFrame)
  const videoEvents = ['pause', 'playing', 'stalled', 'suspend', 'waiting', 'ended', 'emptied'] as const
  const onVideo = (e: Event) => diag(`video.${e.type}`)
  for (const n of videoEvents) video.addEventListener(n, onVideo)
  const track = stream()?.getVideoTracks()[0]
  const onTrack = (e: Event) => diag(`track.${e.type}`)
  for (const n of ['mute', 'unmute', 'ended']) track?.addEventListener(n, onTrack)
  const onError = (e: ErrorEvent | PromiseRejectionEvent) => diag('error', 'reason' in e ? String(e.reason) : e.message)
  addEventListener('error', onError)
  addEventListener('unhandledrejection', onError)
  const samples: object[] = []
  const sample = setInterval(() => {
    const t = stream()?.getVideoTracks()[0]
    samples.push({
      s: Math.round((performance.now() - t0) / 1000),
      hidden: document.hidden,
      video: { paused: video.paused, ready: video.readyState, time: Math.round(video.currentTime * 100) / 100, size: [video.videoWidth, video.videoHeight], frames },
      track: t ? { state: t.readyState, muted: t.muted, enabled: t.enabled } : null,
      // 页面里所有的视频，包括 AR 引擎自己开的相机
      videos: [...document.querySelectorAll('video')].map((v) => {
        const s = v.srcObject instanceof MediaStream ? v.srcObject.getVideoTracks()[0] : null
        return { paused: v.paused, ready: v.readyState, time: Math.round(v.currentTime * 100) / 100, live: s?.readyState ?? null, muted: s?.muted ?? null }
      }),
      ...stage(),
    })
  }, 1000)
  const send = () => {
    const report = { kind: 'diag', build: __BUILD__, time: new Date().toISOString(), ua: navigator.userAgent, samples: samples.splice(0), events: takeDiagEvents() }
    fetch('/api/lab-report', { method: 'POST', body: JSON.stringify(report) }).catch(() => {})
  }
  const timers = [3, 8].map((s) => window.setTimeout(send, s * 1000))
  const repeat = window.setInterval(send, 15000)
  return () => {
    stopped = true
    clearInterval(sample)
    timers.forEach(clearTimeout)
    clearInterval(repeat)
    for (const n of videoEvents) video.removeEventListener(n, onVideo)
    for (const n of ['mute', 'unmute', 'ended']) track?.removeEventListener(n, onTrack)
    removeEventListener('error', onError)
    removeEventListener('unhandledrejection', onError)
  }
}

/** 全屏后置相机取景 + 花田层。 */
export default function CameraView({ onExit }: Props) {
  // 进相机页以后语言不会变（只能在开场页切换），效果里直接用这一份
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const xrHostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fieldRef = useRef<FlowerField | null>(null)
  /** 截一张当前画面（相机画面 + 花）：拍照用，测试版的“发送结果”也用 */
  const snapRef = useRef<(() => Promise<Blob | null>) | null>(null)
  /** 现在的数码变焦倍数（拍照时按它裁切） */
  const digitalRef = useRef(1)
  const shootingRef = useRef(false)
  const [photo, setPhoto] = useState<{ url: string; file: File } | null>(null)
  const [flash, setFlash] = useState(false)
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [settings, setSettings] = useState<FieldSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef(settings)
  const [pinchTarget, setPinchTarget] = useState<PinchTarget>('花朵')
  const pinchRef = useRef<PinchTarget>('花朵')
  const [hasFlowers, setHasFlowers] = useState(false)
  const [hint, setHint] = useState(true)
  const [gyroOff, setGyroOff] = useState(false)
  const [chip, setChip] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  // gyro = 只跟踪转动；loading = AR 引擎在后台下载或启动；ar = 花固定在地上
  const [tracking, setTracking] = useState<'gyro' | 'loading' | 'ar'>('gyro')
  const [limited, setLimited] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [sent, setSent] = useState(false)
  const [debug, setDebug] = useState('')
  const chipTimer = useRef(0)
  const fpsSamples = useRef<number[]>([])
  // AR 引擎出过问题（比如相机画面停住）：之后只用陀螺仪，不再启动它
  const xrOff = useRef(false)

  const showChip = (text: string, ms = 1200) => {
    setChip(text)
    clearTimeout(chipTimer.current)
    chipTimer.current = window.setTimeout(() => setChip(null), ms)
  }

  // 打开相机
  useEffect(() => {
    let cancelled = false
    setState('starting')
    const open = async () => {
      try {
        // import.meta.env.DEV 写在这里，正式构建会把模拟相机整段去掉。
        const s = import.meta.env.DEV && wantsFakeCamera()
          ? fakeCameraStream()
          : await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
              audio: false,
            })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = s
        const video = videoRef.current!
        video.srcObject = s
        await video.play().catch(() => {})
        setState('live')
      } catch (e) {
        if (cancelled) return
        setError(cameraErrorText(e, t.errors))
        setState('error')
      }
    }
    open()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [attempt])

  // 相机就绪后：建花田、陀螺仪舞台、手势；AR 引擎准备好后自动换到 AR 舞台
  useEffect(() => {
    if (state !== 'live') return
    const canvas = canvasRef.current!
    const video = videoRef.current!
    const input = inputRef.current!
    const field = new FlowerField(input, settingsRef.current)
    fieldRef.current = field
    const tracker = new GyroTracker()
    let gyro: GyroStage | null = new GyroStage(canvas, video, field, tracker)
    let xr: XrStage | null = null
    snapRef.current = () => (xr ? xr.screenshot() : gyro ? gyro.screenshot() : Promise.resolve(null))
    let disposed = false
    const onResize = () => gyro?.resize()
    window.addEventListener('resize', onResize)
    video.addEventListener('resize', onResize)
    video.addEventListener('loadedmetadata', onResize)
    const gyroTimer = window.setTimeout(() => setGyroOff(!tracker.active), 1500)
    const onVisible = () => {
      if (!document.hidden && gyro) video.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    // 少数情况下（比如低电量模式）视频不会自己播放，碰屏幕时补一下。AR 引擎的相机视频也算在内
    const onTouch = () => {
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused || !v.srcObject) continue
        diag('video.resumeOnTouch')
        v.play().catch(() => {})
      }
    }
    input.addEventListener('pointerdown', onTouch)

    // 双指：陀螺仪舞台下相机支持变焦就变焦（虚拟相机视角同步变，花跟着景物一起放大）；
    // AR 舞台或不支持变焦时调新开花朵的大小（AR 里变焦会让追踪对不上）。
    const track = streamRef.current?.getVideoTracks()[0]
    const caps = track?.getCapabilities?.() as ZoomCaps | undefined
    const zoom = {
      supported: !!caps?.zoom,
      min: caps?.zoom?.min ?? 1,
      max: Math.min(caps?.zoom?.max ?? 1, 5),
      base: (track?.getSettings() as ZoomSettings | undefined)?.zoom ?? 1,
      value: 1,
      start: 1,
      size0: 1,
      digital: 1,
      digital0: 1,
      busy: false,
      next: null as number | null,
    }
    zoom.value = zoom.base
    const applyZoom = async (z: number) => {
      if (!track || !gyro) return
      if (zoom.busy) {
        zoom.next = z
        return
      }
      zoom.busy = true
      try {
        await track.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
        zoom.value = (track.getSettings() as ZoomSettings).zoom ?? z
        gyro?.setZoomRatio(zoom.value / zoom.base)
        showChip(`${zoom.value.toFixed(1)}×`)
      } catch {
        zoom.supported = false // 变焦失败就改成调大小
      }
      zoom.busy = false
      if (zoom.next != null) {
        const n = zoom.next
        zoom.next = null
        applyZoom(n)
      }
    }

    // 数码变焦：AR 引擎不能改相机焦距，相机不支持变焦时也一样，就把整个画面放大，手指位置在 rayAt 里换算回去
    const setDigital = (z: number) => {
      zoom.digital = z
      digitalRef.current = z
      field.viewZoom = z
      const t = z === 1 ? '' : `scale(${z})`
      video.style.transform = t
      canvas.style.transform = t
      xrHostRef.current!.style.transform = t
    }

    const detach = attachStrokeInput(input, {
      begin: () => field.beginStroke(),
      place: (x, y, delay, stroke) => {
        field.placeAt(x, y, delay / 1000, stroke)
        setHasFlowers(field.hasFlowers)
      },
      tap: (x, y, stroke) => {
        field.tap(x, y, stroke)
        setHasFlowers(field.hasFlowers)
      },
      onFirstStroke: () => setHint(false),
      pinchStart: () => {
        zoom.start = zoom.value
        zoom.size0 = field.sizeK
        zoom.digital0 = zoom.digital
      },
      pinch: (ratio) => {
        if (pinchRef.current === '花朵') {
          field.sizeK = Math.max(0.5, Math.min(2.5, zoom.size0 * ratio))
          showChip(t.camera.newSize(field.sizeK.toFixed(1)))
        } else if (gyro && zoom.supported) {
          applyZoom(Math.max(zoom.min, Math.min(zoom.max, zoom.start * ratio)))
        } else {
          const z = Math.max(1, Math.min(3, zoom.digital0 * ratio))
          setDigital(z)
          showChip(t.camera.viewZoom(z.toFixed(1)))
        }
      },
      pinchEnd: () => {},
    })

    // 切换到 AR：引擎在隐藏的画布上启动，第一帧出来后才接手花田。
    if (arSupported() && !xrOff.current) {
      setTracking('loading')
      diag('xr.load')
      loadXrEngine().then(
        (XR8) => {
          diag('xr.loaded')
          if (disposed) return
          // iPhone 上系统相机还开着时，引擎只收得到第一帧相机画面，所以先关掉再交给引擎。
          // 屏幕上暂时停留在最后一帧，引擎约 0.3 秒就接上。
          streamRef.current?.getTracks().forEach((t) => t.stop())
          streamRef.current = null
          xr = new XrStage(XR8, xrHostRef.current!, field, gyro!.camera, {
            onReady: (resumed) => {
              diag('xr.ready', { resumed })
              if (disposed) return
              if (resumed) {
                setResuming(false)
                showChip(t.camera.realigned)
                return
              }
              gyro?.dispose()
              gyro = null
              video.srcObject = null
              setTracking('ar')
              setGyroOff(false)
              showChip(t.camera.arReady)
            },
            onFail: (reason) => {
              diag('xr.fallback', reason)
              if (disposed) return
              // 系统相机已经关了，重新打开，退回只跟踪转动的普通模式。
              xrOff.current = true
              setResuming(false)
              setTracking('gyro')
              setAttempt((n) => n + 1)
              showChip(t.camera.arFailed, 4000)
            },
            onTracking: (ok) => setLimited(!ok),
            onResuming: () => setResuming(true),
          })
        },
        (e) => {
          diag('xr.loadFailed', String(e))
          if (!disposed) setTracking('gyro')
        },
      )
    }

    // ?debug：把相机和 AR 的状态定时发回电脑，真机出问题时不用用户操作就能看到卡在哪一步
    const stopDiag = DEBUG ? startDiagReports(video, () => streamRef.current, () => ({ gyroFrames: gyro?.frames ?? null, xr: xr?.diagState() ?? null, fps: field.fps, flowers: field.meadow.stats.flowers })) : () => {}

    const debugTimer = DEBUG
      ? window.setInterval(() => {
          const s = field.meadow.stats
          const info = (xr?.renderer ?? gyro?.renderer)?.info.render
          fpsSamples.current.push(field.fps)
          setDebug(
            `版本 ${__BUILD__} · ${field.fps} fps · 花 ${s.flowers} · 草 ${s.blades} · 三角形 ${Math.round((info?.triangles ?? 0) / 1000)}k / 上限 ${Math.round(field.meadow.maxTris / 1000)}k · 绘制 ${info?.calls ?? 0} 次`,
          )
          setHasFlowers(field.hasFlowers)
        }, 1000)
      : 0

    return () => {
      disposed = true
      detach()
      clearTimeout(gyroTimer)
      clearInterval(debugTimer)
      window.removeEventListener('resize', onResize)
      video.removeEventListener('resize', onResize)
      video.removeEventListener('loadedmetadata', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      input.removeEventListener('pointerdown', onTouch)
      stopDiag()
      snapRef.current = null
      tracker.dispose()
      xr?.dispose()
      gyro?.dispose()
      fieldRef.current = null
    }
  }, [state])

  const update = (patch: Partial<FieldSettings>) => {
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    fpsSamples.current = []
    const field = fieldRef.current
    if (!field) return
    field.settings = next
    if (patch.grass != null) field.setGrass(patch.grass)
  }
  const undo = () => {
    fieldRef.current?.undo()
    setHasFlowers(fieldRef.current?.hasFlowers ?? false)
  }
  const clear = () => {
    fieldRef.current?.clear()
    setHasFlowers(false)
  }
  // 拍照：截下当前画面，弹出预览。照片只在手机上，不上传。
  const takePhoto = async () => {
    const snap = snapRef.current
    if (!snap || shootingRef.current) return
    shootingRef.current = true
    setFlash(true)
    window.setTimeout(() => setFlash(false), 260)
    try {
      let blob = await snap().catch(() => null)
      if (blob && digitalRef.current > 1.01) blob = await cropCenter(blob, digitalRef.current).catch(() => blob)
      if (!blob) {
        showChip(t.camera.shotFailed)
        return
      }
      const file = new File([blob], `${t.camera.photoName}-${stamp()}.jpg`, { type: 'image/jpeg' })
      setPhoto({ url: URL.createObjectURL(blob), file })
    } finally {
      shootingRef.current = false
    }
  }
  // 保存：能用系统分享面板就用（里面有“存储图像”），不能就下载；长按预览图也能存
  const savePhoto = async () => {
    if (!photo) return
    const data = { files: [photo.file] }
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data)
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    const a = document.createElement('a')
    a.href = photo.url
    a.download = photo.file.name
    a.click()
  }
  const closePhoto = () => {
    if (photo) URL.revokeObjectURL(photo.url)
    setPhoto(null)
  }

  const sendDebug = async () => {
    const field = fieldRef.current
    if (!field || sent) return
    const samples = fpsSamples.current.slice(3).filter((v) => v > 0)
    const sorted = [...samples].sort((a, b) => a - b)
    setSent(true)
    // 测试版：附一张当前画面的截图（只发到本机的测试服务器）
    let shot: string | null = null
    if (DEBUG && snapRef.current) {
      const blob = await snapRef.current().catch(() => null)
      if (blob) {
        const r = await fetch('/api/lab-shot', { method: 'POST', body: blob }).catch(() => null)
        shot = r?.ok ? ((await r.json().catch(() => null))?.file ?? null) : null
      }
    }
    const report = {
      kind: 'camera',
      build: __BUILD__,
      shot,
      mode: tracking,
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      preset: settings.preset,
      arrangement: settings.arrangement,
      density: settings.density,
      grass: settings.grass,
      brush: settings.brush,
      stems: settings.stemMode,
      scene: settings.scene,
      stats: field.meadow.stats,
      maxTris: field.meadow.maxTris,
      fps: {
        seconds: samples.length,
        avg: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null,
        min: sorted[0] ?? null,
        median: sorted[Math.floor(sorted.length / 2)] ?? null,
        samples,
      },
    }
    const res = await fetch('/api/lab-report', { method: 'POST', body: JSON.stringify(report) }).catch(() => null)
    showChip(res?.ok ? `已发送（${samples.length} 秒的数据${shot ? '和一张截图' : ''}）` : '发送失败')
    fpsSamples.current = []
    window.setTimeout(() => setSent(false), 2000)
  }

  return (
    <main className="camera">
      <video ref={videoRef} playsInline muted autoPlay className={tracking === 'ar' ? 'off' : ''} />
      <canvas ref={canvasRef} className={`flower-layer${tracking === 'ar' ? ' off' : ''}`} />
      <div ref={xrHostRef} className="xr-host" />
      <div ref={inputRef} className="input-layer" />
      <header className="camera-top">
        <button className="ghost" onClick={onExit} aria-label={t.camera.backLabel}>
          {t.camera.back}
        </button>
        {tracking === 'loading' && <span className="top-note">{t.camera.loadingAr}</span>}
        {tracking === 'ar' && resuming && <span className="top-note">{t.camera.resuming}</span>}
        {tracking === 'ar' && !resuming && limited && <span className="top-note">{t.camera.limited}</span>}
        {tracking === 'gyro' && gyroOff && <span className="top-note">{t.camera.gyroOff}</span>}
      </header>
      {DEBUG && <p className="debug-line">{debug || '…'}</p>}
      {state === 'starting' && <p className="camera-note">{t.camera.opening}</p>}
      {state === 'error' && (
        <div className="camera-error" role="alert">
          <p>{error}</p>
          <button className="cta" onClick={() => setAttempt((n) => n + 1)}>
            {t.camera.retry}
          </button>
        </div>
      )}
      {chip && <p className="camera-chip">{chip}</p>}
      {flash && <div className="flash" />}
      {photo && (
        <div className="photo-sheet" role="dialog" aria-label={t.camera.photoLabel}>
          <img src={photo.url} alt={t.camera.photoAlt} />
          <p>{t.camera.longPress}</p>
          <div className="photo-actions">
            <button className="ghost" onClick={closePhoto}>
              {t.camera.keepShooting}
            </button>
            <button className="cta" onClick={savePhoto}>
              {t.camera.save}
            </button>
          </div>
        </div>
      )}
      {state === 'live' && (
        <footer className="toolbar">
          {hint && <p className="camera-hint">{t.camera.hint}</p>}
          {panelOpen && (
            <div className="panel-rows">
              <div className="panel-row">
                <Seg<PaletteName> label={t.labels.palette} options={PALETTES} names={t.presets} value={settings.preset} onChange={(preset) => update({ preset })} />
              </div>
              {settings.preset === '单种' && (
                <div className="panel-row">
                  <Seg<SpeciesId> label={t.labels.single} options={SINGLE_SPECIES} names={t.species} value={settings.single} onChange={(single) => update({ single })} />
                </div>
              )}
              <div className="panel-row">
                <Seg<SceneKind> label={t.labels.scene} options={['地面', '桌面']} names={t.scenes} value={settings.scene} onChange={(scene) => update({ scene })} />
                <Seg<PinchTarget> label={t.labels.zoom} options={['花朵', '画面']} names={t.zoomTargets} value={pinchTarget} onChange={(v) => { pinchRef.current = v; setPinchTarget(v) }} />
              </div>
              <div className="panel-row">
                <Seg<BrushKind> label={t.labels.brush} options={['花片', '小簇']} names={t.brushes} value={settings.brush} onChange={(brush) => update({ brush })} />
                <Seg<'有' | '无'> label={t.labels.grass} options={['有', '无']} names={t.grass} value={settings.grass ? '有' : '无'} onChange={(v) => update({ grass: v === '有' })} />
              </div>
              <div className="panel-row">
                <Seg<StemMode> label={t.labels.stems} options={STEMS} names={t.stems} value={settings.stemMode} onChange={(stemMode) => update({ stemMode })} />
                <Seg<DensityName> label={t.labels.density} options={Object.keys(DENSITY) as DensityName[]} names={t.density} value={settings.density} onChange={(density) => update({ density })} />
              </div>
            </div>
          )}
          <div className="actions">
            <div className="actions-side">
              <button className="ghost" onClick={undo} disabled={!hasFlowers}>
                {t.camera.undo}
              </button>
              <button className="ghost" onClick={clear} disabled={!hasFlowers}>
                {t.camera.clear}
              </button>
            </div>
            <button className="shutter" onClick={takePhoto} aria-label={t.camera.shutter} />
            <div className="actions-side right">
              {DEBUG && (
                <button className="ghost" onClick={sendDebug} disabled={sent}>
                  {sent ? t.camera.sent : t.camera.send}
                </button>
              )}
              <button className="ghost" onClick={() => setPanelOpen((v) => !v)}>
                {panelOpen ? t.camera.hide : t.camera.settings}
              </button>
            </div>
          </div>
          {tracking === 'ar' && (
            <p className="legal">
              {t.camera.legal[0]}
              <a href="/xr/LICENSE" target="_blank" rel="noreferrer">{t.camera.legal[1]}</a>
              {t.camera.legal[2]}
            </p>
          )}
        </footer>
      )}
    </main>
  )
}
