import { useState } from 'react'
import type { DeckPhase, PhaseStatus } from '@orca-ppt/contracts'

/**
 * 阶段栏 —— **只读的状态**:这份稿子走到哪一步了、哪一条没过。
 *
 * 原来每行挂着「跑」,意思是「跟 agent 说该做这一步」。那是 MCP 之前的权宜:
 * 那时候没有别的办法让 agent 知道人想干什么。现在 agent 自己会调 `phase_prompt`,
 * 人要它做什么直接说就行,按钮就成了多余的一层转述。
 *
 * 展开仍然给出这一步的完整做法 —— 读得懂就能自己做,也能整段带去别处,
 * 这对一个先给人用的产品是有意义的;「替我去通知 agent」没有。
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
  review: '暂不做 —— 自己放一遍看',
}

export interface PhaseRailProps {
  rows: PhaseRow[]
  onOpenArtifact: (phase: DeckPhase) => void
  /**
   * 取这一步的完整做法。
   *
   * 展开给人看,不只给 agent —— 一个没有 agent 就什么都不做的按钮,在一个先给人用的
   * 产品里是坏的。读得懂就能自己做,也能整段带去别处。
   */
  onLoadPrompt: (phase: DeckPhase) => Promise<string>
}

/** 默认折叠 —— 稿子已经出来了的时候,这一栏只是背景信息,摆开会盖掉画布旁边的地方。 */
export function PhaseRail({ rows, onOpenArtifact, onLoadPrompt }: PhaseRailProps) {
  const [expanded, setExpanded] = useState<DeckPhase | undefined>()
  const [prompt, setPrompt] = useState<string | undefined>()

  const toggle = (phase: DeckPhase) => {
    if (expanded === phase) {
      setExpanded(undefined)
      return
    }
    setExpanded(phase)
    setPrompt(undefined)
    void onLoadPrompt(phase).then(setPrompt)
  }
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
              <button type="button" className="rail-name" onClick={() => toggle(row.phase)}>
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
            </div>

            {expanded === row.phase && (
              <div className="rail-how">
                <p className="rail-hint">{HINT[row.phase]}</p>
                <pre>{prompt ?? '读取中…'}</pre>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(prompt ?? '')}
                  disabled={!prompt}
                >
                  拷贝这一步的做法
                </button>
              </div>
            )}
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
      <p className="muted rail-note">
        点阶段名看这一步该怎么做。要 agent 去做,直接跟它说 —— 它自己读得到这些。
      </p>
    </details>
  )
}
