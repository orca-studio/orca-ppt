import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fromPlan, parsePlanComment, readTransitionPlan } from './transitions.js'

const COMMENT = `<!-- 转场计划（主题 Editorial Forest，版式 standard）
1→2  关系：封面标题下那条装饰横线长成时间线的轴        手法：形态变换            共享：axis
2→3  关系：同一条轴，换一组节点内容                    手法：元素交接
注：本稿验证两个新页面类型。
-->`

describe('parsePlanComment', () => {
  it('一行一次翻页,页号换成从 0 数起', () => {
    expect(parsePlanComment(COMMENT).map((t) => [t.from, t.to])).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('关系和手法各归各的', () => {
    const [first] = parsePlanComment(COMMENT)
    expect(first?.relation).toBe('封面标题下那条装饰横线长成时间线的轴')
    expect(first?.technique).toBe('形态变换')
    expect(first?.anchor).toBe('axis')
  })

  it('没有锚那一栏就不编一个', () => {
    expect(parsePlanComment(COMMENT)[1]?.anchor).toBeUndefined()
  })

  it('「注:」那行不是转场', () => {
    expect(parsePlanComment(COMMENT)).toHaveLength(2)
  })

  it('手法是自然语言就原样留着 —— 八项枚举装不下', () => {
    const html = `<!-- 转场计划
1→2  关系：圆变成屏幕        手法：遮挡 + 形态变换   锚点：lens → screen
2→3  关系：钻进去            手法：整页推近
-->`
    expect(parsePlanComment(html).map((t) => t.technique)).toEqual(['遮挡 + 形态变换', '整页推近'])
  })

  it('手法带括号说明也完整留着', () => {
    const html = `<!-- 转场计划
1→2  关系：换场         手法：遮挡剪辑（燕麦米色块上扫）
-->`
    expect(parsePlanComment(html)[0]?.technique).toBe('遮挡剪辑（燕麦米色块上扫）')
  })

  it('-> 和 → 都认', () => {
    expect(parsePlanComment('<!-- 转场计划\n1->2  关系：x  手法：y\n-->')).toHaveLength(1)
  })

  it('没有这段注释就是空的,不抛', () => {
    expect(parsePlanComment('<html></html>')).toEqual([])
  })
})

describe('fromPlan', () => {
  it('枚举翻成中文名', () => {
    expect(
      fromPlan([
        { from: 0, to: 1, relation: '同一条轴', technique: 'morph', anchorSelector: '#axis' },
      ]),
    ).toEqual([{ from: 0, to: 1, relation: '同一条轴', technique: '形态变换', anchor: '#axis' }])
  })
})

describe('readTransitionPlan', () => {
  it('plan.json 优先 —— 那是定下来的,注释是顺手记的', () => {
    const plan = readTransitionPlan({
      transitions: [{ from: 0, to: 1, relation: '从 plan', technique: 'handoff' }],
      html: COMMENT,
    })
    expect(plan).toEqual([{ from: 0, to: 1, relation: '从 plan', technique: '元素交接' }])
  })

  it('没有 plan.json 就读注释', () => {
    expect(readTransitionPlan({ transitions: [], html: COMMENT })).toHaveLength(2)
  })

  it('两个都没有就是空的', () => {
    expect(readTransitionPlan({ transitions: [], html: undefined })).toEqual([])
  })
})

/** 拿真实的稿子验一遍 —— 格式是人手写的,只测自己编的样例说明不了问题。 */
describe('真实示例', () => {
  // 仓内的 skills/orca-ppt/(并仓之前读的是 ghq 下的独立仓)
  const skill = fileURLToPath(new URL('../../../skills/orca-ppt', import.meta.url))
  const cases: Array<[string, number]> = [
    ['examples/forest-timeline', 6],
    ['examples/emerald-editorial', 6],
    ['examples/story-circle', 5],
    ['examples/spec-wall', 6],
    // 计划注释后面跟着「数据来源」那几行 —— 它们不该被读成翻页
    ['recipes/data-report', 6],
    // 同一种手法连续六次,计划后面还有几行几何说明
    ['recipes/ring-timeline', 6],
    // 手法里有「+」连起来的几种,共享一栏用分号分组
    ['recipes/digit-roll', 6],
    // 计划前面先有几行页内动画说明,它们没有页号箭头
    ['recipes/spotlight-opening', 5],
  ]

  it.each(cases)('%s 解析出 %i 次翻页,每条都有关系和手法', async (name, count) => {
    let html: string
    try {
      html = await readFile(join(skill, name, 'index.html'), 'utf8')
    } catch {
      // skill 没装在默认位置就跳过 —— 这条是环境依赖的,不该让整套测试红
      return
    }
    const plan = parsePlanComment(html)
    expect(plan).toHaveLength(count)
    for (const note of plan) {
      expect(note.relation.length).toBeGreaterThan(0)
      expect(note.technique.length).toBeGreaterThan(0)
      expect(note.to).toBe(note.from + 1)
    }
  })
})
