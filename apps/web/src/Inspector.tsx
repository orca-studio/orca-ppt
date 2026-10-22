import { useEffect, useState } from 'react'
import type { CanvasElement, TransitionNote, RequestParams } from '@orca-ppt/contracts'
import type { PageBuilds, SlideInfo } from './Stage.js'
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
  locked: boolean
  onEditPages: (change: RequestParams<'deck.editPages'>['change']) => Promise<void>
  onReplaceImage: (source: string) => Promise<void>
  selection: CanvasElement | null
  onSelect: () => void
  onClearSelection: () => void
  slide: number
  slideCount: number
  title: string
  /** 画布报回来的这一页的情况。画布没加载时是 null。 */
  info: SlideInfo | null
  /** 这一页之后那次转场。最后一页没有。 */
  note: TransitionNote | undefined
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
  /** 把这一页的页内动画从头放一遍。 */
  onReplayPage: () => void
  onFlag: () => void
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
  'data-lead': '领头元素',
}

/** 引擎 data-anim 的效果名,和 PowerPoint 动画窗格里的叫法对上。没收录的原样显示。 */
const EFFECT_LABEL: Record<string, string> = {
  path: '沿路径走',
  light: '光束',
  lit: '被光照亮',
  fade: '淡入',
  rise: '上浮',
  zoom: '弹出',
  fly: '飞入',
  wipe: '擦除',
  trail: '拖影飞入',
  shine: '擦亮',
  out: '淡出',
  spin: '回旋',
  emerge: '升起',
  ink: '墨晕',
}

/** 方向写的是「从哪边来」。 */
const DIR_LABEL: Record<string, string> = { left: '从左', right: '从右', up: '从上', down: '从下' }

const seconds = (value: number) => `${Math.round(value * 100) / 100} 秒`

function effectText(effect: PageBuilds['items'][number]['effects'][number]) {
  const name = EFFECT_LABEL[effect.kind] ?? effect.kind
  const head = [name, effect.dir ? (DIR_LABEL[effect.dir] ?? effect.dir) : '', effect.key ?? '']
    .filter(Boolean)
    .join(' ')
  // 被照的一层自己不动,跟着光束走,没有时间可写
  if (effect.kind === 'lit') return head
  return `${head} · ${effect.at ? `${seconds(effect.at)}起 ` : ''}${seconds(effect.dur)}`
}

function BuildsSection({
  builds,
  onReplayPage,
}: {
  builds: PageBuilds | null | undefined
  onReplayPage: () => void
}) {
  if (!builds) return <p className="muted">这一页没有页内动画。</p>
  return (
    <>
      <Row label="放完" value={seconds(builds.total)} />
      <Row
        label="点击"
        value={builds.clicks ? `按 ${builds.clicks} 下才放完，再按才翻页` : '进页自己放完'}
        hint={builds.clicks ? 'data-step' : undefined}
      />
      <ul className="inspector-carries inspector-builds">
        {builds.items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <span className="muted">{item.step ? `第 ${item.step} 下` : '进页'}</span>
            <em>{item.label}</em>
            <span>{item.effects.map(effectText).join('；')}</span>
          </li>
        ))}
      </ul>
      <div className="inspector-actions">
        <Button onClick={onReplayPage}>重放这页的动画</Button>
      </div>
    </>
  )
}

function SlideScope(props: InspectorProps) {
  const { title, pageType, info, selection, onSelect, onClearSelection } = props
  return (
    <>
      <PageActions {...props} />
      <h3>选中的元素</h3>
      <p>{selection ? selection.text || selection.tag : '尚未选择元素。'}</p>
      <div className="inspector-actions">
        <Button onClick={onSelect}>选择画布元素</Button>
        {selection && <Button onClick={onClearSelection}>取消选择</Button>}
      </div>
      {selection?.tag === 'img' && <ImageAction {...props} />}
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

      <h3>页内动画</h3>
      {info === null ? (
        <p className="muted">画布还没加载。</p>
      ) : (
        <BuildsSection builds={info.builds} onReplayPage={props.onReplayPage} />
      )}
    </>
  )
}

function PageActions({ slide, slideCount, locked, onEditPages }: InspectorProps) {
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('新页面')
  const run = async (change: RequestParams<'deck.editPages'>['change']) => {
    setBusy(true)
    try {
      await onEditPages(change)
    } finally {
      setBusy(false)
    }
  }
  const disabled = locked || busy
  return (
    <fieldset className="page-actions" disabled={disabled}>
      <legend>页面操作</legend>
      <div className="inspector-actions">
        <Button
          disabled={disabled || slide === 0}
          onClick={() => void run({ action: 'move', index: slide, to: slide - 1 })}
        >
          前移
        </Button>
        <Button
          disabled={disabled || slide >= slideCount - 1}
          onClick={() => void run({ action: 'move', index: slide, to: slide + 1 })}
        >
          后移
        </Button>
        <Button
          disabled={disabled || slideCount <= 1}
          onClick={() => void run({ action: 'delete', index: slide })}
        >
          删除本页
        </Button>
      </div>
      <label>
        新页面标题
        <input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <Button
        disabled={disabled || !title.trim()}
        onClick={() => void run({ action: 'insert', index: slide + 1, title })}
      >
        在本页后添加空白页
      </Button>
      <p className="muted">添加和移动后，请检查新相邻页面的转场。所有操作可撤销。</p>
    </fieldset>
  )
}

function ImageAction({ locked, onReplaceImage }: InspectorProps) {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="page-actions"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        void onReplaceImage(source.trim()).finally(() => setBusy(false))
      }}
    >
      <label>
        图片路径
        <input
          placeholder="assets/photo.png"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          disabled={locked || busy}
        />
      </label>
      <p className="muted">填写稿子目录内已有图片的相对路径。图片须有 id 或 data-anchor。</p>
      <Button type="submit" disabled={locked || busy || !source.trim()}>
        替换选中的图片
      </Button>
    </form>
  )
}

function TransitionScope({
  slide,
  note,
  info,
  last,
  locked,
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
      {/* 读的是稿子里实际写的属性,不是计划注释:色块前沿带着走的那个元素 */}
      {info?.leave?.lead && <Row label="领头" value={info.leave.lead} hint="data-st-mask-lead" />}

      <div className="inspector-actions">
        <Button onClick={onReplay}>重放这次转场</Button>
        {/* 只读样稿上指出来也没人能改 */}
        {!locked && <Button onClick={onFlag}>指着它说不对</Button>}
      </div>
    </>
  )
}

function DeckScope({ slideCount, themeTitle }: InspectorProps) {
  return (
    <>
      <Row label="主题" value={themeTitle ?? '没配主题'} />
      <Row label="页数" value={`${slideCount} 页`} />
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
