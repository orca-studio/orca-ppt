/**
 * 宿主怎么叫画布做事:一张**固定的动作表**,不收任意代码。纯 JS、不 import 任何东西。
 *
 * 两种画布共用这张表(见 apps/web/src/canvas.tsx):
 * - 桌面版 webview:宿主把它连同别的 guest 脚本一起注入,再用 executeJavaScript 调
 *   `window.__orcaHost.call(动作, 参数)`;
 * - 浏览器 iframe:稿子在另一个源,宿主摸不到页面。server 托管稿子时在末尾加一行
 *   `<script src="<界面的源>/guest.js">`,这份脚本被那样加载时,额外挂上 postMessage:
 *   只认界面那个源、只认父窗口发来的消息,只调表里的动作。console、报错、页面要走了
 *   也经它报回去。
 *
 * 每个动作回 `{ value }` 或 `{ error }` —— 出错时带回真正的原因,而不是一句「脚本执行失败」。
 */
;(() => {
  /** 往后翻一页:走引擎的 advance,转场没放完就先放完,不跳帧;老引擎退回 Reveal.next()。 */
  const advance = () => (window.__orcaAdvance ? window.__orcaAdvance() : window.Reveal.next())
  /** 明说要去下一页:转场先放完,页内动画不再一步一步推。 */
  const nextPage = () =>
    window.__orcaAdvance ? window.__orcaAdvance({ page: true }) : window.Reveal.next()
  const frame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const actions = {
    setup: () => void window.Reveal?.configure({ controls: false }),
    slideTo: (index) => {
      window.Reveal.slide(index)
      return window.Reveal.getIndices().h
    },
    editArm: () => window.__orcaEdit?.arm() ?? null,
    editNotify: (message) => void window.__orcaEdit?.notify(message),
    editing: () => Boolean(window.__orcaEdit?.editing()),
    /** 收起双击改字;正在改的那处不收走。 */
    editRelease: () => void (window.__orcaEdit?.editing() || window.__orcaEdit?.disarm()),
    inspect: (include) => window.__orcaCanvas?.inspect(include) ?? null,
    /** 字体到齐、画完两帧。3 秒还没好就如实说没好。 */
    settle: () =>
      Promise.race([
        document.fonts.ready.then(frame),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('RENDER_NOT_READY: 字体尚未加载。')), 3000),
        ),
      ]),
    select: (input) => window.__orcaCanvas.select(input),
    pick: () => window.__orcaInspect?.arm() ?? null,
    cancelPick: () => void window.__orcaInspect?.disarm(),
    autoplay: (on) => void window.__orcaAutoplay?.[on ? 'start' : 'stop'](),
    autoplayRunning: () => Boolean(window.__orcaAutoplay?.running()),
    /** 正好是下一页就当成「往前翻」(有转场);别的页是跳页,直接去。 */
    goto: (index) =>
      void (window.Reveal.getIndices().h + 1 === index ? nextPage() : window.Reveal.slide(index)),
    navigate: (action, from) => {
      window.__orcaAutoplay?.stop()
      if (action === 'previous') return void window.Reveal.prev()
      if (action === 'replay') {
        window.Reveal.slide(from ?? 0)
        return void setTimeout(advance, 260)
      }
      if (action === 'replayPage') {
        // 已经在这一页时 Reveal.slide 不会触发翻页,页内动画要引擎自己从头放;老引擎没有就算了
        window.Reveal.slide(from ?? 0)
        return void window.__orcaReplayBuild?.()
      }
      return void advance()
    },
    locate: (queries) =>
      queries.map(
        (query) =>
          window.__orcaCanvas?.locate(query) ?? {
            status: 'unavailable',
            reason: 'canvas_not_ready',
          },
      ),
    patch: (input) => window.__orcaCanvas.patch(input),
    revision: () => window.__orcaCanvas.revision(),
    /** 直接跳,不放转场:要看的是改动,不是翻页动画。 */
    show: (index) => void (window.Reveal.getIndices().h === index || window.Reveal.slide(index)),
    frame,
    slideArea: () => window.__orcaCanvas.slideArea(),
    slideInfo: () => window.__orcaInspect?.slideInfo() ?? null,
  }

  const call = async (action, args) => {
    const run = Object.hasOwn(actions, action) ? actions[action] : undefined
    if (!run) return { error: `不认识的动作:${action}` }
    try {
      return { value: await run(...(Array.isArray(args) ? args : [])) }
    } catch (error) {
      return { error: String((error && error.stack) || error) }
    }
  }
  window.__orcaHost = { call }

  // 下面只在浏览器 iframe 里:被 server 加的那行 <script src="<界面的源>/guest.js"> 加载、
  // 而且确实嵌在别的页面里。桌面版的 webview 是注入的,没有 currentScript.src。
  const src = document.currentScript?.src
  if (!src || window.parent === window) return
  const ui = new URL(src).origin
  const post = (message) => window.parent.postMessage({ orca: true, ...message }, ui)

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== ui) return
    const data = event.data
    if (!data || data.orca !== true || data.type !== 'call' || typeof data.id !== 'string') return
    void call(data.action, data.args).then((reply) => {
      // 结果按 JSON 拷:页面里的对象不该原样漏到界面里
      const value = reply.value === undefined ? undefined : JSON.parse(JSON.stringify(reply.value))
      post({ type: 'reply', id: data.id, ...(reply.error ? { error: reply.error } : { value }) })
    })
  })

  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    const original = console[level]
    console[level] = (...args) => {
      original.apply(console, args)
      post({ type: 'console', message: args.map(String).join(' '), error: level === 'error' })
    }
  }
  window.addEventListener('error', (event) =>
    post({ type: 'console', message: event.message, error: true, source: event.filename || null }),
  )
  window.addEventListener('unhandledrejection', (event) =>
    post({ type: 'console', message: String(event.reason), error: true }),
  )
  window.addEventListener('pagehide', () => post({ type: 'leaving' }))
  post({ type: 'ready' })
})()
