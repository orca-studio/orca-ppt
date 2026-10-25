// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import source from './canvas.guest.js?raw'

/** 直接 eval 真正要注入的那份脚本,不写平行实现。 */
declare global {
  interface Window {
    __orcaCanvas: {
      patch(input: {
        before: string | null
        revision: string
        text?: { slide: number; oldText: string; newText: string }
      }): boolean
      revision(): string | null
      dispose(): void
    }
  }
}

const DECK =
  '<div class="reveal"><div class="slides">' +
  '<section><p>封面</p></section>' +
  '<section><span>1970</span><h2>东方红一号</h2><p>东方红一号发射成功。</p><p>重复</p><p>重复</p></section>' +
  '</div></div>'

/** jsdom 里没有导航条目,脚本一开始报不出版本:先认下一版当起点。 */
function start(): void {
  expect(window.__orcaCanvas.patch({ before: null, revision: 'r1' })).toBe(true)
}

beforeEach(() => {
  window.__orcaCanvas?.dispose()
  document.body.innerHTML = DECK
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
  start()
})

const text = (selector: string, index = 0) =>
  document.querySelectorAll('.slides > section')[1]!.querySelectorAll(selector)[index]!.textContent

describe('就地换字,不重载', () => {
  it('整段对得上就换掉,版本跟着走', () => {
    const done = window.__orcaCanvas.patch({
      before: 'r1',
      revision: 'r2',
      text: { slide: 1, oldText: '1970', newText: '1970 年' },
    })
    expect(done).toBe(true)
    expect(text('span')).toBe('1970 年')
    expect(window.__orcaCanvas.revision()).toBe('r2')
  })

  it('只是一段字里的一部分,也只换那一部分', () => {
    window.__orcaCanvas.patch({
      before: 'r1',
      revision: 'r2',
      text: { slide: 1, oldText: '发射成功', newText: '成功入轨' },
    })
    expect(text('p')).toBe('东方红一号成功入轨。')
  })

  it('版本对不上不换 —— 中间还有别的改动没到画布上', () => {
    const done = window.__orcaCanvas.patch({
      before: 'r0',
      revision: 'r2',
      text: { slide: 1, oldText: '1970', newText: '1971' },
    })
    expect(done).toBe(false)
    expect(text('span')).toBe('1970')
    expect(window.__orcaCanvas.revision()).toBe('r1')
  })

  it('一页里有好几处一样的,认不准就不换', () => {
    const done = window.__orcaCanvas.patch({
      before: 'r1',
      revision: 'r2',
      text: { slide: 1, oldText: '重复', newText: '唯一' },
    })
    expect(done).toBe(false)
    expect(window.__orcaCanvas.revision()).toBe('r1')
  })

  it('人在画布上双击改的:DOM 里已经是新字,只认下版本', () => {
    document.querySelector('h2')!.textContent = '神舟五号'
    const done = window.__orcaCanvas.patch({
      before: 'r1',
      revision: 'r2',
      text: { slide: 1, oldText: '东方红一号', newText: '神舟五号' },
    })
    expect(done).toBe(true)
    expect(text('h2')).toBe('神舟五号')
  })

  it('新文字里的 $ 原样写进去', () => {
    window.__orcaCanvas.patch({
      before: 'r1',
      revision: 'r2',
      text: { slide: 1, oldText: '1970', newText: '$& 元' },
    })
    expect(text('span')).toBe('$& 元')
  })

  it('页面之外的改动(转场计划)只认下版本', () => {
    expect(window.__orcaCanvas.patch({ before: 'r1', revision: 'r2' })).toBe(true)
    expect(window.__orcaCanvas.revision()).toBe('r2')
  })
})
