import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CanvasElement,
  Control,
  DeckPhase,
  HistoryState,
  PendingRequest,
  RequestResult,
  RequestParams,
} from '@orca-ppt/contracts'
import { cropUrl, toAnchor } from './anchors.js'
import { Pending } from './Pending.js'
import { PhaseRail } from './PhaseRail.js'
import { Gallery, type Theme } from './Gallery.js'
import { Inspector } from './Inspector.js'
import { TransitionLink } from './TransitionLink.js'
import { readLayout, writeLayout, type Layout } from './layout.js'
import { applyTheme, readTheme, type ThemeSource } from './theme.js'
import { LightTable } from './LightTable.js'
import { Stage, type SlideInfo, type StageHandle, type TextEdit } from './Stage.js'
import { idle, isLive, prune, reduce, type AgentActivity } from './agent-activity.js'
import { Toolbar } from './Toolbar.js'
import { Transport, type TransportState } from './transport.js'
import { AgentStatus } from './AgentStatus.js'
import { Button } from './ui/Button.js'
import { assetUrl, useAssetOrigin } from './assets.js'

type OpenedDeck = RequestResult<'deck.open'>
type Template = RequestResult<'catalog.templates'>['templates'][number]

export function App({ serverUrl }: { serverUrl: string }) {
  const transport = useRef<Transport>(undefined)
  const stage = useRef<StageHandle>(null)
  const slideRef = useRef(0)
  const deckRef = useRef<OpenedDeck | undefined>(undefined)
  // 菜单处理器在只跑一次的 effect 里注册,拿 state 会读到旧值。
  const presentRef = useRef<() => void>(() => {})
  const toggleNavRef = useRef<() => void>(() => {})
  const toggleAutoplayRef = useRef<() => void>(() => {})
  const stepHistoryRef = useRef<(direction: 'undo' | 'redo') => void>(() => {})

  const [state, setState] = useState<TransportState>('closed')
  const [deck, setDeck] = useState<OpenedDeck | undefined>()
  const [slide, setSlide] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [crops, setCrops] = useState<Map<string, string>>(new Map())
  const [thumbs, setThumbs] = useState<Array<string | null>>([])
  const thumbsVersion = useRef(0)
  const thumbTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [agent, setAgent] = useState<AgentActivity>(idle)
  const [autoplay, setAutoplay] = useState(false)
  const [history, setHistory] = useState<HistoryState>({ canUndo: false, canRedo: false })
  /** 稿子此刻归谁动。agent 拿着时画布盖上遮罩,人要动先接管。 */
  const [control, setControl] = useState<Control>({ holder: 'none', explicit: false })
  const [templates, setTemplates] = useState<Template[]>([])
  const [themes, setThemes] = useState<Theme[]>([])
  /** 最近用过的主题。**不是标签** —— 系统从使用记录算出来的,所以单独一个字段。 */
  const [recent, setRecent] = useState<string[]>([])
  /** 标签 id → 显示名。词表在 skill 里,界面只管显示。 */
  const [tagLabels, setTagLabels] = useState<Record<string, string>>({})
  /** 页面类型 id → 显示名。和标签一样:文件里写 id,界面显示 label。 */
  const [pageLabels, setPageLabels] = useState<Record<string, string>>({})
  const [theme, setThemeState] = useState<ThemeSource>(readTheme)
  const [now, setNow] = useState(() => Date.now())
  const [creating, setCreating] = useState(false)
  const [layout, setLayout] = useState<Layout>(readLayout)
  const [selection, setSelection] = useState<CanvasElement | null>(null)
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState('')

  const openWith = useCallback(async (via: Transport, path: string) => {
    if (!path) return
    setError(undefined)
    try {
      const opened = await via.request('deck.open', { path })
      setDeck(opened)
      deckRef.current = opened
      setSelection(null)
      setSlide(0)
      slideRef.current = 0
      setRequests((await via.request('requests.list', { deckId: opened.deck.id })).requests)
      setHistory(await via.request('deck.history', { deckId: opened.deck.id }))
      void refreshThumbs(via, opened.deck.id)
    } catch (cause) {
      setDeck(undefined)
      deckRef.current = undefined
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    // 图片和 WebSocket 连同一个端口 —— 先告诉 assets 去哪儿取。
    useAssetOrigin(serverUrl)
    const next = new Transport(serverUrl)
    transport.current = next
    next.onStateChange = (current) => {
      setState(current)
      // 连上(包括断线重连)就问一次:断开那会儿错过的 control.changed 补不回来。
      if (current === 'open') {
        void next
          .request('control.state', {})
          .then(setControl)
          .catch(() => {})
      }
    }
    next.connect()

    next.subscribe('requests.changed', (data) => setRequests(data.requests))

    // agent 开了一份稿子,窗口跟着开。已经开着这份就不动 —— 免得把当前页跳回第一页。
    next.subscribe('deck.opened', (data) => {
      if (deckRef.current?.deck.id === data.deckId) return
      void openWith(next, data.path)
    })

    next.subscribe('phase.changed', (data) => {
      setDeck((current) => {
        if (!current || current.deck.id !== data.deckId) return current
        const phases = current.phases.map((row) =>
          row.phase === data.phase
            ? { phase: data.phase, status: data.status, issues: data.issues }
            : row,
        )
        const merged = { ...current, phases }
        deckRef.current = merged
        return merged
      })
    })

    // 稿子在磁盘上变了 —— 不管是 agent 改的还是用户自己在编辑器里改的,画布都跟着走。
    next.subscribe('deck.changed', (data) => {
      // 先抓更新前的值:setDeck 是异步的,更新里写 ref 再比较会比到新值。
      if (data.deckId === deckRef.current?.deck.id) setSelection(null)
      const previousUrl = deckRef.current?.previewUrl
      setDeck((current) => {
        if (!current || current.deck.id !== data.deckId) return current
        const merged = {
          ...current,
          slides: data.slides,
          slideCount: data.slideCount,
          slideTitles: data.slideTitles,
          pageTypes: data.pageTypes,
          previewUrl: data.previewUrl,
        }
        deckRef.current = merged
        return merged
      })
      // previewUrl 没变就只是内容变了,重载并回到原来那一页;
      // 从空变成有值说明成品刚出现,Stage 这时才第一次挂上,不用我们管。
      if (data.deckId === deckRef.current?.deck.id) {
        const nextSlide = Math.min(slideRef.current, Math.max(0, data.slideCount - 1))
        slideRef.current = nextSlide
        setSlide(nextSlide)
        if (previousUrl && data.previewUrl === previousUrl) stage.current?.reload(nextSlide)
        setThumbs([])
        thumbsVersion.current += 1
        clearTimeout(thumbTimer.current)
        thumbTimer.current = setTimeout(() => {
          if (deckRef.current?.deck.id === data.deckId) void refreshThumbs(next, data.deckId)
        }, 250)
      }
    })

    next.subscribe('mcp.activity', (data) => {
      setAgent((prev) => reduce(prev, data))
      // agent 改完一处,画布上那一处要自己闪一下 —— 页胶片只说得出「哪一页」,
      // 一页上有十几个元素。Stage 会攒到重载完成后再点,那时 DOM 才是新的。
      if (data.phase === 'done' && data.kind === 'write' && data.hint && !data.error) {
        stage.current?.spotlight(data.hint)
      }
    })

    // 改字、撤销、重做,不管是人还是 agent 做的,按钮都跟着。
    next.subscribe('history.changed', ({ deckId, ...state }) => {
      if (deckRef.current?.deck.id === deckId) setHistory(state)
    })

    next.subscribe('control.changed', setControl)

    next.subscribe('autoplay.changed', (data) => {
      if (data.deckId !== deckRef.current?.deck.id) return
      setAutoplay(data.on)
      stage.current?.autoplay(data.on)
    })

    // 放映只有壳开得了窗口。
    next.subscribe('present.request', (data) => {
      void window.orca?.present?.({ previewUrl: data.previewUrl, slide: data.slide })
    })

    // 缩略图也只有壳渲得了(隐藏窗口,不碰可见画布)。
    next.subscribe('thumbnails.request', (data) => {
      void (async () => {
        try {
          const paths = await window.orca?.renderThumbnails?.({
            previewUrl: data.previewUrl,
            slideCount: data.slideCount,
            ...(data.slides ? { slides: data.slides } : {}),
            ...(data.width ? { width: data.width } : {}),
          })
          await next.request('thumbnails.result', {
            requestId: data.requestId,
            ...(paths ? { paths } : { error: '这个客户端渲不了缩略图' }),
          })
        } catch (cause) {
          await next.request('thumbnails.result', {
            requestId: data.requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    })

    // agent 要自己看一眼做出来的东西 —— 只有壳截得了图。
    next.subscribe('visual.request', (data) => {
      void (async () => {
        try {
          if (data.deckId !== deckRef.current?.deck.id) throw new Error('DOCUMENT_CHANGED')
          const args = data.arguments
          const tracking = data.phase === 'track'
          const tracked =
            tracking && data.targetId ? (JSON.parse(data.targetId) as string[]) : undefined
          if (tracking && (!tracked || tracked[0] !== data.deckId))
            throw new Error('DOCUMENT_CHANGED')
          let rect: { x: number; y: number; width: number; height: number } | undefined
          let targetId: string | undefined
          if (data.phase !== 'prepare' && !tracking) {
            if (
              data.phase === 'completed' &&
              data.action === 'edit_text' &&
              typeof args.new_text === 'string'
            )
              stage.current?.spotlight(args.new_text)
            if (data.phase === 'failed') stage.current?.notify('操作未完成')
          } else if (
            data.action === 'edit_text' &&
            Number.isInteger(args.slide) &&
            typeof args.old_text === 'string'
          ) {
            await stage.current?.whenReady(1000)
            const target = await stage.current?.targetText(
              Number(args.slide),
              args.old_text,
              tracking ? tracked?.[1] : undefined,
              tracking && typeof args.new_text === 'string' ? args.new_text : undefined,
            )
            if (target) {
              rect = target
              targetId = JSON.stringify([data.deckId, target.targetId])
            }
          } else {
            const label =
              data.action === 'show_slide'
                ? `第 ${Number(args.index) + 1} 页`
                : data.action === 'undo'
                  ? '撤销'
                  : '重做'
            const element = [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(
              (e) => e.getAttribute('aria-label') === label,
            )
            if (element) {
              rect = element.getBoundingClientRect()
              targetId = JSON.stringify([data.deckId, label])
            }
          }
          if (tracking && targetId !== data.targetId) rect = undefined
          if (data.deckId !== deckRef.current?.deck.id) throw new Error('DOCUMENT_CHANGED')
          const bounds = await window.orca?.contentBounds?.()
          const valid =
            rect &&
            bounds &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.x + rect.width <= innerWidth &&
            rect.y + rect.height <= innerHeight
          await next.request('visual.result', {
            requestId: data.requestId,
            target: {
              measuredAt: Date.now(),
              ...(valid && rect && bounds
                ? {
                    rect: {
                      x: bounds.x + rect.x * bounds.zoom,
                      y: bounds.y + rect.y * bounds.zoom,
                      width: rect.width * bounds.zoom,
                      height: rect.height * bounds.zoom,
                    },
                    ...(targetId ? { targetId } : {}),
                  }
                : {}),
            },
          })
        } catch (cause) {
          await next.request('visual.result', { requestId: data.requestId, error: String(cause) })
        }
      })()
    })

    next.subscribe('canvas.request', (data) => {
      void (async () => {
        try {
          if (data.deckId !== deckRef.current?.deck.id) throw new Error('DOCUMENT_CHANGED')
          const canvas = stage.current
          if (!canvas) throw new Error('RENDER_NOT_READY: 当前视图没有画布。')
          const evidence =
            data.action === 'select'
              ? await canvas.selectCanvas(data)
              : await canvas.inspectCanvas(data.include, data.expectedRevision)
          if (data.deckId !== deckRef.current?.deck.id) throw new Error('DOCUMENT_CHANGED')
          setSelection(evidence.selection)
          await next.request('canvas.result', { requestId: data.requestId, evidence })
        } catch (cause) {
          await next.request('canvas.result', {
            requestId: data.requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    })

    next.subscribe('capture.request', (data) => {
      void (async () => {
        try {
          if (data.deckId !== deckRef.current?.deck.id) throw new Error('DOCUMENT_CHANGED')
          const canvas = stage.current
          if (!canvas || !(await canvas.whenReady())) throw new Error('RENDER_NOT_READY')
          const before = await canvas.inspectCanvas('context', data.expectedRevision)
          if (
            !before.ready ||
            before.slide === null ||
            (data.slide !== undefined && before.slide !== data.slide)
          )
            throw new Error('SLIDE_CHANGED: 画布尚未到达目标页。')
          const path = await window.orca?.captureCanvas?.({ guestId: canvas.guestId() })
          const after = await canvas.inspectCanvas('context')
          if (
            data.deckId !== deckRef.current?.deck.id ||
            before.slide !== after.slide ||
            before.renderedRevision !== after.renderedRevision ||
            !after.ready
          )
            throw new Error('CANVAS_CHANGED: 截图过程中画布已变化。')
          await next.request('capture.result', {
            requestId: data.requestId,
            ...(path
              ? {
                  path,
                  slide: before.slide,
                  ...(before.renderedRevision ? { renderedRevision: before.renderedRevision } : {}),
                }
              : { error: '画布还没加载出来' }),
          })
        } catch (cause) {
          await next.request('capture.result', {
            requestId: data.requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    })

    // agent 说「你看第 4 页」,画布跟着跳。
    next.subscribe('deck.slide', (data) => {
      if (data.deckId !== deckRef.current?.deck.id) return
      if (data.index !== slideRef.current) setSelection(null)
      setSlide(data.index)
      slideRef.current = data.index
      stage.current?.goto(data.index)
    })

    next.subscribe('deck.navigation', (data) => {
      if (data.deckId !== deckRef.current?.deck.id) return
      stage.current?.navigate(data.action, data.from)
    })

    // 菜单里的动作。它和顶栏按钮走同一条路 —— 菜单只是另一个触发器。
    window.orca?.onMenuAction?.((action) => {
      if (action === 'open') void pickDeck(open)
      else if (action === 'present') presentRef.current()
      else if (action === 'toggle-nav') toggleNavRef.current()
      else if (action === 'toggle-autoplay') toggleAutoplayRef.current()
      else if (action === 'undo' || action === 'redo') stepHistoryRef.current(action)
      else if (action.startsWith('theme:')) {
        const next = action.slice('theme:'.length) as ThemeSource
        applyTheme(next)
        setThemeState(next)
      }
    })

    void next
      .request('catalog.templates', {})
      .then((result) => setTemplates(result.templates))
      .catch(() => setTemplates([]))

    // 主题是选择器的主角 —— 主题就是场景,人带着自己的场合来。
    void next
      .request('catalog.list', {})
      .then((result) => {
        setThemes(result.themes)
        setRecent(result.recent)
        setTagLabels(Object.fromEntries(result.tags.map((tag) => [tag.id, tag.label])))
        setPageLabels(Object.fromEntries(result.pages.map((page) => [page.id, page.label])))
        // 标签不能自由决定:拼错的、没挂标签的都在这儿,不默默放过。
        if (result.tagIssues.length > 0) console.warn('标签有问题:', result.tagIssues)
      })
      .catch(() => setThemes([]))

    const initial = window.orca?.initialDeck
    if (initial) void openWith(next, initial)
  }, [serverUrl, openWith])

  /** 页胶片的缩略图。渲不出来就留空 —— 页号和标题仍然在。 */
  const refreshThumbs = useCallback(async (via: Transport, deckId: string) => {
    const version = ++thumbsVersion.current
    setThumbs([])
    if (!window.orca?.renderThumbnails) return
    try {
      const { paths } = await via.request('deck.thumbnails', { deckId })
      if (version === thumbsVersion.current && deckRef.current?.deck.id === deckId) setThumbs(paths)
    } catch {
      if (version === thumbsVersion.current && deckRef.current?.deck.id === deckId) setThumbs([])
    }
  }, [])

  useEffect(
    () => () => {
      clearTimeout(thumbTimer.current)
      thumbsVersion.current += 1
    },
    [],
  )

  const open = useCallback(
    (path: string) => (transport.current ? openWith(transport.current, path) : undefined),
    [openWith],
  )

  /** 在画布上点一处,连同裁切图挂进待办队列。 */
  const pick = useCallback(async () => {
    const active = transport.current
    const current = deckRef.current
    if (!stage.current || !active || !current) return

    setPicking(true)
    try {
      const picked = await stage.current.pick()
      if (!picked) return

      // 界面不碰文件系统 —— 截图和落盘都在壳里,这儿只拿回一个路径。
      const crop = await window.orca?.captureAnchor?.({
        guestId: stage.current.guestId(),
        box: picked.viewportBox,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      })
      const added = await active.request('requests.add', {
        deckId: current.deck.id,
        kind: 'anchor',
        anchor: toAnchor(picked, note, crop),
      })
      const url = cropUrl(crop)
      if (url) setCrops((existing) => new Map(existing).set(added.id, url))
      setNote('')
    } finally {
      setPicking(false)
    }
  }, [note])

  const selectElement = useCallback(async (clear = false) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current || !stage.current) return
    try {
      const context = await active.request('canvas.inspect', {
        deckId: current.deck.id,
        include: 'context',
      })
      if (!context.current) throw new Error('画布正在更新，请稍后选择。')
      const picked = clear ? null : await stage.current.pick()
      if (!clear && !picked) return
      const result = await active.request('canvas.select', {
        deckId: current.deck.id,
        selector: picked?.selector ?? null,
        slide: picked?.slide ?? context.slide ?? 0,
        expectedRevision: context.revision,
      })
      setSelection(result.selection)
    } catch (cause) {
      stage.current?.notify(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const editPages = useCallback(async (change: RequestParams<'deck.editPages'>['change']) => {
    const active = transport.current,
      current = deckRef.current
    if (!active || !current) return
    const page = slideRef.current
    try {
      const context = await active.request('canvas.inspect', {
        deckId: current.deck.id,
        include: 'context',
      })
      if (
        !context.current ||
        !context.ready ||
        context.slide !== page ||
        deckRef.current?.deck.id !== current.deck.id
      )
        throw new Error('画布正在更新，请稍后再编辑页面。')
      const result = await active.request('deck.editPages', {
        deckId: current.deck.id,
        expectedRevision: context.revision,
        change,
      })
      if (!result.ok) throw new Error(result.reason ?? '页面编辑失败')
      if (result.slide !== undefined) {
        slideRef.current = result.slide
        setSlide(result.slide)
        stage.current?.reload(result.slide)
        await active.request('deck.showSlide', { deckId: current.deck.id, index: result.slide })
      }
    } catch (cause) {
      stage.current?.notify(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const replaceSelectedImage = useCallback(
    async (source: string) => {
      const active = transport.current,
        current = deckRef.current,
        picked = selection
      if (!active || !current || !picked || picked.tag !== 'img' || !picked.source) return
      const page = slideRef.current
      try {
        const context = await active.request('canvas.inspect', {
          deckId: current.deck.id,
          include: 'context',
        })
        if (
          !context.current ||
          !context.ready ||
          context.slide !== page ||
          context.selection?.selector !== picked.selector ||
          context.selection.source !== picked.source
        )
          throw new Error('选中的图片已变化，请重新选择。')
        const result = await active.request('deck.replaceImage', {
          deckId: current.deck.id,
          slide: page,
          selector: picked.selector,
          oldSource: picked.source,
          source,
          expectedRevision: context.revision,
        })
        if (!result.ok) throw new Error(result.reason ?? '图片替换失败')
      } catch (cause) {
        stage.current?.notify(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [selection],
  )

  /** 点「跑」不直接驱动谁 —— 挂进待办队列,等 agent 来拉。 */
  const requestPhase = useCallback((phase: DeckPhase) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    void active.request('requests.add', { deckId: current.deck.id, kind: 'phase', phase })
  }, [])

  const removeRequest = useCallback((id: string) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    void active.request('requests.remove', { deckId: current.deck.id, id })
  }, [])

  const present = useCallback(() => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    // 走协议而不是直接开窗:agent 说「放给我看」触发的是同一条路。
    void active.request('deck.present', { deckId: current.deck.id, slide: slideRef.current })
  }, [])

  const changeLayout = useCallback((next: Partial<Layout>) => {
    setLayout((current) => {
      const merged = { ...current, ...next }
      writeLayout(merged)
      return merged
    })
  }, [])

  /** 菜单里的「显示/隐藏页胶片」:在导航器和收起之间来回。 */
  const toggleNav = useCallback(() => {
    setLayout((current) => {
      const merged: Layout = { ...current, nav: current.nav === 'off' ? 'thumbs' : 'off' }
      writeLayout(merged)
      return merged
    })
  }, [])

  presentRef.current = present
  toggleNavRef.current = toggleNav

  // 菜单里的启用状态和主题勾选跟着界面走。
  useEffect(() => {
    void window.orca?.setMenuState?.({ canPresent: Boolean(deck?.previewUrl), theme })
  }, [deck?.previewUrl, theme])

  /** 接管 / 交还。走协议 —— 界面能做的每一件事都是一个协议方法。 */
  const setHolder = useCallback(
    (method: 'control.takeOver' | 'control.stop' | 'control.release') => {
      void transport.current
        ?.request(method, {})
        .then(setControl)
        .catch(() => {})
    },
    [],
  )

  const toggleAutoplay = useCallback(() => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    // 走协议:agent 说「自动放一遍」走的是同一条路。
    void active.request('deck.autoplay', { deckId: current.deck.id, on: !autoplay })
  }, [autoplay])

  /** 选了模板就建、就打开 —— 中间不该再让人挑一次目录。 */
  const create = useCallback(
    async (template: Template, title: string, theme?: string) => {
      const active = transport.current
      if (!active) return
      // 放哪儿:让人挑一次父目录。deck 是磁盘上的目录,得由他决定放在哪。
      const parentDir = await window.orca?.pickDeck?.()
      if (!parentDir) return

      setCreating(true)
      setError(undefined)
      try {
        const made = await active.request('deck.create', {
          parentDir,
          title,
          from: template.id,
          ...(theme ? { theme } : {}),
        })
        await openWith(active, made.path)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setCreating(false)
      }
    },
    [openWith],
  )

  /** 重放一次翻页:先跳回上一页,再往后翻一次 —— 往后翻才播转场。 */
  const replay = useCallback((from: number) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    void active.request('deck.navigation', { deckId: current.deck.id, action: 'replay', from })
  }, [])

  /**
   * 人在画布上双击改完了一段文字。服务端在源文件里精确换掉那一段,只换文字。
   * 改不了的时候要把理由还回 guest —— 沉默比拒绝更难受。
   */
  const editText = useCallback(async (edit: TextEdit): Promise<string | undefined> => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return '还没打开稿子'
    try {
      const result = await active.request('deck.editText', { deckId: current.deck.id, ...edit })
      // 写盘之后 watcher 会推 deck.changed,画布自己重载 —— 这儿不用再动它。
      return result.ok ? undefined : result.reason
    } catch (error) {
      return error instanceof Error ? error.message : '没改成'
    }
  }, [])

  /**
   * 撤销 / 重做一处改字。成了就翻到那一页、把那一处点亮 —— 撤的可能不是眼前这页,
   * 人得看见动的是哪儿;不成就在画布上把理由说出来。
   */
  const stepHistory = useCallback(async (direction: 'undo' | 'redo') => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    try {
      const method = direction === 'undo' ? 'deck.undo' : 'deck.redo'
      const result = await active.request(method, { deckId: current.deck.id })
      if (!result.ok) {
        stage.current?.notify(result.reason ?? '没做成')
        return
      }
      if (result.slide !== undefined && result.slide !== slideRef.current) {
        // 走协议方法,不直接动画布:和 agent 让画布翻页是同一条路。
        await active.request('deck.showSlide', { deckId: current.deck.id, index: result.slide })
      }
      if (result.text) stage.current?.spotlight(result.text)
    } catch (cause) {
      stage.current?.notify(cause instanceof Error ? cause.message : '没做成')
    }
  }, [])
  stepHistoryRef.current = (direction) => void stepHistory(direction)

  /** 指着一次转场说「这儿不对」—— 产生一条转场锚,和画布上点元素同一个去处。 */
  const flagTransition = useCallback(
    (from: number, to: number) => {
      const active = transport.current
      const current = deckRef.current
      if (!active || !current) return
      void active.request('requests.add', {
        deckId: current.deck.id,
        kind: 'anchor',
        anchor: { kind: 'transition', from, to, note },
      })
      setNote('')
    },
    [note],
  )

  toggleAutoplayRef.current = toggleAutoplay

  /** 这一步该怎么做。上游不合规时 server 会拒绝并说清卡在哪 —— 那也是人要看的。 */
  const loadPrompt = useCallback(async (phase: DeckPhase) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return ''
    const result = await active.request('phase.prompt', {
      deckId: current.deck.id,
      phase,
      request: '',
    })
    if (result.prompt) return result.prompt
    return `这一步还不能开始,卡在「${result.blockedBy}」:\n${result.issues.map((i) => `· ${i}`).join('\n')}`
  }, [])

  const goto = useCallback((index: number) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    // 走协议而不是直接驱动画布:跳页是一个协议方法,agent 也能调它。
    void active.request('deck.showSlide', { deckId: current.deck.id, index })
  }, [])

  const openArtifact = useCallback(async (phase: DeckPhase) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    const { path } = await active.request('artifact.path', { deckId: current.deck.id, phase })
    void window.orca?.openFile?.(path)
  }, [])

  /**
   * 高亮到点要自己灭 —— 时间自己会走,不能等下一条推送才过期,否则 agent 一停,
   * 最后那圈高亮就永远亮着。
   *
   * 只在有东西亮着时才走这个计时器,闲着的时候一帧都不跑。
   */
  const agentBusy = agent.touched.size > 0 || Boolean(agent.running) || Boolean(agent.failed)
  useEffect(() => {
    if (!agentBusy) return
    // 250ms:够让一次退场看着是"淡出"而不是"跳掉",又不至于每帧都在算。
    const timer = setInterval(() => {
      const at = Date.now()
      setNow(at)
      setAgent((prev) => prune(prev, at))
    }, 250)
    return () => clearInterval(timer)
  }, [agentBusy])

  // agent 在不在,只能看它最近动没动 —— MCP 是无状态 HTTP,没有连接可查。
  const agentLive = isLive(agent, now)

  /**
   * 这一页在画布上的情况(停留时长、参与转场的元素)。只有画布答得出来,所以翻一页
   * 就重新问一次。画布没加载时是 null —— 界面如实说「画布还没加载」,不编。
   */
  const [slideInfo, setSlideInfo] = useState<SlideInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    // **先等画布加载完**。不等的话,刚打开稿子时问到的永远是 null,右栏一直显示
    // 「画布还没加载」—— 看起来像功能坏了,其实只是问早了。
    void stage.current
      ?.whenReady()
      .then(() => stage.current?.slideInfo())
      .then((info) => {
        if (!cancelled) setSlideInfo(info ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [slide, deck?.previewUrl])

  /** 这份稿子用的主题,显示人读的那个名字。 */
  const themeTitle = themes.find((item) => item.name === deck?.theme)?.title ?? deck?.theme

  /** 一页显示什么文字。outline 的 subject 是定下来的决定,优先于从稿子认出来的标签。 */
  const titleOf = useCallback(
    (index: number) => deck?.slides[index]?.subject ?? deck?.slideTitles[index] ?? '—',
    [deck],
  )

  const onSlideChange = useCallback((index: number) => {
    if (index !== slideRef.current) setSelection(null)
    setSlide(index)
    slideRef.current = index
    const current = deckRef.current
    if (current)
      void transport.current?.request('deck.visibleSlide', { deckId: current.deck.id, index })
  }, [])

  /**
   * guest 是「在不在播」的唯一真相:它会自己停(放完最后一页、或者人在画布里动了手),
   * 而它没法反过来通知我们。所以开着的时候问它一下。
   *
   * 宿主这边不再自己判断「人动手了」—— 两套互不知情的停止条件,必然对不上:
   * 实测过 guest 已经停了而按钮还亮着,以及反过来。
   */
  useEffect(() => {
    if (!autoplay) return
    const timer = setInterval(() => {
      void stage.current?.autoplayRunning().then((running) => {
        if (!running) {
          setAutoplay(false)
          const current = deckRef.current
          if (current)
            void transport.current?.request('deck.autoplay', { deckId: current.deck.id, on: false })
        }
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [autoplay])

  // 没打开稿子时,整屏是模板选择器 —— 三栏都没有内容可放,摆在那儿只是空框。
  const agentHolds = control.holder === 'agent'

  if (!deck) {
    // 选择器上不摆顶栏:播放、自动播放、视图切换在这儿全是灰的 —— 没有稿子可播、
    // 没有栏可切。它自己的 header 当窗口拖动区。
    return (
      <div className="app app--gallery">
        <Gallery
          themes={themes}
          recent={recent}
          tagLabel={(id) => tagLabels[id] ?? id}
          templates={templates}
          busy={creating}
          error={error}
          onCreate={(template, title, theme) => void create(template, title, theme)}
          onOpen={() => void pickDeck(open)}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar
        title={deck?.deck.title}
        layout={layout}
        onLayoutChange={changeLayout}
        canPresent={Boolean(deck?.previewUrl)}
        onPresent={present}
        history={history}
        locked={agentHolds}
        onUndo={() => void stepHistory('undo')}
        onRedo={() => void stepHistory('redo')}
        picking={picking}
        canPick={Boolean(deck?.previewUrl) && !agentHolds}
        onPick={() => {
          if (!picking) return void pick()
          stage.current?.cancelPick()
          setPicking(false)
        }}
      />
      <div className="shell" data-nav={layout.nav} data-maker={layout.maker}>
        {/* 左栏只干一件事:在这份稿子里导航。阶段栏是「怎么做出它」,不是一回事。 */}
        <section className="pane pane--nav">
          {/*
            非默认视图要标出来。不标的话「大纲」看起来就是「导航器坏了、缩略图没加载」——
            两者只差一张图,分不出是模式还是故障。
          */}
          {layout.nav === 'outline' && <header className="pane-head">大纲</header>}
          <div className="pane-body">
            {deck ? (
              <ol className="filmstrip">
                {Array.from({ length: deck.slideCount }, (_, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      aria-label={`第 ${index + 1} 页`}
                      data-current={index === slide}
                      // agent 碰过的页要亮一下。读和写分开:读是「它在看这儿」,
                      // 写是「这儿被改了」,后者更要紧,也留得更久。
                      data-agent={agent.touched.get(index)?.kind}
                      onClick={() => goto(index)}
                    >
                      <span className="filmstrip-no">{index + 1}</span>
                      {/*
                        导航器只有图,大纲只有字。标题在缩略图里本来就看得清,
                        旁边再写一遍是重复,还挤掉图的宽度。
                      */}
                      {layout.nav === 'thumbs' ? (
                        thumbs[index] ? (
                          <img className="filmstrip-thumb" src={assetUrl(thumbs[index])} alt="" />
                        ) : (
                          <span className="filmstrip-thumb filmstrip-thumb--empty" />
                        )
                      ) : (
                        <span className="filmstrip-title">{titleOf(index)}</span>
                      )}
                    </button>
                    {index < deck.slideCount - 1 && (
                      <TransitionLink
                        note={deck.transitionPlan.find((t) => t.from === index)}
                        onReplay={() => replay(index)}
                        onFlag={() => flagTransition(index, index + 1)}
                      />
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <DeckPicker onPick={() => void pickDeck(open)} onPath={open} error={error} />
            )}
          </div>
        </section>

        <section className="pane pane--stage">
          {deck && layout.lightTable ? (
            <LightTable
              count={deck.slideCount}
              current={slide}
              thumbs={thumbs}
              onPick={(index) => {
                goto(index)
                changeLayout({ lightTable: false })
              }}
            />
          ) : deck?.previewUrl ? (
            <Stage
              ref={stage}
              previewUrl={deck.previewUrl}
              initialSlide={slide}
              autoplay={autoplay}
              onToggleAutoplay={toggleAutoplay}
              onSlideChange={onSlideChange}
              onNavigate={(action) => {
                void transport.current?.request('deck.navigation', { deckId: deck.deck.id, action })
              }}
              onTextEdit={editText}
              readOnly={agentHolds}
              overlay={agentHolds && <div className="stage-lock" />}
            />
          ) : (
            <div className="stage">
              <div className="stage-canvas">
                <div className="stage-frame">
                  {deck
                    ? '成品还没出来 —— 把阶段跑到「出稿」,它会在这里放映。'
                    : '打开一个 deck 目录,它会在这里放映。'}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="pane">
          {deck ? (
            <Inspector
              selection={selection}
              locked={agentHolds}
              onEditPages={editPages}
              onReplaceImage={replaceSelectedImage}
              onSelect={() => void selectElement()}
              onClearSelection={() => void selectElement(true)}
              slide={slide}
              slideCount={deck.slideCount}
              title={titleOf(slide)}
              info={slideInfo}
              note={deck.transitionPlan.find((row) => row.from === slide)}
              phases={deck.phases}
              themeTitle={themeTitle}
              pageType={
                deck.pageTypes[slide]
                  ? (pageLabels[deck.pageTypes[slide]] ?? deck.pageTypes[slide] ?? undefined)
                  : undefined
              }
              onReplay={() => replay(slide)}
              onFlag={() => flagTransition(slide, slide + 1)}
              onOpenArtifact={(phase) => void openArtifact(phase)}
              onLoadPrompt={loadPrompt}
            />
          ) : (
            <div className="pane-body">先打开一份 deck。</div>
          )}
        </section>
      </div>

      {/*
        状态栏横跨整个窗口。只横在中间一栏下面的话,它读起来像画布的一部分,
        而它说的是整个应用的事:连没连上、agent 在不在、刚指了哪儿。
      */}
      <footer className="status">
        {/* 连着的时候只亮一个点;断了才说话 —— 常驻「open」这种词是内部状态漏到界面上。 */}
        <span className="dot" data-off={state !== 'open'} title={TRANSPORT_LABEL[state]}>
          ●
        </span>
        {state !== 'open' && <span>{TRANSPORT_LABEL[state]}</span>}
        {deck && (
          <span>
            第 {slide + 1} / {deck.slideCount} 页
          </span>
        )}
        {/*
          「已指给 agent · …」是刚发生了什么,归状态栏 —— 那个动作本身在工具栏上,
          它的回执不该占着右栏一块地方。完全没有回执也不行:人分不清点中没有。
        */}
        <Pending requests={requests} crops={crops} />
        <AgentStatus
          control={control}
          connected={state === 'open' && agentLive}
          onTakeOver={() => setHolder('control.takeOver')}
          onStop={() => setHolder('control.stop')}
          onRelease={() => setHolder('control.release')}
        />
      </footer>
    </div>
  )
}

const TRANSPORT_LABEL: Record<TransportState, string> = {
  connecting: '正在连本地服务…',
  open: '本地服务已连上',
  reconnecting: '和本地服务断开了,重连中…',
  closed: '没连上本地服务',
}

async function pickDeck(open: (path: string) => unknown): Promise<void> {
  // 界面不碰文件系统 —— 壳弹目录选择器,只把路径交回来。
  const path = await window.orca?.pickDeck?.()
  if (path) open(path)
}

function DeckPicker({
  onPick,
  onPath,
  error,
}: {
  onPick: () => void
  onPath: (path: string) => void
  error?: string | undefined
}) {
  const [path, setPath] = useState('')
  const canPick = Boolean(window.orca?.pickDeck)

  return (
    <div className="picker">
      {canPick ? (
        <Button onClick={onPick}>打开 deck 目录…</Button>
      ) : (
        // 浏览器里跑 `pnpm dev` 时没有壳,直接贴路径。
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onPath(path)
          }}
        >
          <input
            value={path}
            placeholder="deck 目录的绝对路径"
            onChange={(event) => setPath(event.target.value)}
          />
        </form>
      )}
      <p className="muted">
        认 <code>deck.html</code> 和 <code>index.html</code>,skill 做出来的稿子直接能开。
      </p>
      {error && <p className="picker-error">{error}</p>}
    </div>
  )
}
