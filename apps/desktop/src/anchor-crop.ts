export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 锚的裁切图要**带上下文** —— 只截那个元素本身,agent 看到的是一块孤立的字,判断不了
 * 它在版面里挤不挤。所以往外扩一圈,再收进视口。
 */
export function paddedRect(box: Rect, viewport: { w: number; h: number }, pad = 48): Rect {
  const left = Math.max(0, Math.round(box.x) - pad)
  const top = Math.max(0, Math.round(box.y) - pad)
  const right = Math.min(viewport.w, Math.round(box.x + box.w) + pad)
  const bottom = Math.min(viewport.h, Math.round(box.y + box.h) + pad)

  return {
    x: left,
    y: top,
    // capturePage 对零宽零高的区域会失败,给一个最小尺寸。
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  }
}
