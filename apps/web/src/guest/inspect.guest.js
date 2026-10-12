/**
 * 检视脚本。注入到放映画布的 guest 里跑,所以这份文件是纯 JS、不 import 任何东西 ——
 * 宿主用 `?raw` 原样喂给 executeJavaScript。
 *
 * 本产品的核心交互:用户点中一个元素,这条意见带着页号、选择器和几何回到对话,
 * agent 拿到的是坐标而不是形容词。
 */
;(() => {
  const DESIGN_WIDTH = 1920
  const HIGHLIGHT_ID = '__orca-highlight'

  /** 这个元素所在的那一页(`.slides` 的直接子 section)。 */
  function slideRootOf(element) {
    let node = element
    while (node && node.parentElement) {
      if (
        node.tagName === 'SECTION' &&
        node.parentElement.classList &&
        node.parentElement.classList.contains('slides')
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  /**
   * 稳定的选择器。优先 id,其次 data-anchor(skill 的模板给关键元素打这个),
   * 再退到 nth-child 路径 —— **类名不参与**,因为主题一换类名就变了。
   *
   * 路径**到所在那一页为止**:页号已经单独带着了,再往上爬到 html 只会得到一条又长又脆的
   * 选择器(`html > body:nth-child(2) > div > …`),对 agent 定位毫无帮助。
   */
  function selectorFor(element, stopAt) {
    const escape = (value) =>
      window.CSS?.escape
        ? window.CSS.escape(value)
        : Array.from(value, (c) =>
            /[a-zA-Z_-]/.test(c) ? c : '\\' + c.codePointAt(0).toString(16) + ' ',
          ).join('')
    if (element.id) return '#' + escape(element.id)

    const anchor = element.getAttribute('data-anchor')
    if (anchor) return '[data-anchor="' + escape(anchor) + '"]'

    const parent = element.parentElement
    if (!parent || element === stopAt) return element.tagName.toLowerCase()

    const index = Array.prototype.indexOf.call(parent.children, element) + 1
    const own = element.tagName.toLowerCase() + ':nth-child(' + index + ')'
    if (parent === stopAt) return own
    return selectorFor(parent, stopAt) + ' > ' + own
  }

  /** 画布被缩放过,几何要还原回 1920×1080 设计坐标系,否则 agent 对不上。 */
  function scale() {
    const revealScale = window.Reveal && window.Reveal.getScale && window.Reveal.getScale()
    if (revealScale) return revealScale
    // 不是 reveal 稿时按视口宽度推,总比当成 1:1 强。
    return window.innerWidth / DESIGN_WIDTH
  }

  function currentSlide() {
    if (window.Reveal && window.Reveal.getIndices) return window.Reveal.getIndices().h
    return 0
  }

  function anchorFor(element) {
    const rect = element.getBoundingClientRect()
    const factor = scale()
    const origin = slideRootOf(element)?.parentElement?.getBoundingClientRect()
    const text = (element.textContent || '').trim()

    const anchor = {
      slide: currentSlide(),
      selector: selectorFor(element, slideRootOf(element)),
      box: {
        x: Math.round((rect.x - (origin?.x ?? 0)) / factor),
        y: Math.round((rect.y - (origin?.y ?? 0)) / factor),
        w: Math.round(rect.width / factor),
        h: Math.round(rect.height / factor),
      },
      // 宿主要按这个在 guest 的**视口**坐标里截图,不是设计坐标。
      viewportBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      note: '',
    }
    // 太长的文本对定位没帮助,只会挤占上下文。
    if (text) anchor.text = text.length > 80 ? text.slice(0, 80) + '…' : text
    return anchor
  }

  /** 鼠标底下最里层的那个实际元素。高亮框自己要躲开,否则只能点中高亮框。 */
  function targetAt(event) {
    const element = event.target
    if (!element || element === document.body || element === document.documentElement) return null
    if (element.id === HIGHLIGHT_ID) return null
    return element
  }

  function highlight() {
    let box = document.getElementById(HIGHLIGHT_ID)
    if (box) return box
    box = document.createElement('div')
    box.id = HIGHLIGHT_ID
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4ade80;' +
      'background:rgba(74,222,128,.12);border-radius:2px;display:none;transition:none'
    document.body.appendChild(box)
    return box
  }

  let active = null

  /** 进入取锚状态。返回的 Promise 在用户点下时给出锚,Esc 取消时给出 null。 */
  function arm() {
    disarm()
    return new Promise((resolve) => {
      const box = highlight()
      let hovered = null

      const onMove = (event) => {
        const element = targetAt(event)
        hovered = element
        if (!element) {
          box.style.display = 'none'
          return
        }
        const rect = element.getBoundingClientRect()
        box.style.display = 'block'
        box.style.left = rect.x + 'px'
        box.style.top = rect.y + 'px'
        box.style.width = rect.width + 'px'
        box.style.height = rect.height + 'px'
      }

      const onClick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const element = targetAt(event) || hovered
        finish(element ? anchorFor(element) : null)
      }

      const onKey = (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        finish(null)
      }

      const finish = (value) => {
        // 先把自己从 active 摘掉,免得 disarm 再解一次。
        active = null
        stop()
        resolve(value)
      }

      const stop = () => {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('keydown', onKey, true)
        document.body.style.cursor = ''
        box.style.display = 'none'
      }

      // 捕获阶段拿事件:稿子自己可能在元素上挂了 click。
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKey, true)
      document.body.style.cursor = 'crosshair'

      active = finish
    })
  }

  /**
   * 退出取锚状态。待决的那个 Promise 解成 null —— 不解的话,宿主手里会留一个永远
   * 不 settle 的 Promise(重复 arm 就撞上这个)。
   */
  function disarm() {
    if (!active) return
    active(null)
  }

  /**
   * 这一页的情况 —— 右栏「页」那一档要显示的东西。
   *
   * 只有 guest 答得出来:停留时长写在 section 的 `data-hold` 上,参与转场的元素靠
   * `data-id` / `data-carry` / `data-zoom` / `data-lead` 认 —— 这些都在**运行时的 DOM** 里,
   * 服务端读 HTML 也能看见,但页号对不上(reveal 会克隆节点),不如直接问画布。
   */
  function slideInfo() {
    const slide =
      (window.Reveal && window.Reveal.getCurrentSlide && window.Reveal.getCurrentSlide()) || null
    if (!slide) return null

    const carries = []
    for (const element of slide.querySelectorAll(
      '[data-id],[data-carry],[data-zoom],[data-lead]',
    )) {
      const text = (element.textContent || '').trim()
      carries.push({
        id:
          element.getAttribute('data-id') ||
          element.getAttribute('data-carry') ||
          element.getAttribute('data-lead') ||
          '',
        // 这个元素是靠什么参与转场的。名字直接显示,不翻译 —— 人要去稿子里找的就是它。
        kind: element.hasAttribute('data-id')
          ? 'data-id'
          : element.hasAttribute('data-carry')
            ? 'data-carry'
            : element.hasAttribute('data-lead')
              ? 'data-lead'
              : 'data-zoom',
        text: text.length > 24 ? text.slice(0, 24) + '…' : text,
      })
    }

    // 页内动画(路径、光束、入场强调、点击分步)问引擎要清单 —— data-anim 怎么读、每一步多长,
    // 只有引擎说了算,这里不再解析一遍。老引擎没有这个接口,就是 null
    let builds = null
    try {
      builds = (window.__orcaBuilds && window.__orcaBuilds()) || null
    } catch {
      builds = null
    }

    return {
      index: currentSlide(),
      // 没写 data-hold 时 reveal 不会自己停 —— 如实报 null,不编一个默认值。
      hold: slide.getAttribute('data-hold'),
      duration: slide.getAttribute('data-auto-animate-duration'),
      carries,
      builds,
    }
  }

  window.__orcaInspect = {
    arm,
    disarm,
    slideInfo,
    anchorFor,
    selectorFor: (element) => selectorFor(element, slideRootOf(element)),
    armed: () => active !== null,
  }
})()
