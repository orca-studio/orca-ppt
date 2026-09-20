import { useState } from 'react'
import type { DeckPhase, PhaseStatus } from '@orca-ppt/contracts'

/**
 * 阶段栏。每个阶段的产物都看得见、跑得动、改完能重跑 —— 让模型一口气从一句话写到成品,
 * 中间那些判断(版式为什么选它、转场为什么用这个手法)就永远看不见也改不动,
 * 而那些判断恰恰是稿子好不好的全部。
 */

export interface PhaseRow {
  phase: DeckPhase
  status: PhaseStatus
  issues: string[]
}

const LABEL: Record<DeckPhase, string> = {
  brief: '定题',
  theme: '选主题',
  outline: '列页面',
  plan: '写转场',
  build: '出稿',
  review: '自检',
}

const HINT: Record<DeckPhase, string> = {
  brief: '受众、语气、页数 —— 缺的自己定并记下来',
  theme: '从现成主题里挑,颜色只能来自主题文件',
  outline: '先有内容再挑版式',
  plan: '先写两页的关系,再选手法',
  build: '按前面四份产物写出成品',
  review: '录制并自检(M5)',
}

export interface PhaseRailProps {
  rows: PhaseRow[]
  /** 点「跑」不直接驱动谁 —— 挂进待办队列,等 agent 来拉。 */
  onRun: (phase: DeckPhase) => void
  onOpenArtifact: (phase: DeckPhase) => void
}

/**
 * 阶段栏。默认折叠 —— 稿子已经出来了的时候,这一栏没什么可干的,摆开只会把真正常用的
 * 「挂待办」压下去,还摆五个「跑」像是在请你重做一遍。
 */
export function PhaseRail({ rows, onRun, onOpenArtifact }: PhaseRailProps) {
  const [expanded, setExpanded] = useState<DeckPhase | undefined>()
  // 自检阶段还没实现,先不摆一个按下去没反应的按钮。
  const visible = rows.filter((row) => row.phase !== 'review')

  const done = rows.filter((row) => row.status === 'done').length
  const total = visible.length

  return (
    <details className="rail" open={done < total}>
      <summary>
        阶段
        <em>
          {done}/{total}
        </em>
      </summary>
      <ol className="rail-list">
        {visible.map((row) => (
          <li key={row.phase} data-status={row.status}>
            <div className="rail-row">
              <span className="rail-dot" />
              <button
                type="button"
                className="rail-name"
                onClick={() => setExpanded(expanded === row.phase ? undefined : row.phase)}
              >
                {LABEL[row.phase]}
              </button>
              {row.status === 'done' && (
                <button
                  type="button"
                  className="rail-link"
                  onClick={() => onOpenArtifact(row.phase)}
                >
                  看产物
                </button>
              )}
              <button type="button" className="rail-run" onClick={() => onRun(row.phase)}>
                {row.status === 'idle' ? '跑' : '重跑'}
              </button>
            </div>

            {expanded === row.phase && <p className="rail-hint">{HINT[row.phase]}</p>}
            {row.issues.length > 0 && (
              <ul className="rail-issues">
                {row.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <p className="muted rail-note">改完某个产物重跑它,下游的会一起作废。</p>
    </details>
  )
}
