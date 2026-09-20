import { describe, expect, it } from 'vitest'
import { cropUrl, toAnchor } from './anchors.js'
import type { PickedAnchor } from './Stage.js'
import { useAssetOrigin } from './assets.js'

const picked: PickedAnchor = {
  slide: 3,
  selector: 'h2',
  box: { x: 180, y: 220, w: 1560, h: 120 },
  viewportBox: { x: 90, y: 110, w: 780, h: 60 },
  text: '增长的三个来源',
}

describe('toAnchor', () => {
  it('视口坐标不进契约 —— agent 要的是设计坐标', () => {
    const anchor = toAnchor(picked, '这儿太挤')
    expect(anchor).not.toHaveProperty('viewportBox')
    expect(anchor).toMatchObject({ kind: 'element', slide: 3, box: { x: 180, y: 220 } })
  })

  it('带上用户写的那句话', () => {
    expect(toAnchor(picked, '这儿太挤').note).toBe('这儿太挤')
  })

  it('有裁切图时带上路径', () => {
    const anchor = toAnchor(picked, '', '/data/anchors/a.png')
    expect((anchor as { crop?: string }).crop).toBe('/data/anchors/a.png')
  })

  it('没截到图就不带 —— 锚本身仍然成立', () => {
    expect((toAnchor(picked, '') as { crop?: string }).crop).toBeUndefined()
  })
})

describe('cropUrl', () => {
  it('本机预览地址', () => {
    useAssetOrigin('ws://127.0.0.1:6722')
    expect(cropUrl('/a/b.png')).toBe('http://127.0.0.1:6722/asset/a/b.png')
    expect(cropUrl(undefined)).toBeUndefined()
  })
})
