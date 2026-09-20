import type { Technique } from '@orca-pptcode/contracts'

/**
 * 录完自动跑的确定性检查。对应 Design Mode 的 render → critique → revise,
 * 区别是我们的 render 是一段视频而不是一张截图。
 */

export interface MotionVerdict {
  pass: boolean
  reason: string
}

/**
 * 帧差量运动:每次转场里,画面变化明显的帧应该**连续占满**转场区间的大部分,
 * 而不是集中在一两帧。集中 = 转场没真的动,是个跳变。
 *
 * @param diffs 转场区间内逐帧的画面差异量(任意单位,只比相对大小)
 */
export function frameMotionVerdict(diffs: number[], coverage = 0.6): MotionVerdict {
  if (diffs.length === 0) return { pass: false, reason: '转场区间没有帧' }

  const peak = Math.max(...diffs)
  if (peak === 0) return { pass: false, reason: '转场区间内画面完全没变' }

  // 「变化明显」= 达到峰值的一成以上。阈值取得低,是为了让缓入缓出的尾巴也算进来。
  const moving = diffs.filter((d) => d >= peak * 0.1).length
  const ratio = moving / diffs.length
  return ratio >= coverage
    ? { pass: true, reason: `运动覆盖转场区间的 ${Math.round(ratio * 100)}%` }
    : {
        pass: false,
        reason: `运动只占转场区间的 ${Math.round(ratio * 100)}%,像跳变而不是转场`,
      }
}

/**
 * 匹配剪辑是硬切,本来就没有转场帧,上面那条不适用。
 * 它只能这样验:取切点前后两帧,确认锚的轮廓完全重合、而画面上其余东西都换了。
 */
export function appliesFrameMotionCheck(technique: Technique): boolean {
  return technique !== 'match-cut'
}

export interface MatchCutEvidence {
  /** 锚轮廓在前后两帧的重合度 0–1。 */
  anchorOverlap: number
  /** 锚之外的画面变化比例 0–1。 */
  restChanged: number
}

export function matchCutVerdict(evidence: MatchCutEvidence): MotionVerdict {
  if (evidence.anchorOverlap < 0.95) {
    return { pass: false, reason: `锚轮廓只重合 ${Math.round(evidence.anchorOverlap * 100)}%` }
  }
  if (evidence.restChanged < 0.5) {
    return { pass: false, reason: '锚之外的画面没怎么变,这不是一次剪辑' }
  }
  return { pass: true, reason: '锚重合,其余换掉' }
}
