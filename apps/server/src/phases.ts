import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeckPhase, PhaseReport } from '@orca-ppt/contracts'
import { artifactPath, phaseOrder, phasePrompt, validateArtifact } from '@orca-ppt/deck-agent'
import { findEntryName } from './decks.js'

/**
 * 阶段状态与闸门。server 拥有状态、持久化、恢复;**品味在 deck-agent** —— 提示词和
 * 确定性检查都在那边,这里不许复制一份(见 docs/ARCHITECTURE.md 的责任边界表)。
 */

/**
 * 从磁盘上的产物推出各阶段的状态。产物在且合规是 done,在但不合规是 failed,不在是 idle。
 * 不这么做的话,关掉重开就丢了全部进度 —— 而进度明明就躺在目录里。
 */
export async function readPhaseStatus(deckPath: string): Promise<PhaseReport[]> {
  return Promise.all(
    phaseOrder.map(async (phase) => {
      const check = await checkArtifact(deckPath, phase, { requireBuild: false })
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
  options: { requireBuild: boolean },
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
      await readFile(target, 'utf8')
      return { ok: true, issues: [], missing: false }
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
  context: { request?: string | undefined; skillPath?: string | undefined; themes?: string[] },
): Promise<{ prompt?: string; blockedBy?: DeckPhase; issues: string[] }> {
  for (const upstream of phaseOrder.slice(0, phaseOrder.indexOf(phase))) {
    if (upstream === 'review') continue
    const check = await checkArtifact(deckPath, upstream, { requireBuild: false })
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
