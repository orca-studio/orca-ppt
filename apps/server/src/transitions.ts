import type { TransitionNote } from '@orca-ppt/contracts'
import type { Transition } from '@orca-ppt/contracts'

/**
 * 稿子里的转场计划。
 *
 * 两个来源:我们的五阶段会写 `.deck/plan.json`;skill 做出来的稿子把计划写在 HTML
 * 注释里。两边都要认,不然打开任何一份现成稿子,时间轴都是空的。
 *
 * **不把手法硬塞进枚举。** 注释里的手法是人写的自然语言 —— 「整页推近」「推近式匹配剪辑」
 * 「遮挡 + 形态变换」,八项枚举装不下。按作者自己的话显示才对:时间轴的意义就是看见
 * 当时是怎么想的。
 */

/** 枚举值对应的中文名,给 plan.json 那一路显示用。 */
const TECHNIQUE_LABEL: Record<Transition['technique'], string> = {
  'shared-element': '共享元素',
  morph: '形态变换',
  'one-to-many': '一变多',
  handoff: '元素交接',
  'match-zoom': '匹配放大',
  'match-cut': '匹配剪辑',
  'mask-cut': '遮挡剪辑',
  'replace-in-place': '原地替换',
}

export function fromPlan(transitions: Transition[]): TransitionNote[] {
  return transitions.map((transition) => ({
    from: transition.from,
    to: transition.to,
    relation: transition.relation,
    technique: TECHNIQUE_LABEL[transition.technique],
    ...(transition.anchorSelector ? { anchor: transition.anchorSelector } : {}),
  }))
}

/**
 * 从 HTML 注释里解析转场计划。
 *
 * 格式(skill 的写法):`1→2  关系:…  手法:…  共享:…`
 * 页号从 1 数起,我们内部一律从 0 数起。
 */
export function parsePlanComment(html: string): TransitionNote[] {
  const comment = html.match(/<!--\s*转场计划[\s\S]*?-->/)
  if (!comment) return []

  const notes: TransitionNote[] = []
  for (const line of comment[0].split('\n')) {
    // 页号之间可能是 → 或 ->
    const head = line.match(/^\s*(\d+)\s*(?:→|->)\s*(\d+)\s+(.*)$/)
    if (!head) continue

    const from = Number(head[1]) - 1
    const to = Number(head[2]) - 1
    if (from < 0 || to < 0) continue

    const rest = head[3] ?? ''
    // 「手法」之后到行尾,但后面可能还挂着「共享:」「锚点:」这类字段
    const parts = rest.split(/手法\s*[:：]\s*/)
    const relation = (parts[0] ?? '').replace(/^\s*关系\s*[:：]\s*/, '').trim()
    const tail = parts[1] ?? ''

    // 两个以上空格 + 「某某:」= 下一个字段开始了
    const split = tail.match(/^(.*?)(?:\s{2,}[^\s:：]+\s*[:：]\s*(.*))?$/)
    notes.push({
      from,
      to,
      relation,
      technique: (split?.[1] ?? tail).trim(),
      ...(split?.[2]?.trim() ? { anchor: split[2].trim() } : {}),
    })
  }
  return notes
}

/** plan.json 优先 —— 那是我们自己定下来的,注释是稿子里顺手记的。 */
export function readTransitionPlan(options: {
  transitions: Transition[]
  html?: string | undefined
}): TransitionNote[] {
  if (options.transitions.length > 0) return fromPlan(options.transitions)
  return options.html ? parsePlanComment(options.html) : []
}
