// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import source from './inspect.guest.js?raw'

/**
 * 直接 eval 真正要注入的那份脚本 —— 不写一份平行实现来测,否则测过的和跑的不是同一个东西。
 */
declare global {
  interface Window {
    __orcaInspect: {
      arm(): Promise<unknown>
      disarm(): void
      anchorFor(element: Element): any
      selectorFor(element: Element): string
      armed(): boolean
    }
    Reveal?: any
  }
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

function stubRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, ...rect }) as DOMRect
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete window.Reveal
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
})

describe('selectorFor', () => {
  it('优先用 id', () => {
    const root = mount('<div><h2 id="headline">标题</h2></div>')
    expect(window.__orcaInspect.selectorFor(root.querySelector('h2')!)).toBe('#headline')
  })

  it('其次用 data-anchor —— skill 的模板给关键元素打这个', () => {
    const root = mount('<div><h2 data-anchor="lead">标题</h2></div>')
    expect(window.__orcaInspect.selectorFor(root.querySelector('h2')!)).toBe('[data-anchor="lead"]')
  })

  it('退到 nth-child 路径,不用类名 —— 主题一换类名就变了', () => {
    const root = mount('<section><p class="a">一</p><p class="b">二</p></section>')
    const selector = window.__orcaInspect.selectorFor(root.querySelectorAll('p')[1]!)
    expect(selector).toContain('p:nth-child(2)')
    expect(selector).not.toContain('.b')
    expect(document.querySelector(selector)?.textContent).toBe('二')
  })

  it('路径到所在那一页为止 —— 不爬到 html', () => {
    const root = mount(
      '<div class="reveal"><div class="slides">' +
        '<section><div><p>一</p><p>二</p></div></section>' +
        '</div></div>',
    )
    const selector = window.__orcaInspect.selectorFor(root.querySelectorAll('p')[1]!)
    expect(selector).toBe('div:nth-child(1) > p:nth-child(2)')
    expect(selector).not.toContain('html')
    expect(selector).not.toContain('body')
    // 在那一页范围内选得回来
    expect(root.querySelector('section')!.querySelector(selector)?.textContent).toBe('二')
  })

  it('元素自己就在页根上时给出标签名', () => {
    const root = mount('<div class="slides"><section><h1>标题</h1></section></div>')
    expect(window.__orcaInspect.selectorFor(root.querySelector('h1')!)).toBe('h1:nth-child(1)')
  })
})

describe('anchorFor', () => {
  it('几何按 reveal 的缩放比还原回 1920×1080', () => {
    window.Reveal = { getScale: () => 0.5, getIndices: () => ({ h: 3 }) }
    const root = mount('<div><h2 id="t">标题</h2></div>')
    const element = root.querySelector('h2')!
    stubRect(element, { x: 90, y: 110, width: 780, height: 60 })

    const anchor = window.__orcaInspect.anchorFor(element)
    expect(anchor.box).toEqual({ x: 180, y: 220, w: 1560, h: 120 })
    expect(anchor.slide).toBe(3)
  })

  it('同时给出视口坐标 —— 宿主按它截图', () => {
    window.Reveal = { getScale: () => 0.5, getIndices: () => ({ h: 0 }) }
    const root = mount('<div><h2>标题</h2></div>')
    const element = root.querySelector('h2')!
    stubRect(element, { x: 90, y: 110, width: 780, height: 60 })
    expect(window.__orcaInspect.anchorFor(element).viewportBox).toEqual({
      x: 90,
      y: 110,
      w: 780,
      h: 60,
    })
  })

  it('不是 reveal 稿时按视口宽度推缩放比', () => {
    const root = mount('<div><h2>标题</h2></div>')
    const element = root.querySelector('h2')!
    stubRect(element, { x: 100, y: 0, width: 100, height: 10 })
    // jsdom 默认 innerWidth 1024 → 比例 1024/1920
    const anchor = window.__orcaInspect.anchorFor(element)
    expect(anchor.box.x).toBe(Math.round(100 / (1024 / 1920)))
  })

  it('过长的文本截断,空元素不带 text', () => {
    const root = mount(`<div><p>${'字'.repeat(200)}</p><hr /></div>`)
    const p = root.querySelector('p')!
    const hr = root.querySelector('hr')!
    stubRect(p, { width: 10, height: 10 })
    stubRect(hr, { width: 10, height: 2 })
    expect(window.__orcaInspect.anchorFor(p).text).toHaveLength(81)
    expect(window.__orcaInspect.anchorFor(hr).text).toBeUndefined()
  })
})

describe('arm', () => {
  it('点中元素时给出锚', async () => {
    window.Reveal = { getScale: () => 1, getIndices: () => ({ h: 2 }) }
    const root = mount('<div><h2 id="t">太挤了</h2></div>')
    const element = root.querySelector('h2')!
    stubRect(element, { x: 10, y: 20, width: 100, height: 30 })

    const pending = window.__orcaInspect.arm()
    expect(window.__orcaInspect.armed()).toBe(true)
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const anchor = (await pending) as any
    expect(anchor).toMatchObject({ slide: 2, selector: '#t', text: '太挤了' })
    expect(window.__orcaInspect.armed()).toBe(false)
  })

  it('Esc 取消,给出 null', async () => {
    mount('<div><h2>x</h2></div>')
    const pending = window.__orcaInspect.arm()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(await pending).toBeNull()
  })

  it('取消之后不再拦截点击 —— 稿子自己的交互要还回去', async () => {
    const root = mount('<div><button id="b">按钮</button></div>')
    const button = root.querySelector('button')!
    stubRect(button, { width: 10, height: 10 })

    const pending = window.__orcaInspect.arm()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await pending

    let clicked = false
    button.addEventListener('click', () => (clicked = true))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicked).toBe(true)
  })

  it('取锚时拦住稿子自己的 click', async () => {
    const root = mount('<div><button id="b">按钮</button></div>')
    const button = root.querySelector('button')!
    stubRect(button, { width: 10, height: 10 })
    let clicked = false
    button.addEventListener('click', () => (clicked = true))

    const pending = window.__orcaInspect.arm()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await pending
    expect(clicked).toBe(false)
  })

  it('重复 arm 不会留下两套监听', async () => {
    const root = mount('<div><h2 id="t">x</h2></div>')
    const element = root.querySelector('h2')!
    stubRect(element, { width: 10, height: 10 })

    const first = window.__orcaInspect.arm()
    const second = window.__orcaInspect.arm()
    expect(await first).toBeNull()

    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await second).toMatchObject({ selector: '#t' })
  })

  it('高亮框自己不会被选中', async () => {
    mount('<div><h2 id="t">x</h2></div>')
    const pending = window.__orcaInspect.arm()
    const box = document.getElementById('__orca-highlight')!
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 高亮框被忽略,锚还没产生
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(await pending).toBeNull()
  })
})
