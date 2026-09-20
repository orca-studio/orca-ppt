import { Brief, DeckPhase, Slide, Technique, Transition } from '@orca-ppt/contracts'
import { z } from 'zod'
import { validateOutline } from './phases.js'

/**
 * 阶段产物的确定性检查。**能确定判的才在这里判**,判不了的交给视觉自评,不在这里假装能判。
 */

const Theme = z.object({ name: z.string().min(1), reason: z.string().min(1) })
const Outline = z.object({ slides: z.array(Slide).min(1) })
const Plan = z.object({ transitions: z.array(Transition) })

export interface ArtifactCheck {
  ok: boolean
  issues: string[]
}

export function validateArtifact(phase: DeckPhase, raw: unknown): ArtifactCheck {
  switch (phase) {
    case 'brief':
      return fromSchema(Brief, raw)
    case 'theme':
      return fromSchema(Theme, raw)
    case 'outline': {
      const parsed = fromSchema(Outline, raw)
      if (!parsed.ok) return parsed
      const issues = validateOutline((raw as z.infer<typeof Outline>).slides).map(
        (issue) => `第 ${issue.slide + 1} 页:${issue.message}`,
      )
      return { ok: issues.length === 0, issues }
    }
    case 'plan': {
      const parsed = fromSchema(Plan, raw)
      if (!parsed.ok) return parsed
      return checkPlan((raw as z.infer<typeof Plan>).transitions)
    }
    // 成品和自检不是 JSON 产物,交给后面的阶段验。
    case 'build':
    case 'review':
      return { ok: true, issues: [] }
  }
}

function fromSchema(schema: z.ZodType, raw: unknown): ArtifactCheck {
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, issues: [] }
  const issues = result.error.issues.map(
    (issue) => `${issue.path.join('.') || '根'}:${issue.message}`,
  )
  return { ok: false, issues }
}

/** 转场计划能确定判的几条。 */
function checkPlan(transitions: Transition[]): ArtifactCheck {
  const issues: string[] = []
  const seen = new Set<string>()

  for (const transition of transitions) {
    const key = `${transition.from}→${transition.to}`
    if (seen.has(key)) issues.push(`${key} 写了两次`)
    seen.add(key)

    if (transition.to !== transition.from + 1) {
      issues.push(`${key} 不是相邻两页 —— 转场计划一次翻页一行`)
    }
    if (!transition.relation.trim()) {
      issues.push(`${key} 没写两页的关系 —— 先有关系才谈得上选手法`)
    }
    // 匹配剪辑是硬切,没有锚就没法验轮廓重不重合,等于没法验。
    if (transition.technique === ('match-cut' satisfies Technique) && !transition.anchorSelector) {
      issues.push(`${key} 用了匹配剪辑但没写 anchorSelector,切点对不对没法验`)
    }
  }
  return { ok: issues.length === 0, issues }
}
