import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  utilityProcess,
  webContents,
} from 'electron'
import { paddedRect, type Rect } from './anchor-crop.js'
import { buildMenuTemplate, type MenuAction } from './app-menu.js'
import { ServerSupervisor } from './server-supervisor.js'
import { ThumbnailQueue } from './thumbnail-queue.js'
import { recordPreview, type PreviewJob } from './preview-recorder.js'
import { exportPptx, type PptxJob } from './pptx-exporter.js'
import { UpdateSourceType, makeUserNotifier, updateElectronApp } from 'update-electron-app'

/**
 * 菜单和「关于」里显示的名字。**要在 app ready 之前设** —— macOS 最左边那个菜单的名字
 * 取自这里,设晚了就还是 Electron。
 */
const APP_NAME = 'Orca PPT'
app.setName(APP_NAME)
// Keep the existing profile, preferences, and guest storage when the display name changes.
app.setPath('userData', join(app.getPath('appData'), 'OrcaPPT'))

const here = dirname(fileURLToPath(import.meta.url))
// server 用 utilityProcess 起:独立进程、崩了不带走窗口,而且不依赖 RunAsNode fuse(见 server-supervisor.ts)
const supervisor = new ServerSupervisor((entry, env) =>
  utilityProcess.fork(entry, [], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
    serviceName: 'Orca PPT Server',
  }),
)
const isMac = process.platform === 'darwin'

/**
 * 应用图标。壳是直接 `electron dist/main.js` 跑起来的,没有打包出 .app,Dock 默认显示
 * Electron 自己的图标 —— 所以在这里显式设。源图在 docs/brand/orca-app-icon.png;这份
 * 按 macOS 图标的留白缩到 824 居中、加了投影,不然在 Dock 里比别的图标大一圈。
 */
const ICON = join(here, '../assets/icon.png')
/**
 * 应用版本。发布版取 bundle 里的(打包时来自 apps/desktop/package.json);开发时
 * `electron dist/main.js` 跑的是 node_modules 里的 Electron.app,app.getVersion()
 * 拿到的是 Electron 自己的版本(43.7.3),所以直接读 package.json —— 两边显示一致。
 */
const APP_VERSION: string = app.isPackaged
  ? app.getVersion()
  : (JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string }).version

/** 工作台窗口。菜单动作永远发给它,不管当前焦点在哪。 */
let workbench: BrowserWindow | undefined

/**
 * 只许开一份。锁按 userData 目录算,所以装在两处的两份(/Applications 和别的应用自带的那份)
 * 也只会开一份 —— 第二份起来的话 MCP 端口已经被占,agent 连到的是哪一份全凭运气。
 * 后开的那份把前一份的窗口叫到前面,自己退出。开发版不加锁:它常和装好的那份同时开着
 * (端口用 ORCA_PPT_PORT 错开)。
 */
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (!workbench) return
  if (workbench.isMinimized()) workbench.restore()
  workbench.show()
  workbench.focus()
})

/** 菜单只是另一个触发器:动作发给渲染层,它走和顶栏按钮同一条协议方法。 */
type MenuState = { canPresent: boolean; exporting?: boolean; theme: 'system' | 'light' | 'dark' }

function applyMenu(state: MenuState): void {
  const send = (action: MenuAction) => {
    // 连接说明是壳自己的对话框,不用绕一圈去渲染层
    if (action === 'connect-agent') {
      void showConnectAgent()
      return
    }
    if (action === 'undo' || action === 'redo') {
      void undoOrRedo(action)
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

/**
 * ⌘Z 归谁。有人正在打字(输入框、画布上双击改的那段字)就归那个输入框,撤的是
 * 打字;否则归稿子,撤的是上一处改字。焦点可能在 guest 里 —— 问的是真正拿着
 * 焦点的那个 webContents,不是工作台。
 */
async function undoOrRedo(action: 'undo' | 'redo'): Promise<void> {
  const focused = webContents.getFocusedWebContents()
  const typing = focused
    ? await focused
        .executeJavaScript(
          `(() => { const el = document.activeElement; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName)) })()`,
        )
        .catch(() => false)
    : false
  if (focused && typing) {
    if (action === 'undo') focused.undo()
    else focused.redo()
    return
  }
  workbench?.webContents.send('menu:action', action)
}

/**
 * skill 跟着 app 发版:发布版把它放在 Resources/skill,告诉 server 用这一份。
 * 开发时没有这一份,server 自己去读本地仓(见 apps/server/src/skill.ts)。
 */
function bundledSkill(): Record<string, string> {
  return app.isPackaged ? { ORCA_PPT_BUNDLED_SKILL: join(process.resourcesPath, 'skill') } : {}
}

async function createWindow(): Promise<void> {
  const port = await supervisor.start(join(here, '../../server/dist/main.js'), {
    ...bundledSkill(),
    // 握手时报的版本号、doctor 里的版本都用它 —— server 自己不知道 app 是哪一版。
    ORCA_PPT_APP_VERSION: APP_VERSION,
  })
  serverPort = port

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // 最窄也要放得下首页的一列同款卡片:卡片最窄 420(styles.css 的 gallery-grid--recipes)
    // + 左右各 32 的边距,再留点余量
    minWidth: 520,
    minHeight: 480,
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
ipcMain.handle('app:content-bounds', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isMinimized() || !window.isVisible()) return undefined
  return { ...window.getContentBounds(), zoom: event.sender.getZoomFactor() }
})

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
 * 结束放映:关掉放映窗口。agent 的 stop_present、close_deck(关稿子回首页)都走它 ——
 * 以前没有这条路,稿子关了放映窗口还全屏挂着。
 */
ipcMain.handle('deck:stop-present', () => {
  presenter?.close()
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
 * `go(i)` 返回这次转场和页内动画的时长,`seek(transition + build)` 落在全部放完的稳定态。
 * 普通 Reveal.js 稿子没有录制接口时,在隐藏窗口关闭内置转场并直接定位静态页面。
 */
const thumbnailQueue = new ThumbnailQueue()

/** 缩略图缓存里的一格:`<根>/thumbnails/<稿子>/<键>…`(见 apps/server/src/thumbnail-cache.ts)。 */
function isThumbnailDir(path: string): boolean {
  return basename(dirname(dirname(path))) === 'thumbnails'
}

ipcMain.handle(
  'deck:thumbnails',
  async (
    event,
    input: {
      previewUrl: string
      slideCount: number
      slides?: number[]
      width?: number
      outDir?: string
    },
  ) => {
    if (input.slideCount === 0) return []
    const key = `${event.sender.id}:${input.previewUrl}:${input.slides?.join(',') ?? 'all'}:${input.width ?? 320}`
    return thumbnailQueue.run(key, async () => {
      if (event.sender.isDestroyed()) return []
      // 录制要的缩略图只要被改的那一页,而且更大;页胶片要全部、320 宽
      const indices =
        input.slides?.filter((index) => index < input.slideCount) ??
        Array.from({ length: input.slideCount }, (_, index) => index)
      const width = input.width ?? 320

      const offscreen = new BrowserWindow({
        show: false,
        width: 960,
        height: 540,
        // 按内容区算 960×540:不然标题栏吃掉一截,截出来是 960×508,不是 16:9
        useContentSize: true,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
      })

      const destroy = () => {
        if (!offscreen.isDestroyed()) offscreen.destroy()
      }
      const timeout = setTimeout(destroy, 45_000)
      event.sender.once('destroyed', destroy)

      let rejectClosed!: (error: Error) => void
      const closed = new Promise<never>((_resolve, reject) => {
        rejectClosed = reject
      })
      const onClosed = () => rejectClosed(new Error('缩略图渲染已取消或超时'))
      offscreen.once('closed', onClosed)
      const render = async () => {
        await offscreen.loadURL(`${input.previewUrl}?capture#/0`)
        const ready = await offscreen.webContents.executeJavaScript(
          `new Promise(resolve => {
            const check = () => {
              if (window.__capture?.go && window.__capture?.seek) return 'capture';
              if (window.Reveal?.isReady?.()) return 'reveal';
              return null;
            };
            const finish = value => { clearInterval(timer); clearTimeout(timeout); resolve(value); };
            const timer = setInterval(() => { const mode = check(); if (mode) finish(mode); }, 50);
            const timeout = setTimeout(() => finish(null), 8000);
          })`,
        )
        if (!ready) throw new Error('稿子未就绪，无法生成缩略图')
        // Thumbnails contain slide content only; presentation controls belong to the viewer.
        await offscreen.webContents.executeJavaScript(
          `window.Reveal?.configure({ controls: false, progress: false, slideNumber: false });`,
        )
        // Plain Reveal decks have no Orca capture API. Disable transitions only in this hidden window.
        if (ready === 'reveal') {
          await offscreen.webContents.executeJavaScript(
            `Reveal.configure({ transition: 'none', backgroundTransition: 'none', autoAnimate: false, autoSlide: 0 });`,
          )
        }
        await offscreen.webContents.executeJavaScript('document.fonts.ready')

        // 页胶片的图写进 server 给的缓存目录;壳也守一道,只认缩略图缓存里的一格。
        // 没给(录制要的单页大图)就写临时目录,用完即弃,下次启动清掉
        const dir =
          input.outDir && isThumbnailDir(input.outDir)
            ? input.outDir
            : join(app.getPath('userData'), 'thumbs', randomUUID().slice(0, 8))
        await mkdir(dir, { recursive: true })

        const paths: Array<string | null> = []
        for (const index of indices) {
          if (offscreen.isDestroyed()) throw new Error('缩略图渲染已取消或超时')
          try {
            await offscreen.webContents.executeJavaScript(
              `(async () => {
                if (window.__capture?.go && window.__capture?.seek) {
                  // 页内动画（点击分步、入场）放完才是这一页完整的样子;老引擎没有 build,就停在转场结束
                  const { transition, build } = await window.__capture.go(${index});
                  await window.__capture.seek(transition + (build || 0));
                } else {
                  Reveal.slide(${index});
                  // Use the completed static slide, including all fragment steps.
                  Reveal.getCurrentSlide().querySelectorAll('.fragment').forEach(el => el.classList.add('visible'));
                }
                const images = [...Reveal.getCurrentSlide().querySelectorAll('img')];
                await Promise.race([
                  Promise.all(images.map(img => img.decode().catch(() => {}))),
                  new Promise(resolve => setTimeout(resolve, 3000)),
                ]);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              })()`,
            )
            const image = await offscreen.webContents.capturePage()
            if (image.isEmpty()) {
              paths.push(null)
              continue
            }
            const resized = image.resize({ width })
            const png = resized.toPNG()
            // 可录制应用约定:单张不超过 300KB。PNG 太大就换 JPEG
            const [file, bytes] =
              png.length > 300_000
                ? [join(dir, `${index}.jpg`), resized.toJPEG(85)]
                : [join(dir, `${index}.png`), png]
            await writeFile(file, bytes)
            paths.push(file)
          } catch {
            if (offscreen.isDestroyed()) throw new Error('缩略图渲染已取消或超时')
            // 某一页渲不出来不该毁掉整条 —— 那一格留空就是了
            paths.push(null)
          }
        }
        return paths
      }
      try {
        return await Promise.race([render(), closed])
      } finally {
        clearTimeout(timeout)
        event.sender.removeListener('destroyed', destroy)
        offscreen.removeListener('closed', onClosed)
        destroy()
      }
    })
  },
)

/**
 * 同款样片。一次只录一个(两个隐藏窗口逐帧录二三十秒的稿子,并行只会互相拖慢)。
 * 写到哪由 server 定(按内容寻址的缓存),录制器自己再守一道只写缓存目录。
 */
let previewTail: Promise<unknown> = Promise.resolve()
ipcMain.handle('deck:preview', (_event, job: PreviewJob) => {
  const run = previewTail.then(() => recordPreview(job))
  previewTail = run.catch(() => {})
  return run.then(() => true)
})

/**
 * 导出 PPTX。和录样片一样一次只导一份:都是隐藏窗口里逐页 seek,并行只会互相拖慢。
 * 先写到 server 给的临时文件,挪到用户选的位置是 server 的事。
 */
let pptxTail: Promise<unknown> = Promise.resolve()
ipcMain.handle('deck:export-pptx', (_event, job: PptxJob) => {
  const run = pptxTail.then(() => exportPptx(job))
  pptxTail = run.catch(() => {})
  return run
})

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

/**
 * 导出 PPTX 存到哪。和打开目录一样,渲染层只拿到一个路径字符串,写文件的是 server。
 * 默认放在稿子目录旁边;只读的稿子(同款样稿在 app 包里)放进「下载」。
 */
ipcMain.handle(
  'deck:pick-pptx',
  async (_event, input: { dir: string; name: string; readOnly?: boolean }) => {
    const dir = input.readOnly ? app.getPath('downloads') : input.dir
    const name = input.name.replace(/[/\\:*?"<>|]/g, '-').trim() || 'deck'
    const result = await dialog.showSaveDialog({
      title: '导出 PPTX',
      defaultPath: join(dir, `${name}.pptx`),
      filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
    })
    return result.canceled ? undefined : result.filePath
  },
)

/**
 * 导完了(或者导失败了):说清哪里和网页不一样,导成了就给一个「在访达中显示」。
 * 文字由渲染层拼好。
 */
ipcMain.handle(
  'deck:pptx-exported',
  async (_event, input: { message: string; detail: string; path?: string }) => {
    const reveal = isMac ? '在访达中显示' : '在文件夹中显示'
    const result = await dialog.showMessageBox({
      type: input.path ? 'info' : 'warning',
      message: input.message,
      detail: input.detail,
      buttons: input.path ? ['好', reveal] : ['好'],
      defaultId: 0,
    })
    if (input.path && result.response === 1) shell.showItemInFolder(input.path)
  },
)

/** 菜单里的启用状态和勾选跟着界面走,渲染层变了就报一声。 */
ipcMain.handle('app:menu-state', (_event, state: MenuState) => {
  applyMenu(state)
})

/**
 * 自动更新:Electron 官方的 update.electronjs.org 读本仓的 GitHub Releases(仓库是公开的才能用),
 * 有新版就下载,弹窗问要不要重启。只在发布版里开 —— 开发时的应用没签名,Squirrel.Mac 也更新不了它。
 * Release 里要有 `OrcaPPT-darwin-<arch>-<版本>.zip`(见 docs/RELEASE.md)。
 */
if (app.isPackaged) {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: 'orca-studio/orca-ppt',
    },
    updateInterval: '1 hour',
    // 库自带的弹窗是英文；界面别处都是中文
    onNotifyUser: makeUserNotifier({
      title: '更新',
      detail: '新版本已经下载好，重启应用就能用上。',
      restartButtonText: '重启',
      laterButtonText: '稍后',
    }),
  })
}

app.whenReady().then(() => {
  // 临时缩略图只在当次用:server 拿到就转成 base64 交出去了,不留路径
  void rm(join(app.getPath('userData'), 'thumbs'), { recursive: true, force: true })
  applyMenu({ canPresent: false, theme: 'system' })
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: APP_VERSION,
    // 不显示括号里的构建号:自动更新只认版本号,构建号对用户没意义(bundle 里照样有)
    version: '',
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
