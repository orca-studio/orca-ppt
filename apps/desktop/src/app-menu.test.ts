import { describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, type MenuAction } from './app-menu.js'

const build = (over: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) =>
  buildMenuTemplate({ appName: 'OrcaPPT', isMac: true, canPresent: true, send: vi.fn(), ...over })

const labels = (template: ReturnType<typeof buildMenuTemplate>) =>
  template.map((item) => item.label)

describe('应用菜单', () => {
  it('macOS 上第一个菜单是应用名 —— 不自建就是 Electron', () => {
    expect(labels(build())[0]).toBe('OrcaPPT')
  })

  it('非 macOS 没有应用菜单,退出放进文件', () => {
    const template = build({ isMac: false })
    expect(labels(template)[0]).toBe('文件')
    const file = template[0]!.submenu as Array<{ role?: string }>
    expect(file.some((item) => item.role === 'quit')).toBe(true)
  })

  it('保留编辑的复制粘贴 —— 自建菜单之后这些 role 得自己摆回来', () => {
    const edit = build().find((item) => item.label === '编辑')!.submenu as Array<{ role?: string }>
    for (const role of ['copy', 'paste', 'cut', 'selectAll']) {
      expect(edit.some((item) => item.role === role)).toBe(true)
    }
  })

  it('打开和放映各自发一个动作', () => {
    const sent: MenuAction[] = []
    const template = build({ send: (action) => sent.push(action) })
    const click = (menu: string, label: string) => {
      const items = template.find((item) => item.label === menu)!.submenu as Array<{
        label?: string
        click?: () => void
      }>
      items.find((item) => item.label === label)!.click!()
    }
    click('文件', '打开 deck 目录…')
    click('放映', '全屏放映')
    expect(sent).toEqual(['open', 'present'])
  })

  it('没有稿子时放映是灰的', () => {
    const present = build({ canPresent: false }).find((item) => item.label === '放映')!
      .submenu as Array<{ enabled?: boolean }>
    expect(present[0]!.enabled).toBe(false)
  })

  it('快捷键写的是 CmdOrCtrl,不写死一个平台', () => {
    const file = build().find((item) => item.label === '文件')!.submenu as Array<{
      accelerator?: string
    }>
    expect(file[0]!.accelerator).toBe('CmdOrCtrl+O')
  })
})
