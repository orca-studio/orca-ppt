// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { iframeView, webviewView, type CanvasEvents } from './canvas.js'

const noop = (): CanvasEvents => ({
  navigated: vi.fn(),
  loadingStarted: vi.fn(),
  loadingStopped: vi.fn(),
  domReady: vi.fn(),
  failed: vi.fn(),
  console: vi.fn(),
})

describe('webviewView', () => {
  /** 扮演 webview:能发事件、能跑代码。 */
  function fakeWebview(reply: unknown = { value: 42 }) {
    const element = document.createElement('div') as unknown as HTMLElement & {
      executeJavaScript: (code: string) => Promise<unknown>
      reload: () => void
      getWebContentsId: () => number
    }
    element.executeJavaScript = vi.fn(async () => reply)
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

  it('只按动作名叫画布,参数按 JSON 传;guest id 转给 webview', async () => {
    const { element } = fakeWebview()
    const view = webviewView(element)
    await expect(view.call('goto', 3)).resolves.toBe(42)
    expect(element.executeJavaScript).toHaveBeenCalledWith('window.__orcaHost.call("goto", [3])')
    expect(view.guestId()).toBe(7)
  })

  it('动作出错带回真正的原因', async () => {
    const { element } = fakeWebview({ error: 'TypeError: Reveal is undefined' })
    await expect(webviewView(element).call('slideTo', 0)).rejects.toThrow(
      'slideTo: TypeError: Reveal is undefined',
    )
  })
})

describe('iframeView', () => {
  const DECK = 'http://127.0.0.1:7001/p/abc/deck.html'

  /** jsdom 里的 iframe:不真的去加载稿子,只拿它的 contentWindow 当消息来源。 */
  async function frame() {
    const element = document.createElement('iframe')
    document.body.append(element)
    await new Promise((resolve) => setTimeout(resolve, 0))
    Object.defineProperty(element, 'src', { value: DECK })
    const sent: Array<{ message: unknown; origin: string }> = []
    element.contentWindow!.postMessage = ((message: unknown, origin: string) =>
      sent.push({ message, origin })) as Window['postMessage']
    const from = (data: object, origin = 'http://127.0.0.1:7001') =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { orca: true, ...data },
          origin,
          source: element.contentWindow,
        }),
      )
    return { element, sent, from }
  }

  it('调用发给稿子的源,按 id 认回复;别的源冒充的不认', async () => {
    const { element, sent, from } = await frame()
    const view = iframeView(element)
    const pending = view.call('inspect', 'context')
    expect(sent[0]).toEqual({
      message: { orca: true, type: 'call', id: '1', action: 'inspect', args: ['context'] },
      origin: 'http://127.0.0.1:7001',
    })
    from({ type: 'reply', id: '1', value: 'fake' }, 'http://evil.example')
    from({ type: 'reply', id: '1', value: { ready: true } })
    await expect(pending).resolves.toEqual({ ready: true })
    view.dispose()
  })

  it('稿子报 ready、console、要走了;要走时挂着的调用一律失败', async () => {
    const { element, from } = await frame()
    const view = iframeView(element)
    const events = noop()
    view.subscribe(events)
    from({ type: 'ready' })
    expect(events.domReady).toHaveBeenCalled()
    from({ type: 'console', message: '__orca:slide 2', error: false })
    expect(events.console).toHaveBeenCalledWith({ message: '__orca:slide 2', error: false })

    const arm = view.call('editArm')
    from({ type: 'leaving' })
    expect(events.navigated).toHaveBeenCalled()
    expect(events.loadingStarted).toHaveBeenCalled()
    await expect(arm).rejects.toThrow('画布重载了')
    view.dispose()
  })

  it('浏览器里没有 guest id —— 截图要走 server 的渲染器', async () => {
    const { element } = await frame()
    expect(iframeView(element).guestId()).toBeUndefined()
  })
})
