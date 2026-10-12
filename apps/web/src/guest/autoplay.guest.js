/**
 * 自动播放。注入到放映的 guest 里跑,所以这份文件是纯 JS、不 import 任何东西。
 *
 * 每页停多久用稿子自己声明的 `data-hold`(秒)—— 那是作者写给录制用的"这一页需要几秒",
 * 自动播放要的是同一个数,不该另发明一个。转场时长同理,用 `data-auto-animate-duration`。
 *
 * 放在**观看端**而不是 engine.js 里:自动播放是看的人的选择,不是稿子的属性。
 * 同一份稿子在浏览器里打开仍然是手动翻页。
 */
;(() => {
  const DEFAULT_HOLD = 1.5
  const DEFAULT_TRANSITION = 0.9
  /** 页内动画放完一步后停多久再按下一下(毫秒)。 */
  const STEP_HOLD_MS = 800

  let timer
  let running = false

  const seconds = (element, attribute, fallback) => {
    const raw = element?.getAttribute(attribute)
    const value = raw === null || raw === undefined ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }

  /** 这一页该停多久:转场放完,再按 data-hold 停住。 */
  function dwellMs(slide) {
    const transition = seconds(slide, 'data-auto-animate-duration', DEFAULT_TRANSITION)
    const hold = seconds(slide, 'data-hold', DEFAULT_HOLD)
    return (transition + hold) * 1000
  }

  function step() {
    if (!running) return
    const indices = window.Reveal.getIndices()
    // 最后一页停住,不绕回开头 —— 放完了就是放完了。
    if (indices.h >= window.Reveal.getTotalSlides() - 1) {
      stop()
      return
    }
    // 页内动画还没放完这一步:等它放完再多停一会儿,别把它压掉
    const busy = window.__orcaBusy ? window.__orcaBusy() : 0
    if (busy > 0) {
      clearTimeout(timer)
      timer = setTimeout(step, busy * 1000 + STEP_HOLD_MS)
      return
    }
    // 走引擎的 advance:转场还没放完就翻,它会先把剩下的放完,不跳帧。老稿子没有就退回 Reveal
    // 返回 "step" 是这一下被页内动画的点击分步吃掉了,还在这一页:放完那一步再说
    const result = window.__orcaAdvance ? window.__orcaAdvance() : window.Reveal.next()
    if (result === 'step') {
      clearTimeout(timer)
      timer = setTimeout(step, 50)
      return
    }
    schedule()
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(step, dwellMs(window.Reveal.getCurrentSlide()))
  }

  function start() {
    if (running || !window.Reveal) return
    running = true
    schedule()
  }

  function stop() {
    running = false
    clearTimeout(timer)
  }

  // 人一动手就停 —— 自动播着还跟你抢翻页是最烦的。
  for (const event of ['keydown', 'pointerdown', 'wheel']) {
    document.addEventListener(event, stop, true)
  }

  window.__orcaAutoplay = { start, stop, running: () => running, dwellMs }

  // 每次翻页报一声页号。宿主能听到的只有 console-message(preload 是剥掉的,没有别的通道)——
  // 不报的话,人在画布里按键、自动播放翻的页,状态栏和页胶片都不知道,页码就对不上。
  if (window.Reveal?.on && !window.__orcaSlideReport) {
    window.__orcaSlideReport = true
    window.Reveal.on('slidechanged', (event) => console.debug('__orca:slide ' + event.indexh))
  }
})()
