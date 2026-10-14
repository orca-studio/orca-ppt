import { describe, expect, it } from 'vitest'
import { pptxSummary } from './pptx-summary.js'

const base = { path: '/tmp/a.pptx', slides: 7, degraded: [], lost: [], rasters: 0, fonts: [] }

describe('导出 PPTX 之后说的话', () => {
  it('都保真时说清楚和网页一样', () => {
    expect(pptxSummary(base)).toEqual({
      message: '已导出 PPTX(7 页)',
      detail: '每次翻页都和网页一样。',
    })
  })

  it('降级逐条说出 PowerPoint 里实际用的转场', () => {
    const { detail } = pptxSummary({
      ...base,
      degraded: [{ from: 3, to: 4, technique: '整页推近', tier: '降级', kind: 'fade' }],
    })
    expect(detail).toContain('第 3→4 页  整页推近  → 淡入淡出')
  })

  it('导不出来的效果按效果归在一起,页号连成段', () => {
    const rhythm = '新元素「等主角落定再出现」的节奏'
    const { detail } = pptxSummary({
      ...base,
      lost: [2, 3, 4, 6].map((slide) => ({ slide, items: [rhythm] })),
      fonts: ['Inter', 'Noto Sans SC'],
    })
    expect(detail).toContain(`第 2–4、6 页  ${rhythm}`)
    expect(detail).toContain('打开它的电脑要装:Inter、Noto Sans SC')
  })
})
