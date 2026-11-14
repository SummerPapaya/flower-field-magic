import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Intro } from './screens/Intro'
import { requestMotionPermission } from './lib/permissions'
import { I18nContext, STRINGS, applyDocumentLang, detectLang, saveLang, type Lang } from './lib/i18n'

// 相机页带着 three.js，单独成包：开场页先秒开，空闲时再预取相机页。
const loadCameraView = () => import('./screens/CameraView')
const CameraView = lazy(loadCameraView)

export default function App() {
  const [screen, setScreen] = useState<'intro' | 'camera'>('intro')
  const [starting, setStarting] = useState(false)
  const [lang, setLangState] = useState<Lang>(detectLang)
  const i18n = useMemo(() => ({ lang, t: STRINGS[lang], setLang: (l: Lang) => { saveLang(l); setLangState(l) } }), [lang])

  useEffect(() => applyDocumentLang(lang), [lang])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadCameraView()
      // AR 引擎约 2 MB，提前在后台下载，点“开始拍照”后能尽快把花固定在地上。
      void import('./engine/xrEngine').then((m) => {
        if (m.arSupported()) m.loadXrEngine().catch(() => {})
      })
    }, 800)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (import.meta.env.DEV) void import('./lib/devQr').then((m) => m.showDevQr('/?debug', '手机扫码打开（相机页）'))
  }, [])

  // 陀螺仪授权必须在这次点按里申请（iOS 的要求）。
  const start = async () => {
    setStarting(true)
    await requestMotionPermission()
    setStarting(false)
    setScreen('camera')
  }

  return (
    <I18nContext.Provider value={i18n}>
      {screen === 'intro' ? (
        <Intro onStart={start} starting={starting} />
      ) : (
        <Suspense fallback={<main className="camera"><p className="camera-note">{i18n.t.intro.starting}</p></main>}>
          <CameraView onExit={() => setScreen('intro')} />
        </Suspense>
      )}
    </I18nContext.Provider>
  )
}
