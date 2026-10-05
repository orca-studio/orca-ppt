// @vitest-environment jsdom
import { resetTestStorage } from './test-storage.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, nextTheme, readTheme, THEME_LABEL } from './theme.js'

beforeEach(() => {
  resetTestStorage()
  document.documentElement.removeAttribute('data-theme')
})

describe('主题', () => {
  it('默认跟随系统 —— 桌面应用不该自己决定屏幕是亮是暗', () => {
    expect(readTheme()).toBe('system')
  })

  it('跟随系统时不写 data-theme,交给 prefers-color-scheme', () => {
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('显式选过就写上,并且记得住', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(readTheme()).toBe('dark')
  })

  it('从深色切回跟随系统会把属性清掉', () => {
    applyTheme('dark')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('存了垃圾值就当没选过', () => {
    localStorage.setItem('orca-ppt.theme', '霓虹')
    expect(readTheme()).toBe('system')
  })

  it('轮换:跟随系统 → 浅 → 深 → 跟随系统', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })

  it('三个都有中文标签', () => {
    for (const label of Object.values(THEME_LABEL)) expect(label.length).toBeGreaterThan(0)
  })
})
