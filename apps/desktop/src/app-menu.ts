import type { MenuItemConstructorOptions } from 'electron'

/**
 * 应用菜单。
 *
 * 不自建的话用的是 Electron 的默认菜单 —— 里面处处写着 Electron,而且没有我们自己的
 * 动作。macOS 上最左边那个菜单的名字取自 `app.name`,所以那个也要设。
 *
 * 菜单只是**另一个触发器**:它发出的动作和顶栏按钮走同一条协议方法,不另开一条路。
 */
export type MenuAction =
  | 'open'
  | 'export-pptx'
  | 'present'
  | 'toggle-nav'
  | 'toggle-inspector'
  | 'toggle-autoplay'
  | 'theme:system'
  | 'theme:light'
  | 'theme:dark'
  | 'connect-agent'
  | 'undo'
  | 'redo'

export interface MenuOptions {
  appName: string
  isMac: boolean
  /** 没有打开的稿子时,放映应该是灰的。 */
  canPresent: boolean
  /** 正在导出 PPTX。一次只导一份,导完之前菜单项是灰的。 */
  exporting?: boolean
  /** 当前主题,用来打勾。 */
  theme: 'system' | 'light' | 'dark'
  send: (action: MenuAction) => void
}

export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { appName, isMac, canPresent, exporting = false, theme, send } = options

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
        {
          label: exporting ? '正在导出 PPTX…' : '导出 PPTX…',
          accelerator: 'Shift+CmdOrCtrl+E',
          enabled: canPresent && !exporting,
          click: () => send('export-pptx'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: `退出 ${appName}` },
      ],
    },
    {
      // 输入框要能复制粘贴 —— 自建菜单之后这些 role 得自己摆回来,
      // 少了它们 ⌘C / ⌘V 在应用里就失效了。
      label: '编辑',
      submenu: [
        // 不用 role:⌘Z 在输入框里是撤销打字,在画布上是撤销改字 —— 壳看焦点决定。
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
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
        {
          // 自动播放是放映方式,不是全局动作 —— 所以在这儿,不在工具栏
          label: '自动播放',
          accelerator: 'CmdOrCtrl+Alt+A',
          enabled: canPresent,
          click: () => send('toggle-autoplay'),
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
        {
          // Xcode 收起右边检查器也是这个键;⌥⌘I 留给开发者工具
          label: '显示/隐藏右栏',
          accelerator: 'CmdOrCtrl+Alt+0',
          click: () => send('toggle-inspector'),
        },
        { type: 'separator' },
        {
          // 主题是偏好不是动作,所以在菜单里,不在工具栏
          label: '外观',
          submenu: [
            {
              label: '跟随系统',
              type: 'radio',
              checked: theme === 'system',
              click: () => send('theme:system'),
            },
            {
              label: '浅色',
              type: 'radio',
              checked: theme === 'light',
              click: () => send('theme:light'),
            },
            {
              label: '深色',
              type: 'radio',
              checked: theme === 'dark',
              click: () => send('theme:dark'),
            },
          ],
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          // 怎么连 agent 是**设置**,不该常驻在工作面板上
          label: '连接 AI 助手…',
          click: () => send('connect-agent'),
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
