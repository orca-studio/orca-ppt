// @vitest-environment jsdom
import { resetTestStorage } from './test-storage.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, INSPECTOR_MAX, INSPECTOR_MIN, readLayout, writeLayout } from './layout.js'

beforeEach(resetTestStorage)

describe('界面偏好', () => {
  it('默认:左栏开着,右栏收起,右栏宽度按窗口走', () => {
    expect(readLayout()).toEqual({ nav: true, inspector: false, inspectorWidth: null })
  })

  it('右栏手动打开后记得住', () => {
    writeLayout({ nav: true, inspector: true, inspectorWidth: null })
    expect(readLayout().inspector).toBe(true)
  })

  it('旧版存的右栏开关不认:那时 true 是默认值,不是用户选的', () => {
    localStorage.setItem(
      'orca-ppt.layout',
      JSON.stringify({ nav: false, inspector: true, inspectorWidth: 420 }),
    )
    expect(readLayout()).toEqual({ nav: false, inspector: false, inspectorWidth: 420 })
  })

  it('改了记得住 —— 每次开应用都要重调的设置等于没有', () => {
    writeLayout({ nav: false, inspector: false, inspectorWidth: 420 })
    expect(readLayout()).toEqual({ nav: false, inspector: false, inspectorWidth: 420 })
  })

  it('存的宽度超出范围就夹回去,不是数字就当没拖过', () => {
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: true, inspectorWidth: 9999 }))
    expect(readLayout().inspectorWidth).toBe(INSPECTOR_MAX)
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: true, inspectorWidth: 10 }))
    expect(readLayout().inspectorWidth).toBe(INSPECTOR_MIN)
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: true, inspectorWidth: 'wide' }))
    expect(readLayout().inspectorWidth).toBeNull()
  })

  it('旧版存的三档:只有 off 是收起,别的旧字段不管', () => {
    localStorage.setItem('orca-ppt.layout', JSON.stringify({ nav: 'off' }))
    expect(readLayout().nav).toBe(false)
    localStorage.setItem(
      'orca-ppt.layout',
      JSON.stringify({ nav: 'outline', maker: false, lightTable: true }),
    )
    expect(readLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('存的不是 JSON 也不炸', () => {
    localStorage.setItem('orca-ppt.layout', '{{{')
    expect(readLayout()).toEqual(DEFAULT_LAYOUT)
  })
})
