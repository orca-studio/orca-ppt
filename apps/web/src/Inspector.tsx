import { useEffect, useState } from 'react'
import type { DeckPhase, TransitionNote } from '@orca-ppt/contracts'
import { PhaseRail, type PhaseRow } from './PhaseRail.js'
import type { SlideInfo } from './Stage.js'
import { Button } from './ui/Button.js'
import { Segmented } from './ui/Segmented.js'

/**
 * 右栏。**三档是三个作用域,不是三组工具**:这一次转场 / 这一页 / 整份稿子。
 *
 * 这把尺子借自 Keynote 的「格式 / 过渡 / 文稿」。它有用的地方在于:人心里想改的东西
 * 天然带着一个作用域 —— 「这页停久一点」是页的事,「这个切换太快」是转场的事,
 * 「换个主题」是整份稿子的事。按作用域分,找东西不用记它归在哪个工具下。
 *
 * 原来这儿放的是「检视」(点一下画布指给 agent 看)。那**不是一个作用域,是一个动作**,
 * 放在一个按作用域组织的栏里当然显得没意义 —— 它归工具栏。
 */

export type Scope = 'slide' | 'transition' | 'deck'

/**
 * 转场排第一、默认打开。尺子借自 Keynote,顺序不照抄:Keynote 的重心是页面排版,
 * 我们的重心是页和页之间怎么接上 —— 打开右栏第一眼该看到的是这个。
 */
const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'transition', label: '转场' },
  { key: 'slide', label: '页' },
  { key: 'deck', label: '稿子' },
]

export interface InspectorProps {
  slide: number
  slideCount: number
  title: string
  /** 画布报回来的这一页的情况。画布没加载时是 null。 */
  info: SlideInfo | null
  /** 这一页之后那次转场。最后一页没有。 */
  note: TransitionNote | undefined
  phases: PhaseRow[]
  /** 主题的人读名字。稿子没配主题时没有。 */
  themeTitle: string | undefined
  /**
   * 这一页声明的页面类型,已经换成人读的名字。没标的是 undefined。
   *
   * **只显示,不提供菜单。** 本产品的人不摆页面,他说话 —— 类型是 agent 按内容挑的。
   * 摆在这儿是为了让人**发现它不对**(「这页明明是对比,怎么标成列表」),
   * 而不是让他自己来选。
   */
  pageType: string | undefined
  onReplay: () => void
  onFlag: () => void
  onOpenArtifact: (phase: DeckPhase) => void
  onLoadPrompt: (phase: DeckPhase) => Promise<string>
}

export function Inspector(props: InspectorProps) {
  const [scope, setScope] = useState<Scope>('transition')
  const last = props.slide >= props.slideCount - 1

  return (
    <>
      <header className="pane-head inspector-head">
        <Segmented items={SCOPES} value={scope} onChange={setScope} label="作用域" />
      </header>
      <div className="pane-body inspector">
        {scope === 'slide' && <SlideScope {...props} />}
        {scope === 'transition' && <TransitionScope {...props} last={last} />}
        {scope === 'deck' && <DeckScope {...props} />}
      </div>
    </>
  )
}

/**
 * 属性名给人看是噪音、给 agent 看是坐标 —— 值里写人话,属性名收进悬停提示。
 * 页号不在这儿:状态栏已经有了,同一个数摆三处,人会以为它们是三件事。
 */
const CARRY_LABEL: Record<string, string> = {
  'data-id': '跨页共享',
  'data-carry': '交接',
  'data-zoom': '放大锚点',
}

function SlideScope({ title, pageType, info }: InspectorProps) {
  return (
    <>
      <Row label="标题" value={title} />
      {/* 没标就说没标 —— 别推一个出来:标错会同时误导校验、agent 和转场规划。 */}
      <Row label="类型" value={pageType ?? '没标'} hint={pageType ? undefined : 'data-page'} />
      {/* 没写就如实说「没写」—— 编一个默认值会让人以为稿子里有这一行。 */}
      <Row
        label="停留"
        value={info?.hold ? `${info.hold} 秒` : '没写'}
        hint={info?.hold ? undefined : 'data-hold'}
      />
      <Row label="转场时长" value={info?.duration ? `${info.duration} 秒` : '默认'} />

      <h3>参与转场的元素</h3>
      {info === null ? (
        <p className="muted">画布还没加载。</p>
      ) : info.carries.length === 0 ? (
        /* 这本身是有用的信息:这一页进出都只能是硬切。 */
        <p className="muted">这一页没有带标记的元素 —— 它和前后页之间接不上。</p>
      ) : (
        <ul className="inspector-carries">
          {info.carries.map((carry, index) => (
            <li key={`${carry.kind}-${carry.id}-${index}`}>
              <code>{carry.id || '(没写名字)'}</code>
              <span className="muted" title={carry.kind}>
                {CARRY_LABEL[carry.kind] ?? carry.kind}
              </span>
              <em>{carry.text}</em>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function TransitionScope({
  slide,
  note,
  last,
  onReplay,
  onFlag,
}: InspectorProps & { last: boolean }) {
  if (last) return <p className="muted">最后一页,后面没有转场了。</p>

  return (
    <>
      <Row label="从 / 到" value={`第 ${slide + 1} → 第 ${slide + 2} 页`} />
      {/*
        关系、手法、共享是这个产品最独特的东西,以前只在缩略图之间那根连线 hover 时
        露一点点。放在这儿是因为它本来就属于「这一次转场」这个作用域。
      */}
      <Row label="关系" value={note?.relation ?? '没写'} />
      <Row label="手法" value={note?.technique ?? '没写'} />
      {/* 契约里叫 anchor:承接运动的那个元素,原样照抄稿子里写的。 */}
      <Row label="共享" value={note?.anchor ?? '没写'} />

      <div className="inspector-actions">
        <Button onClick={onReplay}>重放这次转场</Button>
        <Button onClick={onFlag}>指着它说不对</Button>
      </div>
    </>
  )
}

function DeckScope({
  slideCount,
  themeTitle,
  phases,
  onOpenArtifact,
  onLoadPrompt,
}: InspectorProps) {
  return (
    <>
      <Row label="主题" value={themeTitle ?? '没配主题'} />
      <Row label="页数" value={`${slideCount} 页`} />
      <PhaseRail rows={phases} onOpenArtifact={onOpenArtifact} onLoadPrompt={onLoadPrompt} />
    </>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="inspector-row">
      <span className="muted">{label}</span>
      <span title={hint}>
        {value}
        {hint && <code className="inspector-hint">{hint}</code>}
      </span>
    </div>
  )
}
