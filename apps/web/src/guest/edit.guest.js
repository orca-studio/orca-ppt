/**
 * 就地改字。注入到放映画布的 guest 里跑,所以这份文件是纯 JS、不 import 任何东西。
 *
 * 双击一处文字 → 原地改 → Enter / 失焦提交 → 宿主让服务端在源文件里精确换掉那一段。
 * 大多数时候人要动的只是文案,不该为了改一个字去开编辑器、也不该劳驾 agent。
 *
 * **只认纯文本元素**。里面一旦还套着别的标签(`<br>`、嵌套 span、带 `data-id` /
 * `data-carry` 的元素),就拒绝 —— 那些属性正是转场靠的东西,contenteditable 一进去
 * 就可能把它们揉没,而且要等到放映才发现。这种就退回"点中它、让 agent 改"那条路。
 */
;(() => {
  // 重复注入要能覆盖:上一份的 dblclick 监听还挂在 document 上,不摘掉的话一次双击
  // 会进两个互不相识的编辑状态,后一个把前一个留下的 contenteditable 当"原样"存起来。
  if (window.__orcaEdit) window.__orcaEdit.disarm()

  const HINT_ID = '__orca-edit-hint'

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

  function currentSlide() {
    if (window.Reveal && window.Reveal.getIndices) return window.Reveal.getIndices().h
    return 0
  }

  /**
   * 能不能就地改。不能改的都给一句人话,提示里要直说,别让人对着没反应的双击发呆。
   */
  function editabilityOf(element) {
    if (!element || !element.tagName) return { ok: false, reason: '这儿没有可改的文字' }
    const tag = element.tagName
    if (tag === 'BODY' || tag === 'HTML' || tag === 'SECTION') {
      return { ok: false, reason: '双击具体的那行字' }
    }
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'SVG') {
      return { ok: false, reason: '这是图形,改不了字' }
    }
    if (element.children.length > 0) {
      // <br>、嵌套 span 都算。里面有标记就不猜。
      return { ok: false, reason: '这段里套着别的元素,交给 agent 改' }
    }
    if (!(element.textContent || '').trim()) return { ok: false, reason: '这儿没有文字' }
    return { ok: true }
  }

  /** 一闪而过的提示。改不了的时候得让人知道为什么。 */
  function flash(message, element) {
    let hint = document.getElementById(HINT_ID)
    if (!hint) {
      hint = document.createElement('div')
      hint.id = HINT_ID
      hint.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;padding:6px 10px;' +
        'border-radius:8px;background:rgba(20,20,22,.92);color:#fff;font:500 13px/1.3 ' +
        '-apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
        'transition:opacity .2s;white-space:nowrap'
      document.body.appendChild(hint)
    }
    const rect = element.getBoundingClientRect()
    hint.textContent = message
    hint.style.opacity = '1'
    hint.style.left = Math.round(rect.x) + 'px'
    hint.style.top = Math.max(8, Math.round(rect.y) - 34) + 'px'
    clearTimeout(hint.__timer)
    hint.__timer = setTimeout(() => {
      hint.style.opacity = '0'
    }, 1600)
  }

  let editing = null
  let pending = null
  /** 最后改过的那个元素 —— 服务端拒绝时,提示要回到人刚才双击的地方。 */
  let lastTouched = null

  /** 结束这一轮编辑。`result` 为 null 表示放弃(宿主不该写盘)。 */
  function finish(result) {
    const session = editing
    editing = null
    if (session) session.teardown()
    const resolve = pending
    pending = null
    if (resolve) resolve(result)
  }

  function beginEdit(element) {
    const verdict = editabilityOf(element)
    if (!verdict.ok) {
      flash(verdict.reason, element)
      return
    }
    // 人开始改字就别再自动播了 —— 翻页会把正在改的那页带走。
    if (window.__orcaAutoplay) window.__orcaAutoplay.stop()

    const slide = currentSlide()
    const oldText = (element.textContent || '').trim()
    const previousEditable = element.getAttribute('contenteditable')

    const commit = () => {
      if (editing !== session) return
      const newText = (element.textContent || '').trim()
      if (!newText) {
        // 清空多半是手滑。原样还回去,不把一页文字弄丢。
        element.textContent = oldText
        flash('不能改成空的', element)
        finish(null)
        return
      }
      lastTouched = element
      finish(newText === oldText ? null : { slide, oldText, newText })
    }

    const cancel = () => {
      if (editing !== session) return
      element.textContent = oldText
      finish(null)
    }

    const onKey = (event) => {
      if (event.key === 'Enter') {
        // 只改一行字,回车就是提交 —— 别往稿子里塞换行。
        event.preventDefault()
        element.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        // 稿子自己可能拿 Esc 退全屏,别让它也收到。
        event.stopPropagation()
        cancel()
      }
    }

    const session = {
      element,
      teardown: () => {
        element.removeEventListener('keydown', onKey, true)
        element.removeEventListener('blur', commit)
        if (previousEditable === null) element.removeAttribute('contenteditable')
        else element.setAttribute('contenteditable', previousEditable)
        element.style.outline = ''
        element.style.borderRadius = ''
      },
    }
    editing = session

    // plaintext-only:浏览器不会往里塞 <div>、<b> 这些标记,天然守住"只有文字"。
    element.setAttribute('contenteditable', 'plaintext-only')
    element.style.outline = '2px solid #4ade80'
    element.style.borderRadius = '2px'
    element.addEventListener('keydown', onKey, true)
    element.addEventListener('blur', commit)
    element.focus()

    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  const onDoubleClick = (event) => {
    if (editing) return
    const element = event.target
    if (!element || element.id === HINT_ID) return
    event.preventDefault()
    event.stopPropagation()
    beginEdit(element)
  }

  let on = false

  /**
   * 等下一次提交。返回的 Promise 在人改完一处文字时给出这处改动,放弃时给出 null。
   * 宿主拿到就写盘,然后再 arm 一次 —— 一次一处,免得两处改动挤在一起分不清先后。
   */
  function arm() {
    if (!on) {
      document.addEventListener('dblclick', onDoubleClick, true)
      on = true
    }
    // 上一轮还挂着就先解掉,不然宿主手里会留一个永远不 settle 的 Promise。
    if (pending) finish(null)
    return new Promise((resolve) => {
      pending = resolve
    })
  }

  /** 收起就地编辑。正在改的那处按放弃处理。 */
  function disarm() {
    if (on) {
      document.removeEventListener('dblclick', onDoubleClick, true)
      on = false
    }
    if (editing) {
      editing.teardown()
      editing = null
    }
    const resolve = pending
    pending = null
    if (resolve) resolve(null)
  }

  /**
   * 把某段文字所在的那个元素点亮一下。agent 改完一处,人得当场看见改的是哪儿 ——
   * 页胶片上圈出"哪一页"还不够,一页上有十几个元素。
   *
   * 按文字找,不按选择器:稿子刚被重载过,DOM 是新的,但文字就是 agent 刚写进去的那段。
   * 找不到就安静地什么都不做 —— 这只是个提示,不值得打扰人。
   */
  function spotlight(value) {
    const wanted = String(value == null ? '' : value).trim()
    if (!wanted) return false
    const slide =
      (window.Reveal && window.Reveal.getCurrentSlide && window.Reveal.getCurrentSlide()) ||
      document.body
    const hit = Array.prototype.find.call(slide.querySelectorAll('*'), (element) => {
      return element.children.length === 0 && (element.textContent || '').trim() === wanted
    })
    if (!hit) return false

    hit.style.animation = 'none'
    // 读一下强制重排,否则连着点两次同一处不会重放动画。
    void hit.offsetWidth
    hit.style.animation = '__orca-spotlight 1.2s ease'
    setTimeout(() => {
      hit.style.animation = ''
    }, 1300)
    return true
  }

  /** 动画的 keyframes 得在稿子自己的文档里,注入一次就够。 */
  function ensureKeyframes() {
    if (document.getElementById('__orca-edit-style')) return
    const style = document.createElement('style')
    style.id = '__orca-edit-style'
    style.textContent =
      '@keyframes __orca-spotlight{' +
      '0%{outline:3px solid rgba(129,140,248,.95);outline-offset:6px}' +
      '70%{outline:3px solid rgba(129,140,248,.55);outline-offset:3px}' +
      '100%{outline:3px solid rgba(129,140,248,0);outline-offset:2px}}'
    document.head.appendChild(style)
  }

  /** 服务端把这次改动拒了,把理由摆回人刚才双击的那处。 */
  function notify(message) {
    const element = lastTouched && lastTouched.isConnected ? lastTouched : document.body
    flash(message, element)
  }

  ensureKeyframes()

  window.__orcaEdit = {
    arm,
    disarm,
    notify,
    spotlight,
    editabilityOf,
    editing: () => editing !== null,
    armed: () => on,
  }
})()
