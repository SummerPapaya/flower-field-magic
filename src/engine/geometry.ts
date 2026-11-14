/** 平滑过渡：x 在 a 以下为 0，b 以上为 1，中间是 S 形曲线 */
export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
