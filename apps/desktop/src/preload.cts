import electron = require('electron')

/**
 * 窄的类型化桥。渲染层自己用普通 WebSocket 连 loopback server,不经过主进程转发,
 * 所以这里只有两样东西:端口号,和一个弹目录选择器的方法。
 *
 * 目录选择器必须在这边 —— 渲染层不碰文件系统,它拿到的只是一个路径字符串,
 * 真正去读那个目录的是 server。
 *
 * preload 必须是 CommonJS(sandbox 下的 preload 不支持 ESM),所以这个文件用 .cts。
 */
const read = (prefix: string): string | undefined =>
  electron.ipcRenderer && process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)

const port = read('--orca-server-port=')

electron.contextBridge.exposeInMainWorld('orca', {
  serverPort: port ? Number(port) : undefined,
  // 渲染层要知道平台:macOS 的红绿灯按钮浮在窗口左上角,那块地方不能放东西。
  platform: process.platform,
  contentBounds: () => electron.ipcRenderer.invoke('app:content-bounds'),
  initialDeck: read('--orca-deck='),
  pickDeck: (): Promise<string | undefined> => electron.ipcRenderer.invoke('deck:pick'),
  captureAnchor: (input: unknown): Promise<string | undefined> =>
    electron.ipcRenderer.invoke('deck:capture', input),
  openFile: (path: string): Promise<string | undefined> =>
    electron.ipcRenderer.invoke('deck:open-file', path),
  captureCanvas: (input: unknown): Promise<string | undefined> =>
    electron.ipcRenderer.invoke('deck:capture-full', input),
  renderThumbnails: (input: unknown): Promise<Array<string | null>> =>
    electron.ipcRenderer.invoke('deck:thumbnails', input),
  present: (input: unknown): Promise<boolean> => electron.ipcRenderer.invoke('deck:present', input),
  setTheme: (source: 'system' | 'light' | 'dark'): Promise<boolean> =>
    electron.ipcRenderer.invoke('app:theme', source),
  onMenuAction: (handler: (action: string) => void): void => {
    electron.ipcRenderer.on('menu:action', (_event, action: string) => handler(action))
  },
  setMenuState: (state: unknown): Promise<void> =>
    electron.ipcRenderer.invoke('app:menu-state', state),
})
