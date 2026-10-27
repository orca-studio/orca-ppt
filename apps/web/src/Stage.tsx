import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  CanvasEvidence,
  type InspectAnchor,
  type CanvasError,
  type PushData,
  type RequestParams,
} from '@orca-ppt/contracts'
import autoplayScript from './guest/autoplay.guest.js?raw'
import editScript from './guest/edit.guest.js?raw'
import canvasScript from './guest/canvas.guest.js?raw'
import inspectScript from './guest/inspect.guest.js?raw'
import { Canvas, type CanvasView } from './canvas.js'

/**
 * 放映画布。桌面版里 deck 跑在 Electron `<webview>` guest 里 —— guest 能被主进程当独立对象
 * 管理,所以能注入检视脚本、拿元素几何、做裁切截图;浏览器里是同源的 `<iframe>`。
 * 两种都经 canvas.tsx 的 CanvasView 摸,这里不管是哪一种(见 docs/ARCHITECTURE.md)。
 */

/** guest 里算出来的锚,比契约多一个视口坐标 —— 宿主按它截图。 */
export interface PickedAnchor extends Omit<InspectAnchor, 'note'> {
  viewportBox: { x: number; y: number; w: number; h: number }
}

export interface StageHandle {
  inspectCanvas(
    include: RequestParams<'canvas.inspect'>['include'],
    expectedRevision?: string,
  ): Promise<CanvasEvidence>
  selectCanvas(input: RequestParams<'canvas.select'>): Promise<CanvasEvidence>
  /** 进入取锚状态。用户点下给出锚,Esc 取消给出 null。 */
  pick(): Promise<PickedAnchor | null>
  cancelPick(): void
  /** 自动播放:按每页的 data-hold 依次往后翻。 */
  autoplay(on: boolean): void
  /** guest 那边还在播吗。它会自己停(放完、或者人在画布里动手),得问它才知道。 */
  autoplayRunning(): Promise<boolean>
  /** 稿子变了,重载并回到原来那一页。 */
  reload(slide: number): void
  goto(slide: number): void
  /** 往后翻一页 —— 只有往后翻才播转场。 */
  navigate(action: 'next' | 'previous' | 'replay' | 'replayPage', from?: number): void
  /** guest 的 webContents id —— 主进程按它找到 guest 去截图。 */
  guestId(): number | undefined
  /** 在画布上说一句话(比如撤销为什么没做成),贴着最近改过的那一处。 */
  notify(message: string): void
  /** 等画布加载完。重载途中截图会截到空白,得等它。 */
  whenReady(timeoutMs?: number): Promise<boolean>
  /** 这一页的情况:停留时长、参与转场的元素。只有画布答得出来。 */
  slideInfo(): Promise<SlideInfo | null>
  /** 就地换掉一段字,不重载(见协议 `deck.patched`)。换不了返回 false,调用方照旧重载。 */
  patch(input: PushData<'deck.patched'>): Promise<boolean>
  /** 画布现在是哪一版。没加载好时是 null。 */
  revision(): Promise<string | null>
  /** 页上几处东西在宿主页面里的位置(CSS 像素,已裁到画布可见的部分)。只读。 */
  locate(queries: StageQuery[]): Promise<StageTarget[]>
  /**
   * 跟上一处改动(agent 改的,或者撤销重做):等画布加载出 revision,翻到那一页,把那一处
   * 连同 label 框出来,确认画到屏幕上之后交回它的位置。没有 query 时框整页;没有 slide 时
   * 不翻页也不框。
   */
  follow(input: {
    revision: string
    slide?: number
    query?: StageQuery
    label?: string
  }): Promise<StageTarget | undefined>
}

export type StageQuery = { slide: number; text: string } | { slide: number; selector: string }
export interface StageTarget {
  status: 'visible' | 'not_visible' | 'not_found' | 'ambiguous' | 'unavailable'
  rect?: { x: number; y: number; width: number; height: number }
  /** 页内选择器。拼成 targetId 之后能原样再查。 */
  selector?: string
  reason?: string
}

/** 改动框留多久:人的眼睛得来得及从别处挪过来、读完标签。 */
const FLAG_MS = 1_600
/** 框比元素外扩一点,不压着字。 */
const FLAG_PAD = 4

/** 画布上的改动框,坐标相对画布框。`seq` 变了是新出现(淡入),不变是从上一处移过来。 */
interface ChangeFlag {
  x: number
  y: number
  width: number
  height: number
  label?: string
  shown: boolean
  seq: number
}

/**
 * 往前翻一页。走 skill 引擎的 advance:转场还没放完就翻,它会先把剩下的放完,不跳帧
 * (见 skills/orca-ppt/runtime/engine.js)。老稿子的引擎没有它,就退回 Reveal.next()。
 */
const ADVANCE = 'window.__orcaAdvance ? window.__orcaAdvance() : Reveal.next()'
/** 明说要去下一页:转场先放完,页内动画不再一步一步推。老引擎不认参数,照旧。 */
const NEXT_PAGE = 'window.__orcaAdvance ? window.__orcaAdvance({ page: true }) : Reveal.next()'

/** 这一页在画布上的情况。右栏「页」那一档显示它。 */
export interface SlideInfo {
  index: number
  /** 停留多久(秒)。没写 `data-hold` 时是 null —— 如实报,不编一个默认值。 */
  hold: string | null
  /** 转场时长(秒)。没写时是 null。 */
  duration: string | null
  carries: Array<{ id: string; kind: string; text: string }>
  /** 页内动画。引擎给的清单(`window.__orcaBuilds`);没有页内动画或老引擎时是 null。 */
  builds?: PageBuilds | null
  /**
   * 离开这一页的那次转场在稿子里实际怎么写的(写在下一页上)。最后一页是 null。
   * `lead`:遮挡剪辑带着走的领头元素(`data-st-mask-lead`)。
   */
  leave?: { st: string | null; lead: string | null } | null
}

/** 一页的页内动画:skill 引擎 `window.__orcaBuilds()` 的返回值,字段原样照抄。 */
export interface PageBuilds {
  /** 放映时全部放完要多久(秒),步与步之间不算停顿。 */
  total: number
  /** 要按几下翻页键才放完。0 = 进页自己放完。 */
  clicks: number
  steps: Array<{ step: number; length: number }>
  items: Array<{
    /** 元素的文字,没有文字就是 `<div.s-group>` 这样的标签。 */
    label: string
    /** 第几次点击才放。0 = 进页就放。 */
    step: number
    effects: Array<{
      kind: string
      dir: string | null
      /** 在这一步里第几秒开始。 */
      at: number
      dur: number
      key?: string
    }>
  }>
}

/** guest 里改完的一处文字。服务端靠 `oldText` 在源码里定位,不靠选择器。 */
export interface TextEdit {
  slide: number
  oldText: string
  newText: string
}

export interface StageProps {
  previewUrl: string
  /** 重新挂载时回到这一页 —— 不该跳回第一页。 */
  initialSlide: number
  onNavigate: (action: 'next' | 'previous') => void
  onSlideChange: (index: number) => void
  /** 这一页的点击分步按到第几下、一共几下。引擎每次变都报。 */
  onStepChange?: (steps: { done: number; clicks: number }) => void
  /**
   * 人双击改完了一处文字。返回被拒的理由(没被拒就返回 undefined)——
   * 拒绝的理由要摆回他刚才双击的地方,不能默默吞掉。
   */
  onTextEdit: (edit: TextEdit) => Promise<string | undefined>
  /**
   * 改不了:agent 正拿着稿子,或者这是 skill 里的只读样稿。这时不接新的双击改字 ——
   * 改了也会被 server 拒掉。已经在改的那处不收走:人打到一半的字直接没了,比被拒一次更糟。
   */
  readOnly: boolean
  /**
   * 不响应方向键:只在 agent 拿着稿子时 —— 翻页会和它抢。只读样稿照样能翻,
   * 看同款本来就是一页页翻着看。
   */
  navLocked: boolean
  /** 盖在画布上的那一层(agent 拿着稿子时的遮罩)。 */
  overlay?: ReactNode
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  {
    previewUrl,
    initialSlide,
    onSlideChange,
    onStepChange,
    onNavigate,
    onTextEdit,
    readOnly,
    navLocked,
    overlay,
  },
  handle,
) {
  const ref = useRef<CanvasView | null>(null)
  const onView = useCallback((view: CanvasView | null) => {
    ref.current = view
  }, [])
  /** 画布外面那个框:改动框按它定位。 */
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const restoreTo = useRef(initialSlide)
  const loadEpoch = useRef(0)
  const [flag, setFlag] = useState<ChangeFlag | undefined>()
  const flagTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * 画布加载好了没有。**初值是「没好」** —— 初次挂载时 dom-ready 还没来过,
   * 给 false 的话刚打开稿子时问什么都答不上来(右栏会一直显示「画布还没加载」)。
   */
  const loading = useRef(true)
  const runtimeErrors = useRef<CanvasError[]>([])
  const injected = useRef(false)
  const waiters = useRef<Array<() => void>>([])
  // 常驻回调,不进 effect 依赖 —— 注入和守候都只该在加载时发生一次。
  const onTextEditRef = useRef(onTextEdit)
  onTextEditRef.current = onTextEdit
  const onSlideChangeRef = useRef(onSlideChange)
  onSlideChangeRef.current = onSlideChange
  const onStepChangeRef = useRef(onStepChange)
  onStepChangeRef.current = onStepChange
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const navLockedRef = useRef(navLocked)
  navLockedRef.current = navLocked
  /** 守候改字那一轮在不在跑。只读时停下,放开时从这里重新接上。 */
  const watching = useRef(false)
  const watchRef = useRef<() => void>(() => {})
  /** 有一次重载在等人改完字。 */
  const reloadWaiting = useRef(false)

  useEffect(() => {
    const view = ref.current
    if (!view) return

    /**
     * 守候就地编辑。一次只等一处:拿到就写盘,写完再等下一处 —— 两处改动挤在一起的话,
     * 服务端按旧文字定位就分不清先后了。
     *
     * 这一轮会在下一次加载时被 guest 那边的重复注入解掉(arm 的 Promise 解成 null)。
     */
    const watchEdits = () => {
      if (readOnlyRef.current || !injected.current) {
        watching.current = false
        return
      }
      watching.current = true
      void view
        .run('window.__orcaEdit?.arm()')
        .then(async (result) => {
          const edit = result as TextEdit | null
          if (!edit) return
          const reason = await onTextEditRef.current(edit)
          if (reason) {
            void view.run(`window.__orcaEdit.notify(${JSON.stringify(reason)})`).catch(() => {})
          }
        })
        .then(watchEdits)
        // guest 没了就别再守了,不然重载时会空转。
        .catch(() => {
          watching.current = false
        })
    }
    watchRef.current = watchEdits

    // 每次加载都要重新注入 —— 重载之后 guest 里什么都不剩。
    const onLoad = () => {
      const epoch = loadEpoch.current
      void view
        .run(
          `window.Reveal?.configure({ controls: false });${inspectScript};${autoplayScript};${editScript};${canvasScript}`,
        )
        .then(async () => {
          if (epoch !== loadEpoch.current) return
          // Keep the desired page across successive watcher reloads. A user/agent
          // navigation during injection supersedes the earlier restore target.
          for (;;) {
            const slide = restoreTo.current
            const index = await view
              .run(`Reveal.slide(${slide}); Reveal.getIndices().h`)
              .catch(() => undefined)
            if (epoch !== loadEpoch.current) return
            if (slide !== restoreTo.current) continue
            injected.current = true
            if (typeof index === 'number') onSlideChangeRef.current(index)
            break
          }
          watchEdits()
        })
      setReady(true)
      setError(undefined)
    }
    // 画布尺寸变化不用我们管:guest 收得到 resize,reveal 自己重算缩放比。
    // 试过加 ResizeObserver 主动调 Reveal.layout(),量下来是多余的,已经去掉。
    return view.subscribe({
      loadingStarted: () => {
        loading.current = true
      },
      loadingStopped: () => {
        // Reveal 的 hash 导航也触发 loading，但不会重新触发 dom-ready。
        loading.current = false
        for (const resume of waiters.current.splice(0)) resume()
      },
      domReady: onLoad,
      failed: (message) => {
        setError(message || '加载失败')
        runtimeErrors.current.push({
          kind: 'load',
          message: message || '加载失败',
          source: null,
          stack: null,
        })
      },
      // guest 里翻了页都从这里报回来 —— 人在画布里按键、自动播放、agent 让它跳页,一律一条路。
      // 以前只有焦点在画布外的那一路会报,画布里翻的页状态栏不知道,页码就对不上。
      console: ({ message, error, source }) => {
        if (error) {
          runtimeErrors.current.push({
            kind: 'script',
            message: message.slice(0, 4000),
            source: source ?? null,
            stack: null,
          })
          runtimeErrors.current = runtimeErrors.current.slice(-50)
        }
        const step = /^__orca:step (\d+) (\d+)$/.exec(message)
        if (step && injected.current) {
          onStepChangeRef.current?.({ done: Number(step[1]), clicks: Number(step[2]) })
        }
        const match = /^__orca:slide (\d+)$/.exec(message)
        if (match && injected.current && !reloadWaiting.current) {
          restoreTo.current = Number(match[1])
          onSlideChangeRef.current(restoreTo.current)
        }
      },
      navigated: () => {
        loadEpoch.current += 1
        runtimeErrors.current = []
        injected.current = false
      },
    })
    // initialSlide 只在挂载那次用得上,变了不该重装监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 稿子在磁盘上变了要重载画布 —— 可人正双击改着字的时候不能重载,他打到一半的字会直接没了。
   * 等他改完(提交或放弃)再重载。他提交时 server 会重读磁盘,旧文字对不上就拒,不会盖掉 agent 的。
   */
  const reloadWhenNotEditing = async () => {
    if (reloadWaiting.current) return
    reloadWaiting.current = true
    try {
      for (;;) {
        const view = ref.current
        if (!view) return
        const editing = await view.run('!!window.__orcaEdit?.editing()').catch(() => false)
        if (!editing) {
          view.reload()
          return
        }
        await new Promise((resume) => setTimeout(resume, 400))
      }
    } finally {
      reloadWaiting.current = false
    }
  }

  useEffect(() => {
    const view = ref.current
    if (!view || !ready) return
    if (!readOnly) {
      if (!watching.current) watchRef.current()
      return
    }
    // 焦点留在画布里的话,方向键会直接进 reveal,绕过下面的拦截。
    view.blur()
    // 收起双击改字。守候那一轮的 Promise 会解成 null,watchEdits 看到只读就不再接上。
    void view.run('window.__orcaEdit?.editing() || window.__orcaEdit?.disarm()').catch(() => {})
  }, [readOnly, ready])

  const inspectCanvas = async (
    include: RequestParams<'canvas.inspect'>['include'],
    expectedRevision?: string,
  ): Promise<CanvasEvidence> => {
    const view = ref.current
    if (!view) throw new Error('UI_DISCONNECTED: 没有可见画布。')
    const deadline = Date.now() + 10000
    for (;;) {
      const value = await view
        .run(`window.__orcaCanvas?.inspect(${JSON.stringify(include)})`)
        .catch(() => undefined)
      if (value) {
        const evidence = CanvasEvidence.parse(value)
        evidence.ready =
          evidence.ready && injected.current && !loading.current && !reloadWaiting.current
        evidence.errors = mergeErrors(runtimeErrors.current, evidence.errors)
        if (
          !expectedRevision ||
          (evidence.ready && evidence.renderedRevision === expectedRevision)
        ) {
          if (evidence.ready) {
            await view.run(
              `Promise.race([document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))), new Promise((_, reject) => setTimeout(() => reject(new Error('RENDER_NOT_READY: 字体尚未加载。')), 3000))])`,
            )
            const fresh = CanvasEvidence.parse(
              await view.run(`window.__orcaCanvas.inspect(${JSON.stringify(include)})`),
            )
            fresh.ready =
              fresh.ready && injected.current && !loading.current && !reloadWaiting.current
            fresh.errors = mergeErrors(runtimeErrors.current, fresh.errors)
            if (expectedRevision && (!fresh.ready || fresh.renderedRevision !== expectedRevision))
              continue
            return fresh
          }
          return evidence
        }
      }
      if (!value && !expectedRevision)
        return {
          renderedRevision: null,
          slide: null,
          ready: false,
          width: 1920,
          height: 1080,
          autoplay: false,
          selection: null,
          elements: [],
          elementsTruncated: false,
          html: null,
          htmlLength: 0,
          htmlTruncated: false,
          errors: [...runtimeErrors.current],
        }
      if (Date.now() >= deadline) throw new Error('RENDER_NOT_READY: 画布尚未加载目标版本。')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /** guest 视口坐标 → 宿主页面坐标,并裁到画布框里露出来的那部分。 */
  const toHost = (target: StageTarget): StageTarget => {
    const view = ref.current
    if (!view || !target.rect) return target
    const host = view.rect()
    const left = Math.max(host.x + target.rect.x, host.left, 0)
    const top = Math.max(host.y + target.rect.y, host.top, 0)
    const right = Math.min(host.x + target.rect.x + target.rect.width, host.right, innerWidth)
    const bottom = Math.min(host.y + target.rect.y + target.rect.height, host.bottom, innerHeight)
    if (right <= left || bottom <= top) {
      const { rect: _rect, ...rest } = target
      return { ...rest, status: 'not_visible', reason: 'outside_viewport' }
    }
    return { ...target, rect: { x: left, y: top, width: right - left, height: bottom - top } }
  }

  /**
   * 把改动框画到画布上一层(宿主页面里,不进稿子 DOM —— 截图给 agent 自检时不该带着它)。
   * 连着来的改动只有一个框,从上一处移过去;最后一处留够时间再淡出。
   */
  const showFlag = (target: StageTarget, label: string | undefined) => {
    const frame = frameRef.current
    if (!frame || !target.rect) return
    const origin = frame.getBoundingClientRect()
    const left = Math.max(target.rect.x - origin.x - FLAG_PAD, 0)
    const top = Math.max(target.rect.y - origin.y - FLAG_PAD, 0)
    const right = Math.min(target.rect.x - origin.x + target.rect.width + FLAG_PAD, origin.width)
    const bottom = Math.min(target.rect.y - origin.y + target.rect.height + FLAG_PAD, origin.height)
    setFlag((previous) => ({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      ...(label ? { label } : {}),
      shown: true,
      seq: previous?.shown ? previous.seq : (previous?.seq ?? 0) + 1,
    }))
    clearTimeout(flagTimer.current)
    flagTimer.current = setTimeout(
      () => setFlag((previous) => previous && { ...previous, shown: false }),
      FLAG_MS,
    )
  }

  // 窗口一变,框就对不上了:直接收起,不跟着挪
  useEffect(() => {
    const hide = () => setFlag((previous) => previous && { ...previous, shown: false })
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('resize', hide)
      clearTimeout(flagTimer.current)
    }
  }, [])

  const locate = async (queries: StageQuery[]): Promise<StageTarget[]> => {
    const view = ref.current
    if (!view || loading.current || !injected.current)
      return queries.map(() => ({ status: 'unavailable', reason: 'canvas_not_ready' }))
    const found = (await view
      .run(
        `${JSON.stringify(queries)}.map(q => window.__orcaCanvas?.locate(q) ?? { status: 'unavailable', reason: 'canvas_not_ready' })`,
      )
      .catch(() => undefined)) as StageTarget[] | undefined
    if (!found) return queries.map(() => ({ status: 'unavailable', reason: 'canvas_not_ready' }))
    return found.map(toHost)
  }

  useImperativeHandle(
    handle,
    (): StageHandle => ({
      inspectCanvas,
      selectCanvas: async (input) => {
        await inspectCanvas('context', input.expectedRevision)
        await ref.current?.run(`window.__orcaCanvas.select(${JSON.stringify(input)})`)
        return inspectCanvas('context', input.expectedRevision)
      },
      pick: async () => {
        const result = await ref.current?.run('window.__orcaInspect?.arm()')
        return (result as PickedAnchor | null) ?? null
      },
      cancelPick: () => {
        void ref.current?.run('window.__orcaInspect?.disarm()').catch(() => {})
      },
      autoplay: (on: boolean) => {
        void ref.current?.run(`window.__orcaAutoplay?.${on ? 'start' : 'stop'}()`).catch(() => {})
      },
      autoplayRunning: async () => {
        const running = await ref.current
          ?.run('!!window.__orcaAutoplay?.running()')
          .catch(() => false)
        return Boolean(running)
      },
      reload: (slide: number) => {
        restoreTo.current = slide
        void reloadWhenNotEditing()
      },
      goto: (slide: number) => {
        restoreTo.current = Math.trunc(slide)
        if (loading.current || reloadWaiting.current || !injected.current) {
          return
        }
        // 正好是下一页就当成「往前翻」:走 advance,上一段转场没放完时先放完,不跳帧,
        // 而且翻过去照样有转场。别的页是跳页,跳页本来就没有转场,直接去。
        const index = Math.trunc(slide)
        void ref.current
          ?.run(`Reveal.getIndices().h + 1 === ${index} ? (${NEXT_PAGE}) : Reveal.slide(${index})`)
          .catch(() => {})
      },
      navigate: (action, from) => {
        const command =
          action === 'previous'
            ? 'Reveal.prev()'
            : action === 'replay'
              ? `Reveal.slide(${Math.trunc(from ?? 0)}); setTimeout(() => { ${ADVANCE} }, 260)`
              : action === 'replayPage'
                ? // 已经在这一页时 Reveal.slide 不会触发翻页,页内动画要引擎自己从头放;老引擎没有就算了
                  `Reveal.slide(${Math.trunc(from ?? 0)}); window.__orcaReplayBuild?.()`
                : ADVANCE
        void ref.current?.run(`window.__orcaAutoplay?.stop(); ${command}`).catch(() => {})
      },
      guestId: () => ref.current?.guestId(),
      locate,
      patch: async (input) => {
        const view = ref.current
        if (!view || loading.current || reloadWaiting.current || !injected.current) return false
        const done = await guest(
          view,
          `window.__orcaCanvas.patch(${JSON.stringify(input)})`,
          'patch',
        ).catch(() => false)
        return done === true
      },
      revision: async () => {
        const view = ref.current
        if (!view || loading.current || !injected.current) return null
        const value = await guest(view, 'window.__orcaCanvas.revision()', 'revision').catch(
          () => null,
        )
        return typeof value === 'string' ? value : null
      },
      follow: async ({ revision, slide, query, label }) => {
        const view = ref.current
        if (!view) throw new Error('UI_DISCONNECTED: 没有可见画布。')
        // 写盘触发的重载可能还没开始:先把要停的页记下,重载完就停在那儿
        if (slide !== undefined) restoreTo.current = slide
        await inspectCanvas('context', revision)
        if (slide !== undefined) {
          // 直接跳,不放转场:要看的是改动,不是翻页动画
          await guest(
            view,
            `Reveal.getIndices().h === ${slide} || void Reveal.slide(${slide})`,
            'slide',
          )
          await guest(
            view,
            'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
            'frame',
          )
        }
        if (slide === undefined) return undefined
        const area = () =>
          guest(view, 'window.__orcaCanvas.slideArea()', 'area') as Promise<StageTarget>
        const found = query
          ? toHost(
              (await guest(
                view,
                `window.__orcaCanvas.locate(${JSON.stringify(query)})`,
                'locate',
              )) as StageTarget,
            )
          : undefined
        // 那一处认不准(重名、被藏起来)也框整页:至少让人知道动的是这一页
        showFlag(found?.rect ? found : toHost(await area()), label)
        // 等两帧再交回位置:框得先真的画到屏幕上
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        return found
      },
      slideInfo: async () => {
        const result = await ref.current
          ?.run('window.__orcaInspect?.slideInfo() ?? null')
          .catch(() => null)
        return (result as SlideInfo | null) ?? null
      },
      notify: (message: string) => {
        void ref.current
          ?.run(`window.__orcaEdit?.notify(${JSON.stringify(message)})`)
          .catch(() => {})
      },
      whenReady: (timeoutMs = 4_000) =>
        new Promise<boolean>((resolve) => {
          if (!loading.current) return resolve(true)
          const timer = setTimeout(() => {
            // 明确报告未就绪，调用方不能把超时当作渲染完成。
            waiters.current = waiters.current.filter((entry) => entry !== resume)
            resolve(false)
          }, timeoutMs)
          const resume = () => {
            clearTimeout(timer)
            resolve(true)
          }
          waiters.current.push(resume)
        }),
    }),
    [],
  )

  /**
   * 翻页走 Reveal 自己的 API,而不是往 guest 里灌键盘事件。
   *
   * 理由:焦点可能在对话框或大纲上,这时候方向键根本进不了 guest;而且只有往后翻
   * 才播转场(往回翻是直接切),调 API 才能保证这个语义和用户在浏览器里按方向键一致。
   */
  useEffect(() => {
    if (!ready) return

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // 用户正在输入框里打字,方向键归输入框。
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      // agent 拿着稿子:翻页是它的,人要翻先接管。
      if (navLockedRef.current) return

      // 上下也翻:页胶片是竖着排的,↓ 就是往下一页
      const call = ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)
        ? 'next'
        : ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)
          ? 'previous'
          : undefined
      if (!call) return

      event.preventDefault()
      // 人自己翻页就别再自动播了 —— 跟他抢翻页是最烦的。
      // 翻到第几页不在这里读:转场没放完时 advance 会晚一点才翻,立刻读是旧的。
      // 页号由 guest 翻完之后自己报回来(见上面的 console-message)。
      onNavigate(call)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ready, onSlideChange, onNavigate])

  return (
    <div className="stage">
      <div className="stage-canvas">
        <div className="stage-frame stage-frame--live" data-ui-target="canvas" ref={frameRef}>
          <Canvas src={previewUrl} onView={onView} />
          {error && <div className="stage-error">{error}</div>}
          {overlay}
          {flag && (
            <div
              key={flag.seq}
              className="stage-flag"
              data-shown={flag.shown || undefined}
              style={{ left: flag.x, top: flag.y, width: flag.width, height: flag.height }}
              aria-hidden
            >
              {flag.label && (
                // 贴着框的上沿;框顶着画布上沿时放进框里,不然被画布裁掉
                <span className="stage-flag-label" data-inside={flag.y < 24 || undefined}>
                  {flag.label}
                </span>
              )}
            </div>
          )}
        </div>
        {/*
          贴在稿子正下方,不沉到画布底:离稿子两百像素的一行字读起来不属于任何东西。
          页数不写 —— 状态栏已经有「第几 / 共几页」。
        */}
      </div>
    </div>
  )
})

/** 在 guest 里跑一段,出错时带回真正的原因 —— webview 自己只会说「脚本执行失败」。 */
async function guest(view: CanvasView, expression: string, step: string): Promise<unknown> {
  const result = (await view.run(
    `(async () => { try { return { value: await (${expression}) } } catch (e) { return { error: String((e && e.stack) || e) } } })()`,
  )) as { value?: unknown; error?: string }
  if (result.error) throw new Error(`${step}: ${result.error}`)
  return result.value
}

function mergeErrors(...lists: CanvasError[][]): CanvasError[] {
  const errors = new Map<string, CanvasError>()
  for (const error of lists.flat()) {
    const key = JSON.stringify([error.kind, error.message, error.source])
    const previous = errors.get(key)
    errors.set(key, previous?.stack && !error.stack ? previous : error)
  }
  return [...errors.values()].slice(-50)
}
