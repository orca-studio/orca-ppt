// @vitest-environment jsdom
import { resetTestStorage } from './test-storage.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, readLayout, writeLayout } from './layout.js'

beforeEach(resetTestStorage)

describe('界面偏好', () => {
  it('默认:左栏开着', () => {
    expect(readLayout()).toEqual({ nav: true })
  })

  it('改了记得住 —— 每次开应用都要重调的设置等于没有', () => {
    writeLayout({ nav: false })
    expect(readLayout()).toEqual({ nav: false })
  })

  it('旧版存的三档:只有 off 是收起,别的旧字段不管', () => {
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: 'off' }))
    expect(readLayout().nav).toBe(false)
    localStorage.setItem(
      'orca-ppt.layout',
      JSON.stringify({ nav: 'outline', maker: false, lightTable: true }),
    )
    expect(readLayout()).toEqual({ nav: true })
  })

  it('存的不是 JSON 也不炸', () => {
    localStorage.setItem('orca-ppt.layout', '{{{')
    expect(readLayout()).toEqual(DEFAULT_LAYOUT)
  })
})
