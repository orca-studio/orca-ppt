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
  const renderedRevision = () => {
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
  window.addEventListener('resize', refresh)
  window.Reveal?.on?.('slidechanged', clear)
  window.__orcaCanvas = {
    inspect,
    select,
    dispose: () => {
      clear()
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('resize', refresh)
      window.Reveal?.off?.('slidechanged', clear)
    },
  }
})()
