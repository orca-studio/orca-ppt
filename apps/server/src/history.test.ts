import { describe, expect, it } from 'vitest'
import { applyTextEdit } from '@orca-ppt/deck-core'
import { EditHistory } from './history.js'

const deck = (...sections: string[]) => `<div class="slides">${sections.join('')}</div>`

/** 照 server 的做法改一处字并记下来,返回改完的成品。 */
function edit(history: EditHistory, html: string, slide: number, oldText: string, newText: string) {
  const result = applyTextEdit(html, { slide, oldText, newText })
  if (!result.ok) throw new Error(result.reason)
  history.record({ slide, oldText, newText, before: html, after: result.html })
  return result.html
}

describe('EditHistory', () => {
  it('稿子没被别处动过,撤销原样还回改之前 —— 一个字节不差', () => {
    const history = new EditHistory()
    const original = deck('<section><p>甲</p>\n  <p>乙</p></section>')
    const edited = edit(history, original, 0, '甲', '丙')
    const undone = history.undo(edited)
    expect(undone.ok && undone.html).toBe(original)
  })

  it('在那之后别处改过,只把那段字换回去,不抹掉别处的改动', () => {
    const history = new EditHistory()
    const edited = edit(history, deck('<section><p>甲</p><p>乙</p></section>'), 0, '甲', '丙')
    const touched = edited.replace('乙', '丁') // agent 直接写了 HTML
    const undone = history.undo(touched)
    expect(undone.ok && undone.html).toBe(deck('<section><p>甲</p><p>丁</p></section>'))
  })

  it('连那段字都对不上就拒绝,那一步留着不丢', () => {
    const history = new EditHistory()
    const edited = edit(history, deck('<section><p>甲</p></section>'), 0, '甲', '丙')
    const gone = edited.replace('丙', '戊')
    const refused = history.undo(gone)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain('撤不回去')
    expect(history.state().canUndo).toBe(true)
  })

  it('撤两步按先后倒着撤,重做再按原顺序回来', () => {
    const history = new EditHistory()
    const v0 = deck('<section><p>一</p></section>', '<section><p>二</p></section>')
    const v1 = edit(history, v0, 0, '一', 'A')
    const v2 = edit(history, v1, 1, '二', 'B')

    const u1 = history.undo(v2)
    expect(u1.ok && u1.step.slide).toBe(1)
    const u2 = history.undo(u1.ok ? u1.html : '')
    expect(u2.ok && u2.html).toBe(v0)
    expect(history.undo(v0).ok).toBe(false)

    const r1 = history.redo(v0)
    expect(r1.ok && r1.html).toBe(v1)
    const r2 = history.redo(r1.ok ? r1.html : '')
    expect(r2.ok && r2.html).toBe(v2)
  })

  it('撤销之后又改了字,之前撤掉的就不能重做了', () => {
    const history = new EditHistory()
    const v1 = edit(history, deck('<section><p>一</p><p>二</p></section>'), 0, '一', 'A')
    const undone = history.undo(v1)
    expect(history.state().canRedo).toBe(true)
    edit(history, undone.ok ? undone.html : '', 0, '二', 'B')
    expect(history.state().canRedo).toBe(false)
  })

  it('状态里说清下一步撤的是哪一页哪段字', () => {
    const history = new EditHistory()
    expect(history.state()).toEqual({ canUndo: false, canRedo: false })
    edit(
      history,
      deck('<section></section>', '<section><p>旧标题</p></section>'),
      1,
      '旧标题',
      '新标题',
    )
    expect(history.state()).toEqual({
      canUndo: true,
      canRedo: false,
      undo: '第 2 页「新标题」→「旧标题」',
    })
  })
})

describe('structured edit history', () => {
  const step = {
    slide: 0,
    oldText: '',
    newText: '',
    before: 'before',
    after: 'after',
    label: '移动页面',
    files: { '.deck/plan.json': { before: 'old', after: 'new' } },
  }
  it('requires exact HTML and metadata, retaining rejected history', () => {
    const history = new EditHistory()
    history.record(step)
    expect(history.undo('external', { '.deck/plan.json': 'new' }).ok).toBe(false)
    expect(history.undo('after', { '.deck/plan.json': 'external' }).ok).toBe(false)
    expect(history.state().canUndo).toBe(true)
    const result = history.undo('after', { '.deck/plan.json': 'new' }, false)
    expect(result.ok && result.html).toBe('before')
    expect(history.state().canUndo).toBe(true)
    history.commit('undo')
    expect(history.state().redo).toBe('移动页面')
    expect(history.redo('before', { '.deck/plan.json': 'old' }).ok).toBe(true)
  })
})
