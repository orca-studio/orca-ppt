// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { readNavOpen, writeNavOpen } from './layout.js'

beforeEach(() => localStorage.clear())

describe('左栏开合', () => {
  it('默认开着', () => {
    expect(readNavOpen()).toBe(true)
  })

  it('收起之后记得住 —— 每次开应用都要再点一次的开关等于没有', () => {
    writeNavOpen(false)
    expect(readNavOpen()).toBe(false)
  })

  it('再打开也记得住', () => {
    writeNavOpen(false)
    writeNavOpen(true)
    expect(readNavOpen()).toBe(true)
  })

  it('存了垃圾值当成开着,不至于让界面空一块', () => {
    localStorage.setItem('orca-ppt.nav', '???')
    expect(readNavOpen()).toBe(true)
  })
})
