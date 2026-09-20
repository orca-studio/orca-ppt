import { describe, expect, it } from 'vitest'
import { paddedRect } from './anchor-crop.js'

const viewport = { w: 1000, h: 600 }

describe('paddedRect', () => {
  it('往外扩一圈,让 agent 看得见元素周围的版面', () => {
    expect(paddedRect({ x: 200, y: 200, w: 100, h: 50 }, viewport, 20)).toEqual({
      x: 180,
      y: 180,
      w: 140,
      h: 90,
    })
  })

  it('贴边的元素收进视口,不给负坐标', () => {
    expect(paddedRect({ x: 5, y: 2, w: 100, h: 50 }, viewport, 20)).toEqual({
      x: 0,
      y: 0,
      w: 125,
      h: 72,
    })
  })

  it('超出视口的部分裁掉', () => {
    const rect = paddedRect({ x: 950, y: 560, w: 100, h: 100 }, viewport, 20)
    expect(rect.x + rect.w).toBeLessThanOrEqual(viewport.w)
    expect(rect.y + rect.h).toBeLessThanOrEqual(viewport.h)
  })

  it('零尺寸的元素也给得出一块可截的区域', () => {
    const rect = paddedRect({ x: 10, y: 10, w: 0, h: 0 }, viewport, 0)
    expect(rect.w).toBeGreaterThan(0)
    expect(rect.h).toBeGreaterThan(0)
  })

  it('小数坐标取整 —— capturePage 只接受整数', () => {
    const rect = paddedRect({ x: 10.6, y: 10.2, w: 30.7, h: 20.4 }, viewport, 0)
    for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true)
  })
})
