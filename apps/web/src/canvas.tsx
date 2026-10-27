import { useCallback } from 'react'
import { host } from './host.js'

/**
 * 画布驱动:Stage 只经这里摸稿子页面(见 docs/ARCHITECTURE.md「一个内核,三种形态」的
 * CanvasDriver)。桌面版是 Electron `<webview>`;浏览器里是 `<iframe>`,要和界面**同源**才摸得到
 * 里面 —— server 同时托管界面和 `/p` 预览时就是同源,开发时由 Vite 把 `/p` 代理过去。
 *
 * 只有这几个动作:跑一段代码、重载、失焦、量位置,外加几个加载事件。检视、改字、翻页的
 * 逻辑都在注入的 guest 脚本和 Stage 里,两种画布共用。
 */
export interface CanvasView {
  /** 在稿子页面里求一个表达式的值(会等 Promise),结果按 JSON 拷回来。摸不到页面时 reject。 */
  run(code: string): Promise<unknown>
  reload(): void
  blur(): void
  /** 画布元素在宿主页面里的位置。 */
  rect(): DOMRect
  /** 桌面版 guest 的 webContents id,主进程按它截图;浏览器里没有。 */
  guestId(): number | undefined
  subscribe(events: CanvasEvents): () => void
}

export interface CanvasEvents {
  /** 主框架开始整页导航(重载、换稿)。之前注入的东西全没了。 */
  navigated(): void
  loadingStarted(): void
  loadingStopped(): void
  /** 页面 DOM 好了,可以注入。 */
  domReady(): void
  failed(message: string): void
  /** 页面里的 console。guest 脚本翻页、分步都靠它报回来(`__orca:slide N`)。 */
  console(entry: { message: string; error: boolean; source?: string }): void
}

export interface CanvasProps {
  src: string
  /** 挂上时交出画布,卸下时交 null。在 ref 回调里交,父组件的 effect 跑之前就拿得到。 */
  onView: (view: CanvasView | null) => void
}

/** 按运行形态选画布。 */
export function Canvas(props: CanvasProps) {
  return host.kind === 'electron' ? <WebviewCanvas {...props} /> : <IframeCanvas {...props} />
}

/** Electron 的 webview 标签。只列我们真正调的那几个。 */
interface WebviewElement extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>
  reload(): void
  getWebContentsId(): number
}

function WebviewCanvas({ src, onView }: CanvasProps) {
  const attach = useCallback(
    (element: WebviewElement | null) => onView(element ? webviewView(element) : null),
    [onView],
  )
  return (
    <webview
      ref={attach as unknown as React.Ref<HTMLWebViewElement>}
      src={src}
      // 独立持久 partition:deck 的存储和应用本身完全隔开。
      partition="persist:deck-preview"
    />
  )
}

export function webviewView(view: WebviewElement): CanvasView {
  return {
    run: (code) => view.executeJavaScript(code),
    reload: () => view.reload(),
    blur: () => view.blur(),
    rect: () => view.getBoundingClientRect(),
    guestId: () => {
      try {
        return view.getWebContentsId()
      } catch {
        // guest 还没附着
        return undefined
      }
    },
    subscribe: (events) => {
      const listeners: Array<[string, (event: Event) => void]> = [
        [
          'did-start-navigation',
          (event) => {
            const nav = event as Event & { isInPlace?: boolean; isMainFrame?: boolean }
            // 只认主框架的整页导航。稿子里的 iframe(比如回顾片尾的回顾屏)加载也会发这个事件,
            // 把它当成整页重载的话注入状态会被清掉,而主框架不会再发 dom-ready 把它装回来。
            if (nav.isMainFrame !== false && !nav.isInPlace) events.navigated()
          },
        ],
        [
          'console-message',
          (event) => {
            const detail = event as Event & { message?: string; level?: number; sourceId?: string }
            events.console({
              message: detail.message ?? '',
              error: detail.level === 3,
              ...(detail.sourceId ? { source: detail.sourceId } : {}),
            })
          },
        ],
        ['did-stop-loading', () => events.loadingStopped()],
        ['did-start-loading', () => events.loadingStarted()],
        ['dom-ready', () => events.domReady()],
        [
          'did-fail-load',
          (event) =>
            events.failed((event as Event & { errorDescription?: string }).errorDescription ?? ''),
        ],
      ]
      for (const [name, listener] of listeners) view.addEventListener(name, listener)
      return () => {
        for (const [name, listener] of listeners) view.removeEventListener(name, listener)
      }
    },
  }
}

function IframeCanvas({ src, onView }: CanvasProps) {
  const attach = useCallback(
    (element: HTMLIFrameElement | null) => onView(element ? iframeView(element) : null),
    [onView],
  )
  return <iframe ref={attach} src={sameOrigin(src)} title="稿子" />
}

/**
 * server 给的预览地址是绝对的(`http://127.0.0.1:6722/p/…`)。浏览器里要同源才摸得到稿子页面:
 * 界面和它同源就原样用,不同源(开发时界面在 Vite 上)就只取路径,交给 Vite 代理。
 */
export function sameOrigin(src: string, origin: string = location.origin): string {
  try {
    const url = new URL(src)
    return url.origin === origin ? src : url.pathname + url.search + url.hash
  } catch {
    return src
  }
}

/** 页面里的 window,只用到这几个。 */
type GuestWindow = Window & { eval(code: string): unknown; console: Console }

export function iframeView(frame: HTMLIFrameElement): CanvasView {
  const guest = () => {
    const win = frame.contentWindow as GuestWindow | null
    if (!win) throw new Error('画布还没加载')
    return win
  }
  return {
    run: async (code) => {
      // 不同源时这里直接抛 SecurityError,和 webview 摸不到 guest 一样当失败处理
      const value = await guest().eval(code)
      // 和 webview 一样只交回能序列化的值,不把稿子页面里的对象漏到界面里
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    reload: () => {
      try {
        guest().location.reload()
      } catch {
        frame.src = frame.src
      }
    },
    blur: () => frame.blur(),
    rect: () => frame.getBoundingClientRect(),
    guestId: () => undefined,
    subscribe: (events) => {
      const onLoad = () => {
        try {
          hook(guest(), events)
        } catch {
          // 不同源:摸不到页面,只报加载完成。检视、改字这些会在 run 时失败
        }
        events.loadingStopped()
        events.domReady()
      }
      frame.addEventListener('load', onLoad)
      return () => frame.removeEventListener('load', onLoad)
    },
  }
}

/**
 * 每次加载后挂一遍:页面要走(重载、换稿)时报导航;console 和报错转给画布。
 * webview 能从外面听到这些,iframe 只能进页面里挂 —— 所以加载完成前的报错听不到。
 */
function hook(win: GuestWindow, events: CanvasEvents): void {
  win.addEventListener('pagehide', () => {
    events.navigated()
    events.loadingStarted()
  })
  const console = win.console as unknown as Record<string, (...args: unknown[]) => void>
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    const original = console[level]
    if (!original) continue
    console[level] = (...args: unknown[]) => {
      original.apply(win.console, args)
      events.console({ message: args.map(String).join(' '), error: level === 'error' })
    }
  }
  win.addEventListener('error', (event) =>
    events.console({
      message: event.message,
      error: true,
      ...(event.filename ? { source: event.filename } : {}),
    }),
  )
  win.addEventListener('unhandledrejection', (event) =>
    events.console({ message: String(event.reason), error: true }),
  )
}
