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
    if (element.id) return '#' + element.id

    const anchor = element.getAttribute('data-anchor')
    if (anchor) return '[data-anchor="' + anchor + '"]'

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
    const text = (element.textContent || '').trim()

    const anchor = {
      slide: currentSlide(),
      selector: selectorFor(element, slideRootOf(element)),
      box: {
        x: Math.round(rect.x / factor),
        y: Math.round(rect.y / factor),
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

  window.__orcaInspect = {
    arm,
    disarm,
    anchorFor,
    selectorFor: (element) => selectorFor(element, slideRootOf(element)),
    armed: () => active !== null,
  }
})()
