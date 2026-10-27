/**
 * 界面碰外界只经这里(见 docs/ARCHITECTURE.md「一个内核,三种形态」的 Host)。
 *
 * 桌面版是 preload 交过来的窄桥;浏览器里没有壳,这些能力就缺着,界面按「缺」处理
 * (不显示、或者说清做不了),不在别处直接摸 `window.orca`。
 * 画布怎么接也按这里的 `kind` 选(见 canvas.tsx)。
 */
export interface ElectronBridge {
  serverPort?: number
  /** 连 server 要带的启动 token(见 apps/server/src/web-host.ts)。 */
  token?: string
  platform?: string
  /** 开发时通过 ORCA_PPT_DECK 指定,启动就打开这份稿子。 */
  initialDeck?: string
  /** 渲染层不碰文件系统 —— 壳弹目录选择器,只把路径交回来。 */
  pickDeck?: () => Promise<string | undefined>
  /** 截一张带上下文的锚裁切图,落在应用数据目录,返回绝对路径。 */
  captureAnchor?: (input: {
    guestId: number | undefined
    box: { x: number; y: number; w: number; h: number }
    viewport: { w: number; h: number }
  }) => Promise<string | undefined>
  /** 菜单里的动作。菜单只是另一个触发器,走的是同一条协议方法。 */
  onMenuAction?: (handler: (action: string) => void) => void
  /** 菜单里的启用状态和勾选,跟着界面走。 */
  setMenuState?: (state: {
    canPresent: boolean
    exporting?: boolean
    theme: string
  }) => Promise<void>
  /** 设主题。壳这一层也要设,否则原生菜单/对话框和界面对不上。 */
  setTheme?: (source: 'system' | 'light' | 'dark') => Promise<boolean>
  /** 全屏放映。稿子好不好只有放映能回答。 */
  present?: (input: { previewUrl: string; slide: number; script?: string }) => Promise<boolean>
  /** 关掉放映窗口。 */
  stopPresent?: () => Promise<boolean>
  /** 放映中开关自动播放。没在放映返回 false。 */
  presentAutoplay?: (on: boolean) => Promise<boolean>
  /** 放映窗口还在不在自动播放。没在放映返回 null。 */
  presentAutoplayRunning?: () => Promise<boolean | null>
  /** 壳弹保存对话框,只把路径交回来。 */
  pickPptxPath?: (input: {
    dir: string
    name: string
    readOnly?: boolean
  }) => Promise<string | undefined>
  /** 导出失败,壳弹一个对话框说原因。导成了不提示。 */
  pptxFailed?: (reason: string) => Promise<void>
  /** 用系统默认应用打开一个阶段产物。改产物用用户自己的编辑器。 */
  openFile?: (path: string) => Promise<string | undefined>
  contentBounds?: () => Promise<
    { x: number; y: number; width: number; height: number; zoom: number } | undefined
  >
  /** 截整张画布 —— agent 靠它自己看一眼做出来的东西。 */
  captureCanvas?: (input: { guestId: number | undefined }) => Promise<string | undefined>
}

declare global {
  interface Window {
    /** 只有桌面版有。别处别直接读它,读 `host`。 */
    orca?: ElectronBridge
  }
}

export interface Host extends ElectronBridge {
  /** 桌面版的画布是 `<webview>`;浏览器里是同源的 `<iframe>`。 */
  kind: 'electron' | 'browser'
}

/** server 的默认端口(apps/server/src/main.ts)。浏览器里没有壳报端口,就连它。 */
export const SERVER_PORT = 6722

const bridge = typeof window === 'undefined' ? undefined : window.orca

// 桥是 contextBridge 交过来的普通对象,拷一份再补上 kind
export const host: Host = bridge
  ? Object.assign({}, bridge, { kind: 'electron' as const })
  : browserHost()

/**
 * 浏览器里:`orca-ppt serve` 托管界面,打开的网址带着 token 和(可选的)稿子路径;
 * 端口就是界面自己的端口。开发时界面在 Vite 上,端口回落到 SERVER_PORT。
 */
function browserHost(): Host {
  const query = typeof location === 'undefined' ? undefined : new URLSearchParams(location.search)
  const served =
    typeof location !== 'undefined' && location.protocol.startsWith('http') && !import.meta.env.DEV
  const token = query?.get('token') ?? undefined
  const deck = query?.get('deck') ?? undefined
  return {
    kind: 'browser',
    platform: 'web',
    ...(served && location.port ? { serverPort: Number(location.port) } : {}),
    ...(token ? { token } : {}),
    ...(deck ? { initialDeck: deck } : {}),
  }
}
