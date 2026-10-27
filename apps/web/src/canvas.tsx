import { useCallback, useRef } from 'react'
import autoplayScript from './guest/autoplay.guest.js?raw'
import bridgeScript from './guest/bridge.guest.js?raw'
import canvasScript from './guest/canvas.guest.js?raw'
import editScript from './guest/edit.guest.js?raw'
import inspectScript from './guest/inspect.guest.js?raw'
import { host } from './host.js'

/**
 * 画布驱动:Stage 只经这里摸稿子页面(见 docs/ARCHITECTURE.md「一个内核,三种形态」的
 * CanvasDriver)。桌面版是 Electron `<webview>`;浏览器里是 `<iframe>`,稿子在**另一个源**,
 * 两边只用 `postMessage` 说话。
 *
 * 宿主叫画布做事只能用 `guest/bridge.guest.js` 里那张固定的动作表,不送任意代码进去 ——
 * 浏览器里稿子是另一个源的页面,它的脚本也借不了这条通道反过来驱动工作台。
 */
export interface CanvasView {
  /** 调动作表里的一个动作(会等 Promise),结果按 JSON 拷回来。动作出错或摸不到页面时 reject。 */
  call(action: CanvasAction, ...args: unknown[]): Promise<unknown>
  /** 页面加载好之后把 guest 脚本装进去。浏览器里 server 托管稿子时已经装好了,这里什么都不做。 */
  inject(): Promise<void>
  reload(): void
  blur(): void
  /** 画布元素在宿主页面里的位置。 */
  rect(): DOMRect
  /** 桌面版 guest 的 webContents id,主进程按它截图;浏览器里没有。 */
  guestId(): number | undefined
  subscribe(events: CanvasEvents): () => void
}

/** `guest/bridge.guest.js` 的动作表。两边要对上。 */
export type CanvasAction =
  | 'setup'
  | 'slideTo'
  | 'editArm'
  | 'editNotify'
  | 'editing'
  | 'editRelease'
  | 'inspect'
  | 'settle'
  | 'select'
  | 'pick'
  | 'cancelPick'
  | 'autoplay'
  | 'autoplayRunning'
  | 'goto'
  | 'navigate'
  | 'locate'
  | 'patch'
  | 'revision'
  | 'show'
  | 'frame'
  | 'slideArea'
  | 'slideInfo'

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

/** 动作表的回复:`{ value }` 或 `{ error }`(见 bridge.guest.js)。 */
type Reply = { value?: unknown; error?: string }
const unwrap = (action: string, reply: Reply): unknown => {
  if (reply.error !== undefined) throw new Error(`${action}: ${reply.error}`)
  return reply.value
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

/** 桌面版每次加载后注入的那几份 guest 脚本,动作表在最后。 */
const GUEST_SCRIPTS = [inspectScript, autoplayScript, editScript, canvasScript, bridgeScript].join(
  ';\n',
)

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
    call: async (action, ...args) =>
      unwrap(
        action,
        (await view.executeJavaScript(
          `window.__orcaHost.call(${JSON.stringify(action)}, ${JSON.stringify(args)})`,
        )) as Reply,
      ),
    inject: async () => {
      await view.executeJavaScript(GUEST_SCRIPTS)
    },
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
  const current = useRef<IframeView | null>(null)
  const attach = useCallback(
    (element: HTMLIFrameElement | null) => {
      current.current?.dispose()
      current.current = element ? iframeView(element) : null
      onView(current.current)
    },
    [onView],
  )
  return <iframe ref={attach} src={src} title="稿子" />
}

export interface IframeView extends CanvasView {
  /** 摘掉 message 监听,挂着的调用一律失败。 */
  dispose(): void
}

/**
 * 浏览器里的画布。稿子在另一个源:server 托管它时在末尾加了一行
 * `<script src="<界面的源>/guest.js">`,里面的动作表认界面这个源发来的消息(见 bridge.guest.js)。
 * 这边反过来只认那个 iframe、那个源发回来的消息。
 */
export function iframeView(frame: HTMLIFrameElement, win: Window = window): IframeView {
  const origin = () => new URL(frame.src, win.location.href).origin
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >()
  const subscribers = new Set<CanvasEvents>()
  let seq = 0

  const failAll = (why: string) => {
    for (const [id, waiting] of pending) {
      pending.delete(id)
      waiting.reject(new Error(why))
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin()) return
    const data = event.data as {
      orca?: unknown
      type?: string
      id?: string
      value?: unknown
      error?: string
      message?: string
      source?: string | null
    }
    if (!data || data.orca !== true) return
    if (data.type === 'reply' && typeof data.id === 'string') {
      const waiting = pending.get(data.id)
      if (!waiting) return
      pending.delete(data.id)
      try {
        waiting.resolve(unwrap('call', data))
      } catch (error) {
        waiting.reject(error as Error)
      }
      return
    }
    for (const events of subscribers) {
      if (data.type === 'ready') events.domReady()
      else if (data.type === 'leaving') {
        events.navigated()
        events.loadingStarted()
      } else if (data.type === 'console')
        events.console({
          message: String(data.message ?? ''),
          error: Boolean(data.error),
          ...(data.source ? { source: data.source } : {}),
        })
    }
    // 页面要走了:改字、取锚这类一直挂着的调用不会再有回音
    if (data.type === 'leaving') failAll('画布重载了')
  }
  win.addEventListener('message', onMessage)

  const onLoad = () => {
    for (const events of subscribers) events.loadingStopped()
  }
  frame.addEventListener('load', onLoad)

  return {
    call: (action, ...args) =>
      new Promise((resolve, reject) => {
        const target = frame.contentWindow
        if (!target) return reject(new Error('画布还没加载'))
        const id = String(++seq)
        pending.set(id, {
          resolve,
          reject: (error) => reject(new Error(`${action}: ${error.message}`)),
        })
        target.postMessage({ orca: true, type: 'call', id, action, args }, origin())
      }),
    inject: async () => {},
    reload: () => {
      // 不同源,摸不到它的 location:重设一次地址
      const src = frame.src
      frame.src = 'about:blank'
      frame.src = src
    },
    blur: () => frame.blur(),
    rect: () => frame.getBoundingClientRect(),
    guestId: () => undefined,
    subscribe: (events) => {
      subscribers.add(events)
      return () => subscribers.delete(events)
    },
    dispose: () => {
      win.removeEventListener('message', onMessage)
      frame.removeEventListener('load', onLoad)
      failAll('画布已卸下')
    },
  }
}
