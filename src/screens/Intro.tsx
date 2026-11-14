import { useEffect, useMemo, useRef, useState } from 'react'
import { brushButton } from '../art/watercolor'
import { WatercolorMeadow } from '../art/wcMeadow'
import { useI18n } from '../lib/i18n'

interface Props {
  onStart: () => void
  starting: boolean
}

export function Intro({ onStart, starting }: Props) {
  const { lang, t, setLang } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const meadowRef = useRef<WatercolorMeadow | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [painted, setPainted] = useState(false)
  const [plainTitle, setPlainTitle] = useState(false)
  const button = useMemo(() => brushButton(472, 116, '#6d88d6', '#2f4aa6'), [])

  useEffect(() => {
    const meadow = new WatercolorMeadow(canvasRef.current!, titleRef.current, lang)
    meadowRef.current = meadow
    meadow.onPainted = () => setPainted(true)
    meadow.onPlainTitle = () => setPlainTitle(true)
    return () => meadow.dispose()
    // 换语言时只重画标题（下面那个 effect），不重开整幅画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    meadowRef.current?.setLang(lang)
  }, [lang])

  return (
    <main className={`intro${painted ? ' painted' : ''}${plainTitle ? ' plain' : ''}`}>
      <canvas ref={canvasRef} className="meadow" aria-hidden="true" />
      <button className="lang-switch" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} aria-label={t.switchLabel}>
        {t.switchTo}
      </button>
      <section className="intro-text">
        <p className="eyebrow">{t.intro.eyebrow}</p>
        {/* 标题是手写的，画在水彩纸上；这里的文字留给读屏，以及画不出来时备用 */}
        <h1 ref={titleRef}>{t.intro.title}</h1>
        {/* 副标题是另一种语言的名字：中文页下面写英文，英文页下面写中文 */}
        <p className="en" lang={lang === 'zh' ? 'en' : 'zh-CN'}>
          {t.intro.subtitle}
        </p>
        <p className="lead">
          {t.intro.lead[0]}
          <br />
          {t.intro.lead[1]}
        </p>
        <button className="cta" style={{ backgroundImage: `url(${button})` }} onClick={onStart} disabled={starting}>
          {starting ? t.intro.starting : t.intro.start}
        </button>
        <p className="fine">
          {t.intro.fine[0]}
          <br />
          {t.intro.fine[1]}
        </p>
      </section>
    </main>
  )
}
