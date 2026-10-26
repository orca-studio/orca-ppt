// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import source from './edit.guest.js?raw'

/**
 * 直接 eval 真正要注入的那份脚本 —— 不写一份平行实现来测,否则测过的和跑的不是同一个东西。
 */
declare global {
  interface Window {
    __orcaEdit: {
      arm(): Promise<any>
      disarm(): void
      notify(message: string): void
      editabilityOf(element: Element | null): { ok: boolean; reason?: string }
      editing(): boolean
      armed(): boolean
    }
  }
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div class="slides">${html}</div>`
  return document.body.firstElementChild as HTMLElement
}

function dblclick(element: Element) {
  element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

function key(element: Element, k: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete window.Reveal
  window.__orcaAutoplay = undefined as unknown as typeof window.__orcaAutoplay
  // jsdom 不实现 contenteditable 的焦点行为,这里只关心我们自己那套状态机。
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
})

describe('editabilityOf', () => {
  it('纯文字元素可以改', () => {
    const root = mount('<section><p>走过的四站。</p></section>')
    expect(window.__orcaEdit.editabilityOf(root.querySelector('p'))).toEqual({ ok: true })
  })

  it('里面套着别的元素就拒绝 —— data-carry 这些是转场靠的,不猜', () => {
    const root = mount('<section><p>走过的<span data-carry="x">四站</span></p></section>')
    const verdict = window.__orcaEdit.editabilityOf(root.querySelector('p'))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('agent')
  })

  it('<br> 也算套着元素', () => {
    const root = mount('<section><p>上<br>下</p></section>')
    expect(window.__orcaEdit.editabilityOf(root.querySelector('p')).ok).toBe(false)
  })

  it('图形改不了字', () => {
    const root = mount('<section><img src="a.png" alt=""></section>')
    const verdict = window.__orcaEdit.editabilityOf(root.querySelector('img'))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('图形')
  })

  it('空元素没有可改的', () => {
    const root = mount('<section><p>   </p></section>')
    expect(window.__orcaEdit.editabilityOf(root.querySelector('p')).ok).toBe(false)
  })

  it('整页不给改 —— 让人双击具体那行字', () => {
    const root = mount('<section><p>文字</p></section>')
    expect(window.__orcaEdit.editabilityOf(root.querySelector('section')).ok).toBe(false)
  })
})

describe('就地编辑', () => {
  it('双击改完回车,给出这一处改动', async () => {
    const root = mount('<section><p>走过的四站。</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()

    dblclick(p)
    expect(window.__orcaEdit.editing()).toBe(true)
    expect(p.getAttribute('contenteditable')).toBe('plaintext-only')

    p.textContent = '四站,一年'
    key(p, 'Enter')

    await expect(pending).resolves.toEqual({
      slide: 0,
      oldText: '走过的四站。',
      newText: '四站,一年',
    })
    // 改完要把 contenteditable 摘干净,别留在稿子的 DOM 上。
    expect(p.hasAttribute('contenteditable')).toBe(false)
    expect(window.__orcaEdit.editing()).toBe(false)
  })

  it('页号跟着 Reveal 走', async () => {
    window.Reveal = { getIndices: () => ({ h: 3 }) }
    const root = mount('<section><p>标题</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    p.textContent = '新标题'
    key(p, 'Enter')
    await expect(pending).resolves.toMatchObject({ slide: 3 })
  })

  it('Esc 撤回原文,不提交', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    p.textContent = '改坏了'
    key(p, 'Escape')
    await expect(pending).resolves.toBeNull()
    expect(p.textContent).toBe('原文')
  })

  it('没改动就不提交 —— 别为了一次双击白写一遍盘', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    key(p, 'Enter')
    await expect(pending).resolves.toBeNull()
  })

  it('改成空的按手滑处理,把原文还回去', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    p.textContent = ''
    key(p, 'Enter')
    await expect(pending).resolves.toBeNull()
    expect(p.textContent).toBe('原文')
  })

  it('失焦也算提交 —— 人改完点别处是常事', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    p.textContent = '改好了'
    p.dispatchEvent(new FocusEvent('blur'))
    await expect(pending).resolves.toMatchObject({ newText: '改好了' })
  })

  it('改不了的元素给一句人话,不是默默没反应', () => {
    const root = mount('<section><p>走<span>过</span></p></section>')
    void window.__orcaEdit.arm()
    dblclick(root.querySelector('p')!)
    expect(window.__orcaEdit.editing()).toBe(false)
    expect(document.getElementById('__orca-edit-hint')?.textContent).toContain('agent')
  })

  it('开始改字就把自动播放停掉 —— 翻页会把正在改的那页带走', () => {
    const stop = vi.fn()
    window.__orcaAutoplay = { stop } as unknown as typeof window.__orcaAutoplay
    const root = mount('<section><p>原文</p></section>')
    void window.__orcaEdit.arm()
    dblclick(root.querySelector('p')!)
    expect(stop).toHaveBeenCalled()
  })

  it('服务端拒绝时,理由摆回人刚才双击的那处', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    p.textContent = '改好了'
    key(p, 'Enter')
    await pending
    window.__orcaEdit.notify('这一页里有好几处一样的文字')
    expect(document.getElementById('__orca-edit-hint')?.textContent).toContain('好几处')
  })

  it('disarm 把待决的 Promise 解成 null,不留吊着的 Promise', async () => {
    mount('<section><p>原文</p></section>')
    const pending = window.__orcaEdit.arm()
    window.__orcaEdit.disarm()
    await expect(pending).resolves.toBeNull()
    expect(window.__orcaEdit.armed()).toBe(false)
  })

  it('disarm 时正在改的那处按放弃处理,属性要摘掉', async () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    const pending = window.__orcaEdit.arm()
    dblclick(p)
    window.__orcaEdit.disarm()
    await expect(pending).resolves.toBeNull()
    expect(p.hasAttribute('contenteditable')).toBe(false)
  })

  it('重复 arm 不会留下吊着的 Promise', async () => {
    mount('<section><p>原文</p></section>')
    const first = window.__orcaEdit.arm()
    void window.__orcaEdit.arm()
    await expect(first).resolves.toBeNull()
  })

  it('重复注入要能覆盖 —— 否则一次双击会进两个互不相识的编辑状态', () => {
    const root = mount('<section><p>原文</p></section>')
    const p = root.querySelector('p')!
    void window.__orcaEdit.arm()
    // 再注入一份(重载之外,热更新也会走到这儿)
    // eslint-disable-next-line no-eval
    ;(0, eval)(source)
    void window.__orcaEdit.arm()
    dblclick(p)
    window.__orcaEdit.disarm()
    expect(p.hasAttribute('contenteditable')).toBe(false)
  })

  it('没 arm 的时候双击不进编辑', () => {
    const root = mount('<section><p>原文</p></section>')
    dblclick(root.querySelector('p')!)
    expect(window.__orcaEdit.editing()).toBe(false)
  })
})
