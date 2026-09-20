import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell, webContents } from 'electron'
import { paddedRect, type Rect } from './anchor-crop.js'
import { ServerSupervisor } from './server-supervisor.js'

const here = dirname(fileURLToPath(import.meta.url))
const supervisor = new ServerSupervisor()

async function createWindow(): Promise<void> {
  const port = await supervisor.start(join(here, '../../server/dist/main.js'))

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0b0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
        ...(process.env.ORCA_PPTCODE_DECK ? [`--orca-deck=${process.env.ORCA_PPTCODE_DECK}`] : []),
      ],
    },
  })

  hardenWebviews(window)

  // 外部导航默认拒绝,丢给系统浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.ORCA_PPTCODE_DEV_SERVER
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

ipcMain.handle('deck:pick', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '打开 deck 目录',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  supervisor.stop()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => supervisor.stop())
