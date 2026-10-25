import { describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, type MenuAction } from './app-menu.js'

const build = (over: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) =>
  buildMenuTemplate({
    appName: 'Orca PPT',
    isMac: true,
    canPresent: true,
    theme: 'system',
    send: vi.fn(),
    ...over,
  })

const labels = (template: ReturnType<typeof buildMenuTemplate>) =>
  template.map((item) => item.label)

describe('应用菜单', () => {
  it('macOS 上第一个菜单是应用名 —— 不自建就是 Electron', () => {
    expect(labels(build())[0]).toBe('Orca PPT')
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

  it('⌘Z / ⇧⌘Z 发动作而不是 role —— 壳看焦点决定撤打字还是撤改字', () => {
    const sent: MenuAction[] = []
    const edit = build({ send: (action) => sent.push(action) }).find(
      (item) => item.label === '编辑',
    )!.submenu as Array<{ label?: string; accelerator?: string; role?: string; click?: () => void }>
    const undo = edit.find((item) => item.label === '撤销')!
    const redo = edit.find((item) => item.label === '重做')!
    expect(undo.accelerator).toBe('CmdOrCtrl+Z')
    expect(redo.accelerator).toBe('Shift+CmdOrCtrl+Z')
    undo.click!()
    redo.click!()
    expect(sent).toEqual(['undo', 'redo'])
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

  it('文件菜单里有导出 PPTX;没有稿子、正在导出时是灰的', () => {
    const item = (over: Parameters<typeof build>[0]) =>
      (
        build(over).find((menu) => menu.label === '文件')!.submenu as Array<{
          label?: string
          enabled?: boolean
        }>
      ).find((entry) => entry.label?.includes('PPTX'))!
    expect(item({})).toMatchObject({ label: '导出 PPTX…', enabled: true })
    expect(item({ canPresent: false }).enabled).toBe(false)
    expect(item({ exporting: true })).toMatchObject({ label: '正在导出 PPTX…', enabled: false })
  })

  it('没有稿子时放映和自动播放都是灰的;演示模式不灰,勾选跟着状态', () => {
    const present = (state: Record<string, unknown>) =>
      build(state).find((item) => item.label === '放映')!.submenu as Array<{
        label?: string
        enabled?: boolean
        checked?: boolean
      }>
    const off = present({ canPresent: false }).filter((item) => item.label)
    expect(off.map((item) => item.enabled)).toEqual([false, false, undefined])
    expect(off.at(-1)).toMatchObject({ label: '演示模式', checked: false })
    expect(present({ demo: true }).at(-1)).toMatchObject({ label: '演示模式', checked: true })
  })

  it('主题在菜单里,当前那一项打勾 —— 偏好不该占工具栏', () => {
    const view = build({ theme: 'dark' }).find((item) => item.label === '显示')!.submenu as Array<{
      label?: string
      submenu?: Array<{ label?: string; checked?: boolean }>
    }>
    const appearance = view.find((item) => item.label === '外观')!.submenu!
    expect(appearance.map((item) => item.label)).toEqual(['跟随系统', '浅色', '深色'])
    expect(appearance.find((item) => item.checked)?.label).toBe('深色')
  })

  it('快捷键写的是 CmdOrCtrl,不写死一个平台', () => {
    const file = build().find((item) => item.label === '文件')!.submenu as Array<{
      accelerator?: string
    }>
    expect(file[0]!.accelerator).toBe('CmdOrCtrl+O')
  })
})

describe('帮助', () => {
  it('连接 AI 助手在菜单里 —— 那是设置,不该常驻在工作面板上', () => {
    const sent: string[] = []
    const template = buildMenuTemplate({
      appName: 'Orca PPT',
      isMac: true,
      canPresent: true,
      theme: 'system',
      send: (action) => sent.push(action),
    })
    const help = template.find((item) => item.label === '帮助')!.submenu as Array<{
      label?: string
      click?: () => void
    }>
    help[0]!.click!()
    expect(sent).toEqual(['connect-agent'])
  })
})
