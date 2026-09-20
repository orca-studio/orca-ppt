import { describe, expect, it } from 'vitest'
import { desktopSafePath, resolveExecutable } from './path.js'

describe('desktopSafePath', () => {
  it('补上常规用户位置', () => {
    const path = desktopSafePath({ PATH: '/usr/bin' })
    expect(path).toContain('/usr/bin')
    expect(path.split(':').length).toBeGreaterThan(1)
  })

  it('不重复同一个目录', () => {
    const parts = desktopSafePath({ PATH: '/usr/bin:/usr/bin' }).split(':')
    expect(new Set(parts).size).toBe(parts.length)
  })

  it('PATH 缺席也能工作', () => {
    expect(desktopSafePath({}).length).toBeGreaterThan(0)
  })
})

describe('resolveExecutable', () => {
  it('找不到就返回 undefined,不抛', () => {
    expect(resolveExecutable('orca-ppt-nonexistent-binary')).toBeUndefined()
  })
})
