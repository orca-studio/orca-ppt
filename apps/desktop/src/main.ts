import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  webContents,
} from 'electron'
import { paddedRect, type Rect } from './anchor-crop.js'
import { buildMenuTemplate, type MenuAction } from './app-menu.js'
import { ServerSupervisor } from './server-supervisor.js'

/**
 * 菜单和「关于」里显示的名字。**要在 app ready 之前设** —— macOS 最左边那个菜单的名字
 * 取自这里,设晚了就还是 Electron。
 */
const APP_NAME = 'OrcaPPT'
app.setName(APP_NAME)

const here = dirname(fileURLToPath(import.meta.url))
const supervisor = new ServerSupervisor()
const isMac = process.platform === 'darwin'

/**
 * 应用图标。壳是直接 `electron dist/main.js` 跑起来的,没有打包出 .app,Dock 默认显示
 * Electron 自己的图标 —— 所以在这里显式设。源图在 docs/brand/orca-app-icon.png;这份
 * 按 macOS 图标的留白缩到 824 居中、加了投影,不然在 Dock 里比别的图标大一圈。
 */
const ICON = join(here, '../assets/icon.png')

/** 工作台窗口。菜单动作永远发给它,不管当前焦点在哪。 */
let workbench: BrowserWindow | undefined

/** 菜单只是另一个触发器:动作发给渲染层,它走和顶栏按钮同一条协议方法。 */
function applyMenu(state: { canPresent: boolean; theme: 'system' | 'light' | 'dark' }): void {
  const send = (action: MenuAction) => {
    // 连接说明是壳自己的对话框,不用绕一圈去渲染层
    if (action === 'connect-agent') {
      void showConnectAgent()
      return
    }
    // 不能用 getFocusedWindow():从菜单栏点的时候应用常常不是聚焦状态,
    // 那样返回 null,动作被静默丢掉。放映窗口在前面时同理。
    workbench?.webContents.send('menu:action', action)
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildMenuTemplate({ appName: APP_NAME, isMac, ...state, send })),
  )
}

async function createWindow(): Promise<void> {
  const port = await supervisor.start(join(here, '../../server/dist/main.js'))
  serverPort = port

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0b0c',
    // macOS 上窗口不用它(图标归 Dock 管),Windows / Linux 的任务栏靠它。
    icon: ICON,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      // Electron 偏弱的安全默认值在壳里补齐。渲染层永远不 spawn 进程、不碰文件系统、
      // 不读凭证 —— 需要这些就加一个协议方法。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 放映画布需要 <webview> guest:它能被主进程当独立 guest 管理,所以能注入检视
      // 脚本、拿元素几何、做裁切截图。iframe 在 CSP 和同源上会一路打架,而检视正是
      // 本产品的核心交互。
      webviewTag: true,
      preload: join(here, 'preload.cjs'),
      additionalArguments: [
        `--orca-server-port=${port}`,
        // 开发时直接开一份稿子,省掉每次点目录选择器。也是 M1 的自动化验证入口。
        ...(process.env.ORCA_PPT_DECK ? [`--orca-deck=${process.env.ORCA_PPT_DECK}`] : []),
      ],
    },
  })

  workbench = window
  window.on('closed', () => {
    if (workbench === window) workbench = undefined
  })

  hardenWebviews(window)

  // 外部导航默认拒绝,丢给系统浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.ORCA_PPT_DEV_SERVER
  await (devServer
    ? window.loadURL(devServer)
    : window.loadFile(join(here, '../../web/dist/index.html')))
}

/**
 * 放映画布的 guest 在附着之前必须被削干净。webview 标签默认能继承一些主进程给的能力,
 * 这里逐项拿掉 —— guest 里跑的是稿子,不是我们的代码。
 */
function hardenWebviews(window: BrowserWindow): void {
  window.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true

    // 顶层导航只接受 loopback —— deck 由本地 server 在 127.0.0.1 上服务。
    // 子资源不受这一条约束:主题 CSS 里的字体是 Google Fonts 的 https 链接,
    // 拦掉它们画布里的字就和浏览器里不一样了。
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(params.src ?? '')) {
      params.src = 'about:blank'
    }
  })

  // guest 里点开的链接不许换掉画布,丢给系统浏览器。
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/**
 * 锚的裁切图。渲染层不碰文件系统,截图和落盘都在这儿。
 *
 * 图存在应用自己的数据目录,**不进 deck 目录** —— 它是这条对话的临时证据,不是稿子的
 * 内容,写进 deck 还会让 server 的文件监听把它当成稿子变了,取一次锚就刷一次画布。
 */
ipcMain.handle(
  'deck:capture',
  async (_event, input: { guestId: number; box: Rect; viewport: { w: number; h: number } }) => {
    const guest = webContents.fromId(input.guestId)
    if (!guest) return undefined

    const rect = paddedRect(input.box, input.viewport)
    const image = await guest.capturePage({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    if (image.isEmpty()) return undefined

    const dir = join(app.getPath('userData'), 'anchors')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${randomUUID().slice(0, 8)}.png`)
    await writeFile(file, image.toPNG())
    return file
  },
)

/**
 * 用系统默认应用打开一个产物文件。
 *
 * 不在应用里做 JSON 编辑器:deck 是磁盘上的目录,产物就是文件,用用户自己的编辑器改它
 * 比我们再造一个差劲的编辑器强,也和「用户随时能把目录拿走」这条一致。
 */
ipcMain.handle('deck:open-file', async (_event, path: string) => {
  const failure = await shell.openPath(path)
  return failure || undefined
})

/** 整张画布。agent 用它自己看一眼做出来的东西。 */
ipcMain.handle('deck:capture-full', async (_event, input: { guestId: number }) => {
  const guest = webContents.fromId(input.guestId)
  if (!guest) return undefined

  const image = await guest.capturePage()
  if (image.isEmpty()) return undefined

  const dir = join(app.getPath('userData'), 'captures')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${randomUUID().slice(0, 8)}.png`)
  await writeFile(file, image.toPNG())
  return file
})

/** 同时只放映一份 —— 再点一次「播放」应该是换内容,不是叠一个新窗口。 */
let presenter: BrowserWindow | undefined

/**
 * 全屏放映。
 *
 * 开一个独立的无边框窗口,而不是把主窗口切全屏:放映时三栏工作台不该还在旁边,
 * 而且放完要能原样退回来。Esc 关掉,方向键归 reveal 自己(guest 有焦点)。
 */
ipcMain.handle('deck:present', async (_event, input: { previewUrl: string; slide: number }) => {
  presenter?.destroy()

  const window = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  presenter = window
  window.on('closed', () => {
    if (presenter === window) presenter = undefined
  })

  // Esc 退出放映,和 Keynote 一致。这一道管真实键盘。
  window.webContents.on('before-input-event', (event, key) => {
    if (key.type !== 'keyDown' || key.key !== 'Escape') return
    event.preventDefault()
    window.close()
  })

  await window.loadURL(`${input.previewUrl}#/${input.slide}`)
  // 第二道:reveal 自己也绑了 Esc(总览模式),而且程序注入的按键不走
  // before-input-event。捕获阶段先截下来。
  await window.webContents.executeJavaScript(
    `addEventListener('keydown', (e) => {
       if (e.key !== 'Escape') return
       e.preventDefault()
       e.stopImmediatePropagation()
       window.close()
     }, true)`,
  )
  window.focus()
  return true
})

/**
 * 每页渲一张缩略图。
 *
 * **不碰可见画布** —— 驱动它把每页翻一遍,用户会看着它闪。所以开一个隐藏窗口离屏渲,
 * 渲完就关。
 *
 * 用稿子自己的录制接口(`?capture` + `__capture.go/seek`)定位,不用「跳页 + 睡一会儿」:
 * 转场是 GSAP 驱动的,睡固定毫秒会截到还没画完的上一页 —— 实测就是整排错位一格。
 * `go(i)` 返回这次转场的时长,`seek(transition)` 正好落在转场结束的稳定态。
 */
ipcMain.handle(
  'deck:thumbnails',
  async (_event, input: { previewUrl: string; slideCount: number }) => {
    if (input.slideCount === 0) return []

    const offscreen = new BrowserWindow({
      show: false,
      width: 960,
      height: 540,
      webPreferences: { sandbox: true, contextIsolation: true },
    })

    try {
      await offscreen.loadURL(`${input.previewUrl}?capture#/0`)
      const ready = await offscreen.webContents.executeJavaScript(
        'new Promise(r => { const t = setInterval(() => { if (window.__capture) { clearInterval(t); r(true) } }, 50); setTimeout(() => { clearInterval(t); r(false) }, 8000) })',
      )
      if (!ready) return []
      await offscreen.webContents.executeJavaScript('document.fonts.ready')

      const dir = join(app.getPath('userData'), 'thumbs', randomUUID().slice(0, 8))
      await mkdir(dir, { recursive: true })

      const paths: Array<string | null> = []
      for (let index = 0; index < input.slideCount; index += 1) {
        try {
          await offscreen.webContents.executeJavaScript(
            `(async () => { const { transition } = await window.__capture.go(${index}); await window.__capture.seek(transition); })()`,
          )
          const image = await offscreen.webContents.capturePage()
          if (image.isEmpty()) {
            paths.push(null)
            continue
          }
          const file = join(dir, `${index}.png`)
          await writeFile(file, image.resize({ width: 320 }).toPNG())
          paths.push(file)
        } catch {
          // 某一页渲不出来不该毁掉整条 —— 那一格留空就是了
          paths.push(null)
        }
      }
      return paths
    } finally {
      offscreen.destroy()
    }
  },
)

/**
 * 主题。`system` 让 Electron 自己跟着系统走,`light`/`dark` 是用户在应用里显式选的。
 *
 * 壳这一层也要设:原生的菜单、对话框、滚动条是 Chromium 按 nativeTheme 画的,
 * 只改 CSS 的话它们会和界面对不上。
 */
ipcMain.handle('app:theme', (_event, source: 'system' | 'light' | 'dark') => {
  nativeTheme.themeSource = source
  return nativeTheme.shouldUseDarkColors
})

/** server 起在哪个端口,连接说明要用。 */
let serverPort = 0

/** 「帮助 > 连接 agent…」:给出一行命令,点一下就拷走。 */
async function showConnectAgent(): Promise<void> {
  const url = `http://127.0.0.1:${serverPort}/mcp`
  const command = `claude mcp add --transport http orca-ppt ${url}`
  const result = await dialog.showMessageBox({
    type: 'info',
    message: '让 agent 代你操作',
    detail: `${APP_NAME} 开着的时候,MCP 挂在\n${url}\n\nClaude Code:\n${command}\n\nCodex:\ncodex mcp add orca-ppt --url ${url}`,
    buttons: ['拷贝 Claude Code 的命令', '好'],
    defaultId: 0,
    cancelId: 1,
  })
  if (result.response === 0) clipboard.writeText(command)
}

ipcMain.handle('deck:pick', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '打开 deck 目录',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

/** 菜单里的启用状态和勾选跟着界面走,渲染层变了就报一声。 */
ipcMain.handle(
  'app:menu-state',
  (_event, state: { canPresent: boolean; theme: 'system' | 'light' | 'dark' }) => {
    applyMenu(state)
  },
)

app.whenReady().then(() => {
  applyMenu({ canPresent: false, theme: 'system' })
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: ICON,
  })
  if (isMac) app.dock?.setIcon(ICON)
  return createWindow()
})
app.on('window-all-closed', () => {
  supervisor.stop()
  if (!isMac) app.quit()
})
app.on('before-quit', () => supervisor.stop())
