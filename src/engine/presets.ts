import type { SpeciesId } from './species'
import type { Arrangement } from './meadow'

export type PresetName = '月夜' | '春日' | '花田' | '盛放'
export const PRESETS: Record<PresetName, SpeciesId[]> = {
  月夜: ['nemophila', 'hydrangea', 'lily'],
  春日: ['cosmos', 'daisy', 'golden', 'freesia'], // golden 是向日葵
  花田: ['nemophila', 'hydrangea', 'daisy', 'lily', 'cosmos', 'golden', 'freesia', 'tulipBlush'],
  盛放: ['ranunculus', 'tulip', 'rose'], // 浓烈的颜色：绯红、橙、珊瑚、洋红、黄、杏色的毛茛和郁金香，加红玫瑰
}

export type DensityName = '低' | '中' | '高'
/** 每平方米的花数、草叶数 */
export const DENSITY: Record<DensityName, { flowers: number; grass: number }> = {
  // 种花时会跳过花头相撞的位置，实际种下的比这少一些，所以数字定得高一点
  低: { flowers: 50, grass: 300 },
  中: { flowers: 120, grass: 800 },
  高: { flowers: 200, grass: 1500 },
}

export type BrushKind = '花片' | '小簇'
/** 点一下开多大、滑动的花带多宽（半径、半宽，米）；sky 是天空里点一下开几朵、散开多大（占屏幕短边的比例） */
export const BRUSH: Record<BrushKind, { radius: number; band: number; skyCount: number; skySpread: number }> = {
  花片: { radius: 1.5, band: 0.55, skyCount: 36, skySpread: 0.32 },
  小簇: { radius: 0.24, band: 0.2, skyCount: 5, skySpread: 0.07 },
}

export type { Arrangement }
