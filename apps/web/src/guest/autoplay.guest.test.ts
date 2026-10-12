// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import source from './autoplay.guest.js?raw'

declare global {
  interface Window {
    __orcaAutoplay: {
      start(): void
      stop(): void
      running(): boolean
      dwellMs(slide: Element | null): number
    }
    Reveal?: any
  }
}

/** 一份假的 reveal:只实现自动播放用得到的那几个方法。 */
function fakeReveal(holds: Array<Record<string, string>>) {
  let index = 0
  const slides = holds.map((attrs) => {
    const section = document.createElement('section')
    for (const [key, value] of Object.entries(attrs)) section.setAttribute(key, value)
    return section
  })
  return {
    getIndices: () => ({ h: index }),
    getTotalSlides: () => slides.length,
    getCurrentSlide: () => slides[index] ?? null,
    next: () => {
      index += 1
    },
    at: () => index,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
})

afterEach(() => {
  window.__orcaAutoplay?.stop()
  vi.useRealTimers()
})

describe('自动播放', () => {
  it('停留时长 = 转场 + data-hold,用稿子自己声明的数', () => {
    const slide = document.createElement('section')
    slide.setAttribute('data-auto-animate-duration', '1.2')
    slide.setAttribute('data-hold', '2.5')
    expect(window.__orcaAutoplay.dwellMs(slide)).toBe(3700)
  })

  it('没写就用默认 0.9 + 1.5', () => {
    expect(window.__orcaAutoplay.dwellMs(document.createElement('section'))).toBe(2400)
  })

  it('写了垃圾值不至于算出 NaN 卡死', () => {
    const slide = document.createElement('section')
    slide.setAttribute('data-hold', '很久')
    expect(window.__orcaAutoplay.dwellMs(slide)).toBe(2400)
  })

  it('按各页自己的时长依次往后翻', () => {
    window.Reveal = fakeReveal([{ 'data-hold': '1' }, { 'data-hold': '2' }, { 'data-hold': '1' }])
    window.__orcaAutoplay.start()

    vi.advanceTimersByTime(1900) // 0.9 + 1 = 1.9s
    expect(window.Reveal.at()).toBe(1)
    vi.advanceTimersByTime(2800) // 0.9 + 2 = 2.9s,还差一点
    expect(window.Reveal.at()).toBe(1)
    vi.advanceTimersByTime(200)
    expect(window.Reveal.at()).toBe(2)
  })

  it('放到最后一页就停住,不绕回开头', () => {
    window.Reveal = fakeReveal([{ 'data-hold': '1' }, { 'data-hold': '1' }])
    window.__orcaAutoplay.start()
    vi.advanceTimersByTime(20_000)
    expect(window.Reveal.at()).toBe(1)
    expect(window.__orcaAutoplay.running()).toBe(false)
  })

  it('人一动手就停 —— 自动播着还跟你抢翻页最烦', () => {
    window.Reveal = fakeReveal([{ 'data-hold': '1' }, { 'data-hold': '1' }, { 'data-hold': '1' }])
    window.__orcaAutoplay.start()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(window.__orcaAutoplay.running()).toBe(false)

    vi.advanceTimersByTime(20_000)
    expect(window.Reveal.at()).toBe(0)
  })

  it('重复 start 不会叠出两条定时器', () => {
    window.Reveal = fakeReveal([{ 'data-hold': '1' }, { 'data-hold': '1' }, { 'data-hold': '1' }])
    window.__orcaAutoplay.start()
    window.__orcaAutoplay.start()
    vi.advanceTimersByTime(1900)
    expect(window.Reveal.at()).toBe(1)
  })

  it('没有 Reveal 时 start 不炸', () => {
    delete window.Reveal
    expect(() => window.__orcaAutoplay.start()).not.toThrow()
  })
})

describe('点击分步报给宿主', () => {
  it('引擎发 orca:step,guest 转成一条宿主听得到的 console 消息', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    delete (window as any).__orcaSlideReport
    window.Reveal = { ...fakeReveal([{}]), on: vi.fn() }
    // eslint-disable-next-line no-eval
    ;(0, eval)(source)
    document.dispatchEvent(new CustomEvent('orca:step', { detail: { done: 1, clicks: 3 } }))
    expect(debug).toHaveBeenCalledWith('__orca:step 1 3')
    debug.mockRestore()
  })
})
