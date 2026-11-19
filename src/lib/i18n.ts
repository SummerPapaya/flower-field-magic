// 界面文字：中文和英文。默认跟随手机的系统语言（只要是中文就用中文，其他都用英文），
// 开场页右上角可以切换，选过的记在手机上。地址加 ?lang=en 或 ?lang=zh 可以直接指定。
import { createContext, useContext } from 'react'
import type { SpeciesId } from '../engine/species'

export type Lang = 'zh' | 'en'

const KEY = 'flower-lang'

export function detectLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang')
  if (q === 'en' || q === 'zh') return q
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    // 无痕模式等读不到，就按系统语言
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  return langs.some((l) => /^zh\b/i.test(l)) ? 'zh' : 'en'
}

export function saveLang(lang: Lang) {
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // 存不了就只在这次有效
  }
}

/** 网页本身的语言、标题和简介跟着换 */
export function applyDocumentLang(lang: Lang) {
  const s = STRINGS[lang]
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = s.docTitle
  document.querySelector('meta[name="description"]')?.setAttribute('content', s.description)
}

const zh = {
  docTitle: '花田魔法 · Flower Field Magic',
  description: '轻触屏幕，开出花海。举起手机相机点一下、划一道，花就开在你身边的真实地面上。打开网页就能玩，画面不会上传。',
  switchTo: 'EN',
  switchLabel: 'Switch to English',
  intro: {
    eyebrow: '魔法小屋 · Magic House',
    title: '花田魔法',
    subtitle: 'Flower Field Magic',
    lead: ['举起相机，点一下，划一道，', '花就在你视野里开成一片花田。'],
    start: '开始拍照',
    starting: '正在准备…',
    fine: ['需要使用相机和陀螺仪。', '画面只在你的手机上处理，不会上传。'],
  },
  camera: {
    back: '‹ 返回',
    backLabel: '返回',
    loadingAr: '正在准备 AR：现在走动时花会跟着你，准备好就能固定在地上',
    resuming: '正在重新对准…',
    limited: '正在认地面：慢慢移动手机',
    gyroOff: '陀螺仪没开：花不会跟着手机转动',
    opening: '正在打开相机…',
    retry: '重试',
    hint: '点一下开一片，划一道开一条花带',
    realigned: '已重新对准，位置可能有些偏差',
    arReady: '花已经固定在地上了，可以走动看看',
    arFailed: 'AR 暂时用不了，已切换到普通模式',
    newSize: (k: string) => `新开的花：${k}×`,
    viewZoom: (z: string) => `画面：${z}×`,
    shotFailed: '没拍成，再试一次',
    photoLabel: '刚拍的照片',
    photoAlt: '刚拍的花田照片',
    longPress: '长按照片也可以存到相册',
    keepShooting: '继续拍',
    save: '保存 / 分享',
    shutter: '拍照',
    undo: '撤销',
    clear: '清空',
    send: '发送',
    sent: '已发送 ✓',
    hide: '收起',
    settings: '设置',
    legal: ['AR 追踪由 8th Wall Engine 提供，© 2026 Niantic Spatial, Inc.，按', '许可协议', '使用，不提供任何担保。'],
    photoName: '花田魔法',
  },
  labels: { palette: '花种', single: '只开', scene: '种在', zoom: '缩放', brush: '笔刷', grass: '草', stems: '茎叶', density: '密度' },
  presets: { 月夜: '月夜', 春日: '春日', 花田: '花田', 盛放: '盛放', 单种: '单种' },
  scenes: { 地面: '地面', 桌面: '桌面' },
  zoomTargets: { 花朵: '花朵', 画面: '画面' },
  brushes: { 花片: '花片', 小簇: '小簇' },
  grass: { 有: '有', 无: '无' },
  stems: { auto: '自动', always: '总是', never: '从不' },
  density: { 低: '低', 中: '中', 高: '高' },
  species: {
    nemophila: '喜林草', hydrangea: '绣球', daisy: '雏菊', lily: '铃兰', cosmos: '波斯菊', golden: '向日葵',
    freesia: '小苍兰', tulipBlush: '粉郁金香', ranunculus: '花毛茛', tulip: '郁金香', rose: '玫瑰',
  } as Record<SpeciesId, string>,
  errors: {
    notSecure: '当前页面不是 HTTPS，浏览器不允许使用相机。',
    notAllowed: '没有相机权限。请在浏览器设置里允许使用相机，然后重试。',
    notFound: '没有找到可用的相机。',
    notReadable: '相机正被其他 App 占用，请关掉它后重试。',
    other: (name: string) => `相机打开失败${name ? `（${name}）` : ''}，请重试。`,
  },
}

export type Strings = typeof zh

const en: Strings = {
  docTitle: 'Flower Field Magic · 花田魔法',
  description: 'Touch the screen and a sea of flowers blooms. Raise your phone’s camera, tap or swipe, and flowers bloom on the real ground around you. It runs right in the browser, and nothing is uploaded.',
  switchTo: '中文',
  switchLabel: '切换到中文',
  intro: {
    eyebrow: 'Magic House · 魔法小屋',
    title: 'Flower Field Magic',
    subtitle: '花田魔法',
    lead: ['Raise your camera, tap or swipe,', 'and a field of flowers blooms around you.'],
    start: 'Start',
    starting: 'Getting ready…',
    fine: ['Uses your camera and motion sensors.', 'Everything stays on your phone. Nothing is uploaded.'],
  },
  camera: {
    back: '‹ Back',
    backLabel: 'Back',
    loadingAr: 'Getting AR ready: flowers follow you for now and stay put once it’s ready',
    resuming: 'Realigning…',
    limited: 'Finding the ground: move your phone slowly',
    gyroOff: 'Motion sensors are off: flowers won’t turn with your phone',
    opening: 'Opening camera…',
    retry: 'Try again',
    hint: 'Tap to bloom a patch, swipe to paint a ribbon of flowers',
    realigned: 'Realigned. Flowers may have shifted a little',
    arReady: 'Flowers are planted now. Walk around them',
    arFailed: 'AR isn’t available right now. Switched to basic mode',
    newSize: (k: string) => `New flowers: ${k}×`,
    viewZoom: (z: string) => `View: ${z}×`,
    shotFailed: 'Couldn’t take the photo. Try again',
    photoLabel: 'Your photo',
    photoAlt: 'Photo of your flower field',
    longPress: 'You can also press and hold the photo to save it',
    keepShooting: 'Keep shooting',
    save: 'Save / Share',
    shutter: 'Take photo',
    undo: 'Undo',
    clear: 'Clear',
    send: 'Send',
    sent: 'Sent ✓',
    hide: 'Hide',
    settings: 'Settings',
    legal: ['AR tracking by 8th Wall Engine, © 2026 Niantic Spatial, Inc., used under its ', 'license', ', provided without warranty.'],
    photoName: 'flower-field-magic',
  },
  labels: { palette: 'Flowers', single: 'Only', scene: 'Plant on', zoom: 'Pinch', brush: 'Brush', grass: 'Grass', stems: 'Stems', density: 'Density' },
  presets: { 月夜: 'Moonlit', 春日: 'Spring', 花田: 'Meadow', 盛放: 'Bloom', 单种: 'Single' },
  scenes: { 地面: 'Ground', 桌面: 'Tabletop' },
  zoomTargets: { 花朵: 'Flowers', 画面: 'View' },
  brushes: { 花片: 'Patch', 小簇: 'Cluster' },
  grass: { 有: 'On', 无: 'Off' },
  stems: { auto: 'Auto', always: 'Always', never: 'Never' },
  density: { 低: 'Low', 中: 'Med', 高: 'High' },
  species: {
    nemophila: 'Baby blue eyes', hydrangea: 'Hydrangea', daisy: 'Daisy', lily: 'Lily of the valley', cosmos: 'Cosmos', golden: 'Sunflower',
    freesia: 'Freesia', tulipBlush: 'Pink tulip', ranunculus: 'Ranunculus', tulip: 'Tulip', rose: 'Rose',
  },
  errors: {
    notSecure: 'This page isn’t served over HTTPS, so the browser won’t allow the camera.',
    notAllowed: 'No camera permission. Allow camera access in your browser settings, then try again.',
    notFound: 'No camera was found.',
    notReadable: 'Another app is using the camera. Close it and try again.',
    other: (name: string) => `The camera couldn’t be opened${name ? ` (${name})` : ''}. Please try again.`,
  },
}

export const STRINGS: Record<Lang, Strings> = { zh, en }

export interface I18n {
  lang: Lang
  t: Strings
  setLang: (lang: Lang) => void
}

export const I18nContext = createContext<I18n>({ lang: 'zh', t: zh, setLang: () => {} })

export const useI18n = () => useContext(I18nContext)
