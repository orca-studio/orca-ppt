// @vitest-environment jsdom
import { resetTestStorage } from './test-storage.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, readLayout, writeLayout } from './layout.js'

beforeEach(resetTestStorage)

describe('界面偏好', () => {
  it('默认:缩略图导航、右栏开着、不看片台', () => {
    expect(readLayout()).toEqual({ nav: 'thumbs', maker: true, lightTable: false })
  })

  it('改了记得住 —— 每次开应用都要重调的设置等于没有', () => {
    writeLayout({ nav: 'outline', maker: false, lightTable: true })
    expect(readLayout()).toEqual({ nav: 'outline', maker: false, lightTable: true })
  })

  it('不认识的 nav 值回到默认,不让左栏空一块', () => {
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: '看片台' }))
    expect(readLayout().nav).toBe('thumbs')
  })

  it('存的不是 JSON 也不炸', () => {
    localStorage.setItem('orca-ppt.layout', '{{{')
    expect(readLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('只存了一部分时,其余走默认', () => {
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ maker: false }))
    expect(readLayout()).toEqual({ ...DEFAULT_LAYOUT, maker: false })
  })
})
