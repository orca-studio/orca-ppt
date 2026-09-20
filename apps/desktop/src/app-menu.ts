import type { MenuItemConstructorOptions } from 'electron'

/**
 * 应用菜单。
 *
 * 不自建的话用的是 Electron 的默认菜单 —— 里面处处写着 Electron,而且没有我们自己的
 * 动作。macOS 上最左边那个菜单的名字取自 `app.name`,所以那个也要设。
 *
 * 菜单只是**另一个触发器**:它发出的动作和顶栏按钮走同一条协议方法,不另开一条路。
 */
export type MenuAction = 'open' | 'present' | 'toggle-nav'

export interface MenuOptions {
  appName: string
  isMac: boolean
  /** 没有打开的稿子时,放映应该是灰的。 */
  canPresent: boolean
  send: (action: MenuAction) => void
}

export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { appName, isMac, canPresent, send } = options

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: 'about', label: `关于 ${appName}` },
            { type: 'separator' },
            { role: 'hide', label: `隐藏 ${appName}` },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: `退出 ${appName}` },
          ],
        },
      ]
    : []

  return [
    ...appMenu,
    {
      label: '文件',
      submenu: [
        { label: '打开 deck 目录…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    {
      // 输入框要能复制粘贴 —— 自建菜单之后这些 role 得自己摆回来,
      // 少了它们 ⌘C / ⌘V 在应用里就失效了。
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '放映',
      submenu: [
        {
          label: '全屏放映',
          accelerator: 'CmdOrCtrl+Alt+P',
          enabled: canPresent,
          click: () => send('present'),
        },
      ],
    },
    {
      label: '显示',
      submenu: [
        {
          // macOS 上侧栏开关的惯用键位
          label: '显示/隐藏页胶片',
          accelerator: 'Control+Cmd+S',
          click: () => send('toggle-nav'),
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
  ]
}
