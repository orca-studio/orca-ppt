/** Runtime inspection only; never writes deck files or executes agent-supplied code. */
;(() => {
  window.__orcaCanvas?.dispose()
  const OVERLAY = '__orca-selection'
  const errors = []
  let selected = null
  let selectedSlide = null
  const root = () =>
    window.Reveal?.getCurrentSlide?.() ||
    document.querySelector('.slides > section.present') ||
    document.querySelector('.slides > section')
  const slide = () => window.Reveal?.getIndices?.().h ?? (root() ? 0 : null)
  /** 就地换过字之后,画布当作哪一版。重载会重新注入这份脚本,它也就跟着清掉。 */
  let patchedRevision = null
  const renderedRevision = () => {
    if (patchedRevision) return patchedRevision
    const navigation = performance.getEntriesByType?.('navigation')?.[0]
    return (
      navigation?.serverTiming?.find((metric) => metric.name === 'orca-revision')?.description ||
      null
    )
  }
  const record = (kind, message, source = null, stack = null) => {
    errors.push({
      kind,
      message: String(message).slice(0, 4000),
      source,
      stack: stack ? String(stack).slice(0, 8000) : null,
    })
    if (errors.length > 50) errors.shift()
  }
  const onError = (event) => {
    if (event.target !== window && event.target instanceof Element) {
      record(
        'resource',
        '资源加载失败',
        event.target.getAttribute('src') || event.target.getAttribute('href'),
      )
    } else
      record('script', event.message || '脚本执行失败', event.filename || null, event.error?.stack)
  }
  const onRejection = (event) =>
    record('promise', event.reason?.message || event.reason, null, event.reason?.stack)
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)

  const describe = (element) => {
    const anchor = window.__orcaInspect.anchorFor(element)
    const rect = element.getBoundingClientRect()
    let visible = rect.width > 0 && rect.height > 0
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      )
        visible = false
    }
    return {
      selector: anchor.selector,
      tag: element.tagName.toLowerCase(),
      text: (element.textContent || '').trim().slice(0, 2000),
      box: anchor.box,
      visible,
      source: element.getAttribute('src') || element.getAttribute('href') || null,
    }
  }
  const clear = () => {
    selected = null
    selectedSlide = null
    document.getElementById(OVERLAY)?.remove()
  }
  const refresh = () => {
    if (!selected) return null
    if (!selected.isConnected || selectedSlide !== slide() || !root()?.contains(selected)) {
      clear()
      return null
    }
    const value = describe(selected)
    if (!value.visible) {
      clear()
      return null
    }
    let overlay = document.getElementById(OVERLAY)
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = OVERLAY
      overlay.style.cssText =
        'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4ade80;background:rgba(74,222,128,.08)'
      document.body.appendChild(overlay)
    }
    const rect = selected.getBoundingClientRect()
    Object.assign(overlay.style, {
      left: rect.x + 'px',
      top: rect.y + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    })
    return value
  }
  const select = ({ selector, slide: targetSlide, expectedRevision }) => {
    if (!expectedRevision || expectedRevision !== renderedRevision())
      throw new Error('STALE_REVISION: 请重新读取画布。')
    if (targetSlide !== slide()) throw new Error('SLIDE_CHANGED: 当前页已改变，请重新读取画布。')
    if (selector === null) {
      clear()
      return
    }
    const matches = root()?.querySelectorAll(selector)
    if (!matches || matches.length !== 1)
      throw new Error('ELEMENT_NOT_UNIQUE: 目标不存在或不唯一。')
    if (!describe(matches[0]).visible) throw new Error('ELEMENT_NOT_VISIBLE: 目标不可见。')
    selected = matches[0]
    selectedSlide = slide()
    refresh()
  }
  const inspect = (include = 'context') => {
    const section = root()
    const config = window.Reveal?.getConfig?.() || {}
    let elements = []
    let elementsTruncated = false
    if (include === 'elements' && section) {
      const candidates = [...section.querySelectorAll('*')].filter(
        (element) =>
          !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName) &&
          !element.id.startsWith('__orca-') &&
          (element.textContent?.trim() ||
            ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'HR'].includes(element.tagName) ||
            element.hasAttribute('data-anchor') ||
            element.hasAttribute('data-id')),
      )
      elementsTruncated = candidates.length > 500
      elements = candidates.slice(0, 500).map(describe)
    }
    let html = null
    let htmlLength = 0
    if (include === 'html' && section) {
      const clone = section.cloneNode(true)
      clone.querySelectorAll('[id^="__orca-"]').forEach((element) => element.remove())
      const full = clone.outerHTML
      htmlLength = full.length
      html = full.slice(0, 100000)
    }
    return {
      renderedRevision: renderedRevision(),
      slide: slide(),
      ready:
        !!section &&
        !window.__orcaEdit?.editing() &&
        (!window.Reveal?.isReady || window.Reveal.isReady()),
      width: typeof config.width === 'number' && config.width > 0 ? config.width : 1920,
      height: typeof config.height === 'number' && config.height > 0 ? config.height : 1080,
      autoplay: !!window.__orcaAutoplay?.running(),
      selection: refresh(),
      elements,
      elementsTruncated,
      html,
      htmlLength,
      htmlTruncated: htmlLength > 100000,
      errors: [...errors],
    }
  }
  /**
   * 定位某页上的一处(studio.orca/ui-targets)。只读:不翻页、不选中。
   * 文字按源文字认整段(和改字一样);认不出整段再找唯一一个包着这段字的最深元素。
   * rect 是 guest 视口坐标,只给露在视口里的那部分。
   */
  const find = (query) => {
    const section = document.querySelectorAll('.reveal .slides > section')[query.slide]
    if (!section) return { status: 'not_found', reason: 'no_such_slide' }
    let matches
    if (typeof query.selector === 'string') {
      try {
        matches = [...section.querySelectorAll(query.selector)]
      } catch {
        return { status: 'not_found', reason: 'invalid_selector' }
      }
    } else {
      const wanted = String(query.text).trim()
      const all = [...section.querySelectorAll('*')].filter(
        (element) => !element.id.startsWith('__orca-'),
      )
      const own = (element) => (element.textContent || '').trim()
      matches = all.filter((element) => element.children.length === 0 && own(element) === wanted)
      if (matches.length === 0)
        matches = all.filter(
          (element) =>
            own(element).includes(wanted) &&
            ![...element.children].some((child) => own(child).includes(wanted)),
        )
    }
    if (matches.length === 0) return { status: 'not_found', reason: 'no_match' }
    if (matches.length > 1) return { status: 'ambiguous', reason: 'multiple_matches' }
    return { section, element: matches[0] }
  }
  const locate = (query) => {
    const found = find(query)
    if (!found.element) return found
    const { section, element } = found
    const selector = window.__orcaInspect.anchorFor(element).selector
    if (!section.classList.contains('present'))
      return { status: 'not_visible', reason: 'slide_not_shown', selector }
    if (!describe(element).visible) return { status: 'not_visible', reason: 'hidden', selector }
    const r = element.getBoundingClientRect()
    const left = Math.max(r.left, 0)
    const top = Math.max(r.top, 0)
    const right = Math.min(r.right, innerWidth)
    const bottom = Math.min(r.bottom, innerHeight)
    if (right <= left || bottom <= top)
      return { status: 'not_visible', reason: 'outside_viewport', selector }
    return {
      status: 'visible',
      selector,
      rect: { x: left, y: top, width: right - left, height: bottom - top },
    }
  }
  /** 把那一处框出来,留 holdMs(至少 1.2 秒)。等两帧再交回位置:框得先真的画到屏幕上。 */
  const mark = async (query, holdMs) => {
    const found = find(query)
    if (found.element) {
      const element = found.element
      const ms = Math.max(1200, holdMs || 0)
      element.style.animation = 'none'
      void element.offsetWidth
      element.style.animation = `__orca-spotlight ${ms}ms ease`
      setTimeout(() => {
        element.style.animation = ''
      }, ms + 100)
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    return locate(query)
  }
  /**
   * 不重载,就地换掉一段字(见协议 `deck.patched`)。只换叶子元素里的文字,结构一点不动;
   * 版本对不上、那段字认不准、人正改着字,都不换,返回 false,等整份重载。
   */
  const patch = ({ before, revision, text }) => {
    if (renderedRevision() !== before || window.__orcaEdit?.editing()) return false
    if (text) {
      const section = document.querySelectorAll('.reveal .slides > section')[text.slide]
      if (!section) return false
      const own = (element) => (element.textContent || '').trim()
      const leaves = [...section.querySelectorAll('*')].filter(
        (element) => element.children.length === 0 && !element.id.startsWith('__orca-'),
      )
      const swap = (element) => {
        element.textContent = element.textContent.replace(text.oldText, () => text.newText)
      }
      const whole = leaves.filter((element) => own(element) === text.oldText)
      const part = leaves.filter((element) => own(element).includes(text.oldText))
      if (whole.length === 1) swap(whole[0])
      else if (
        whole.length === 0 &&
        part.length === 1 &&
        own(part[0]).split(text.oldText).length === 2
      )
        swap(part[0])
      // 人在画布上双击改的:DOM 里已经是新字了
      else if (
        part.length === 0 &&
        leaves.filter((element) => own(element) === text.newText).length === 1
      ) {
        // 什么都不用换
      } else return false
    }
    patchedRevision = revision
    return true
  }
  window.addEventListener('resize', refresh)
  window.Reveal?.on?.('slidechanged', clear)
  window.__orcaCanvas = {
    inspect,
    select,
    locate,
    mark,
    patch,
    revision: renderedRevision,
    dispose: () => {
      clear()
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('resize', refresh)
      window.Reveal?.off?.('slidechanged', clear)
    },
  }
})()
