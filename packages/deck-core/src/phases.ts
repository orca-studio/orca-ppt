import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeckPhase, PhaseReport } from '@orca-ppt/contracts'
import {
  artifactPath,
  checkDeck,
  phaseOrder,
  phasePrompt,
  validateArtifact,
  type Spec,
} from '@orca-ppt/deck-agent'
import { findEntryName, readPageTypes, sliceSections } from './decks.js'

/**
 * 阶段状态与闸门,全从磁盘上的产物推出来,server 和 CLI 共用。**品味在 deck-agent** ——
 * 提示词和确定性检查都在那边,这里不许复制一份(见 docs/ARCHITECTURE.md 的责任边界表)。
 */

/**
 * 从磁盘上的产物推出各阶段的状态。产物在且合规是 done,在但不合规是 failed,不在是 idle。
 * 不这么做的话,关掉重开就丢了全部进度 —— 而进度明明就躺在目录里。
 */
export async function readPhaseStatus(deckPath: string, spec?: Spec): Promise<PhaseReport[]> {
  return Promise.all(
    phaseOrder.map(async (phase) => {
      const check = await checkArtifact(deckPath, phase, { requireBuild: false, spec })
      if (check.missing) return { phase, status: 'idle' as const, issues: [] }
      return {
        phase,
        status: check.ok ? ('done' as const) : ('failed' as const),
        issues: check.issues,
      }
    }),
  )
}

interface ArtifactCheckResult {
  ok: boolean
  issues: string[]
  missing: boolean
}

async function checkArtifact(
  deckPath: string,
  phase: DeckPhase,
  options: { requireBuild: boolean; spec?: Spec | undefined },
): Promise<ArtifactCheckResult> {
  const path = join(deckPath, artifactPath[phase])

  if (phase === 'build' || phase === 'review') {
    // 成品不是 JSON,只确认它真的写出来了。
    //
    // 不能只认 `deck.html`:skill 做出来的稿子叫 `index.html`,而 openDeck 两个都认。
    // 两边不一致的话,一份**已经做完的**稿子打开后出稿阶段仍然是灰的,还摆一个「跑」
    // 按钮请你重做一遍。
    const built = phase === 'build' ? await findEntryName(deckPath) : undefined
    const target = built ? join(deckPath, built) : path
    try {
      const html = await readFile(target, 'utf8')
      /*
       * 出稿之后按规范核一遍坐标。
       *
       * 规范里那些数字不是审美偏好,是**转场的前提**:时间线的节点必须落在
       * 120/560/1000/1440,因为 Bento 的四列也是这一套,两页之间才接得上。摆歪了
       * 不会报错,要放映到那一下才发现 —— 那时候已经在给人看了。
       *
       * 只在 build 阶段核:review 阶段读的是同一份稿子,核两遍只会把同一条问题说两次。
       */
      const issues =
        phase === 'build'
          ? checkDeck(html, sliceSections(html), readPageTypes(html), options.spec).map(
              (issue) => `第 ${issue.slide + 1} 页:${issue.message}`,
            )
          : []
      return { ok: issues.length === 0, issues, missing: false }
    } catch {
      return options.requireBuild
        ? { ok: false, issues: [`没有写出 ${artifactPath[phase]}`], missing: false }
        : { ok: false, issues: [], missing: true }
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, issues: [`${artifactPath[phase]} 不是合法 JSON`], missing: false }
    }
    return options.requireBuild
      ? { ok: false, issues: [`${artifactPath[phase]} 没写出来`], missing: false }
      : { ok: false, issues: [], missing: true }
  }
  return { ...validateArtifact(phase, raw), missing: false }
}

/**
 * 阶段闸门。取某阶段的提示词时,先看上游产物合不合规 —— 不合规就拒绝并说清哪一条。
 *
 * 方向从「我们推」变成「agent 拉」,但门还在:把提示词给出去让 agent 自己看着办,
 * 等于没有门。
 */
export async function phaseGate(
  deckPath: string,
  phase: DeckPhase,
  context: {
    request?: string | undefined
    skillPath?: string | undefined
    themes?: string[]
    spec?: Spec | undefined
  },
): Promise<{ prompt?: string; blockedBy?: DeckPhase; issues: string[] }> {
  for (const upstream of phaseOrder.slice(0, phaseOrder.indexOf(phase))) {
    if (upstream === 'review') continue
    const check = await checkArtifact(deckPath, upstream, {
      requireBuild: false,
      spec: context.spec,
    })
    if (check.missing) {
      return { blockedBy: upstream, issues: [`${artifactPath[upstream]} 还没写出来`] }
    }
    if (!check.ok) return { blockedBy: upstream, issues: check.issues }
  }

  return {
    prompt: phasePrompt(phase, {
      request: context.request ?? '',
      skillPath: context.skillPath,
      ...(context.themes ? { themes: context.themes } : {}),
    }),
    issues: [],
  }
}
