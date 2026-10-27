// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { iframeView, sameOrigin, webviewView, type CanvasEvents } from './canvas.js'

const noop = (): CanvasEvents => ({
  navigated: vi.fn(),
  loadingStarted: vi.fn(),
  loadingStopped: vi.fn(),
  domReady: vi.fn(),
  failed: vi.fn(),
  console: vi.fn(),
})

describe('sameOrigin', () => {
  it('和界面同源就原样用', () => {
    expect(sameOrigin('http://127.0.0.1:6722/p/abc/a/deck.html', 'http://127.0.0.1:6722')).toBe(
      'http://127.0.0.1:6722/p/abc/a/deck.html',
    )
  })

  it('不同源(开发时界面在 Vite 上)只取路径,交给代理', () => {
    expect(
      sameOrigin('http://127.0.0.1:6722/p/abc/a/deck.html?x=1#/2', 'http://127.0.0.1:5273'),
    ).toBe('/p/abc/a/deck.html?x=1#/2')
  })
})

describe('webviewView', () => {
  /** 扮演 webview:能发事件、能跑代码。 */
  function fakeWebview() {
    const element = document.createElement('div') as unknown as HTMLElement & {
      executeJavaScript: (code: string) => Promise<unknown>
      reload: () => void
      getWebContentsId: () => number
    }
    element.executeJavaScript = vi.fn(async () => 42)
    element.reload = vi.fn()
    element.getWebContentsId = () => 7
    const fire = (name: string, detail: object = {}) =>
      element.dispatchEvent(Object.assign(new Event(name), detail))
    return { element, fire }
  }

  it('webview 的事件翻成画布事件;子框架导航不算整页重载', () => {
    const { element, fire } = fakeWebview()
    const events = noop()
    const stop = webviewView(element).subscribe(events)

    fire('did-start-navigation', { isMainFrame: false, isInPlace: false })
    expect(events.navigated).not.toHaveBeenCalled()
    fire('did-start-navigation', { isMainFrame: true, isInPlace: false })
    expect(events.navigated).toHaveBeenCalledTimes(1)

    fire('console-message', { message: '__orca:slide 3', level: 1 })
    fire('console-message', { message: 'boom', level: 3, sourceId: 'deck.html' })
    expect(events.console).toHaveBeenNthCalledWith(1, { message: '__orca:slide 3', error: false })
    expect(events.console).toHaveBeenNthCalledWith(2, {
      message: 'boom',
      error: true,
      source: 'deck.html',
    })

    fire('did-fail-load', { errorDescription: 'ERR_CONNECTION_REFUSED' })
    expect(events.failed).toHaveBeenCalledWith('ERR_CONNECTION_REFUSED')

    stop()
    fire('dom-ready')
    expect(events.domReady).not.toHaveBeenCalled()
  })

  it('跑代码、要 guest id 都转给 webview', async () => {
    const { element } = fakeWebview()
    const view = webviewView(element)
    await expect(view.run('1 + 1')).resolves.toBe(42)
    expect(view.guestId()).toBe(7)
  })
})

describe('iframeView', () => {
  /** jsdom 里的同源 iframe:等它加载完再用。 */
  async function frame() {
    const element = document.createElement('iframe')
    document.body.append(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return element
  }

  it('同源时在页面里求值,等 Promise,结果按 JSON 拷回来', async () => {
    const element = await frame()
    const win = element.contentWindow as Window & { eval: (code: string) => unknown }
    // jsdom 的 iframe 不跑脚本,给它一个能求值的 eval
    win.eval = (code: string) => Promise.resolve({ code, at: new Date(0) })
    const value = await iframeView(element).run('x')
    expect(value).toEqual({ code: 'x', at: '1970-01-01T00:00:00.000Z' })
  })

  it('加载完报 DOM 好了;页面里的 console 转给画布,guest 脚本靠它报翻页', async () => {
    const element = await frame()
    const events = noop()
    iframeView(element).subscribe(events)
    element.dispatchEvent(new Event('load'))
    expect(events.loadingStopped).toHaveBeenCalled()
    expect(events.domReady).toHaveBeenCalled()

    const guest = element.contentWindow as Window & { console: Console }
    guest.console.debug('__orca:slide 2')
    guest.console.error('坏了')
    expect(events.console).toHaveBeenCalledWith({ message: '__orca:slide 2', error: false })
    expect(events.console).toHaveBeenCalledWith({ message: '坏了', error: true })

    element.contentWindow!.dispatchEvent(new Event('pagehide'))
    expect(events.navigated).toHaveBeenCalled()
    expect(events.loadingStarted).toHaveBeenCalled()
  })

  it('浏览器里没有 guest id —— 截图要走 server 的渲染器', async () => {
    expect(iframeView(await frame()).guestId()).toBeUndefined()
  })
})
