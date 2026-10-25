import { z } from 'zod'
import { Anchor, DeckPhase, DeckSummary, Slide, Transition, TransitionNote } from './domain.js'

/**
 * 线上协议。两个方向、每个载荷都在边界上校验 —— 这个包是唯一真相,改协议就是改这里,
 * server、界面和 MCP server 各自跟着 typecheck 报错,这是有意的。
 *
 * **不变量:界面能做的每一件事都是这里的一个方法。** MCP 是这个协议的第二个薄客户端;
 * 界面里有、这里没有的操作,不许存在(见 docs/ARCHITECTURE.md)。
 */

/**
 * 导出 PPTX 的降级:这一次翻页在 PowerPoint 里和网页不一样。档位和回退规则在 skill 的
 * `references/transitions.md`「导出 PPTX」,这里只是把结果带回来。
 */
export const PptxDegraded = z.object({
  /** 从第几页翻到第几页(从 1 数)。 */
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  /** 网页里用的手法,几个就用「 + 」连起来。 */
  technique: z.string(),
  tier: z.enum(['近似', '降级', '丢失']),
  /** PowerPoint 里实际用的转场。 */
  kind: z.enum(['morph', 'fade', 'wipe', 'none']),
})

/** 壳交回来的导出报告:skill 导出器的原始报告,只取用得到的几项。 */
export const PptxExportReport = z.object({
  slides: z.array(
    z.object({
      index: z.number().int().positive(),
      /** 这一页导不出来的效果,人话。 */
      lost: z.array(z.string()),
      /** 转成图片的元素(PowerPoint 画不出来的)。 */
      rasters: z.array(z.unknown()),
    }),
  ),
  degraded: z.array(PptxDegraded),
  /** 用到的字体。字体不嵌进文件,看的那台电脑要装。 */
  fonts: z.array(z.string()),
})

/** 首页上指着一个同款时给人看什么。 */
export const RecipeFocusShow = z.enum(['prompt', 'none'])

/**
 * 界面上一处东西在屏幕上的位置(`studio.orca/ui-targets` v1,和 ocut pro 同一份约定)。
 * 录屏宿主拿它推近画面、画目标框 —— 它只看得到像素,不知道哪个像素是「刚改的那段字」。
 *
 * 只读:查询不翻页、不选中、不滚动。画布上的元素只在那一页正显示着时才 visible。
 */
export const UiRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})
export type UiRect = z.infer<typeof UiRect>
export const UiTargetQuery = z.union([
  /** 某页上整段文字是它的那个元素(叶子元素,和改字一样按源文字认,不按屏幕上的大小写)。 */
  z.strictObject({ slide: z.number().int().nonnegative(), text: z.string().min(1).max(2000) }),
  /** 某页上的页内选择器(get_canvas_elements 给的那种)。 */
  z.strictObject({
    slide: z.number().int().nonnegative(),
    selector: z.string().min(1).max(2000),
  }),
  /** 界面控件:canvas、filmstrip.slide.<n>、history.undo、history.redo、control.capsule,
   * 以及回执里给出的 targetId。 */
  z.strictObject({ controlId: z.string().min(1).max(2100) }),
])
export type UiTargetQuery = z.infer<typeof UiTargetQuery>
export const UiTargetStatus = z.enum([
  'visible',
  'not_visible',
  'not_found',
  'unsupported',
  'ambiguous',
  'unavailable',
])
export const UiTarget = z.object({
  query: UiTargetQuery,
  status: UiTargetStatus,
  /** 所在窗口:id 和此刻的内容区边界(屏幕点)。 */
  window: z.object({ id: z.string(), bounds: UiRect }).optional(),
  /** 稳定的目标标识。原样当 controlId 再查,就是同一处。 */
  targetId: z.string().optional(),
  /** 屏幕点,左上角为原点。只在 visible 时给;露出一部分就给露出的那部分。 */
  rect: UiRect.optional(),
  /** 没定位到时给机器看的原因。 */
  reason: z.string().optional(),
})
export type UiTarget = z.infer<typeof UiTarget>
/** 一批定位结果(resolve_ui_targets 的返回)。测完就会过时:窗口一动、画布一翻页就得重查。 */
export const UiTargets = z.object({
  /** Unix 毫秒。 */
  measuredAt: z.number(),
  coordinateSpace: z.literal('screen_points_top_left'),
  targets: z.array(UiTarget),
})
export type UiTargets = z.infer<typeof UiTargets>
/**
 * 写操作回执和操作记录里的 `uiTargets`:有序数组,由细到粗 —— 先是被改的那一处,再是整张画布。
 * 每一项自带量的时刻。数组不另带 coordinateSpace:rect 一律是全局屏幕点、左上角为原点
 * (screen_points_top_left)。录屏宿主直接拿它当这一步的目标框。
 */
export const UiTargetList = z.array(UiTarget.extend({ measuredAt: z.number() }))
export type UiTargetList = z.infer<typeof UiTargetList>
export const UI_TARGETS_MAX_BATCH = 32
/** 工具 `_meta` 里声明这项能力用的键。用提供方的名义,不用某个宿主的。 */
export const UI_TARGETS_CAPABILITY = 'studio.orca/ui-targets'

/**
 * 演示模式:agent 经 MCP 并发发来的改动排成队,一条一条落到画布上,每条之间留出人眼看得清的
 * 时间。MCP 越快越好,人眼却需要时间 —— 录教学视频时由应用兜底,不指望提示词约束 agent。
 * 不开时改动照样跟着翻页、点亮,只是不等。
 */
export const Demo = z.object({
  on: z.boolean(),
  /** 每条改动显示出来之后停多久(毫秒)。 */
  intervalMs: z.number().int().min(300).max(5000),
})
export type Demo = z.infer<typeof Demo>
export const DEMO_DEFAULT_INTERVAL_MS = 1200

export const PhaseStatus = z.enum(['idle', 'running', 'done', 'failed'])
export type PhaseStatus = z.infer<typeof PhaseStatus>

export const PhaseReport = z.object({
  phase: DeckPhase,
  status: PhaseStatus,
  issues: z.array(z.string()),
})
export type PhaseReport = z.infer<typeof PhaseReport>

/**
 * 待办:人在界面上做了一件需要 agent 干活的事。
 *
 * MCP 没有可靠的「把消息推进用户对话」的原语,所以方向反过来 —— 挂在这儿等 agent 来拉。
 */
export const PendingRequest = z.union([
  z.object({ id: z.string(), kind: z.literal('anchor'), anchor: Anchor, createdAt: z.number() }),
  z.object({ id: z.string(), kind: z.literal('phase'), phase: DeckPhase, createdAt: z.number() }),
])
export type PendingRequest = z.infer<typeof PendingRequest>

/**
 * 共享编辑的撤销 / 重做走到哪了。`undo` / `redo` 是下一步会撤掉 / 重做的那一处,
 * 给界面当按钮提示用 —— 「撤销」两个字不说清是哪一处,人不敢点。
 */
export const HistoryState = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undo: z.string().optional(),
  redo: z.string().optional(),
})
export type HistoryState = z.infer<typeof HistoryState>

/**
 * 稿子此刻归谁动。同一时刻只有一方能改 —— 两边同时改同一份文件,总有一边的改动会被
 * 悄悄盖掉。交接的做法借自 ego-lite 浏览器:agent 明说拿起、明说交还,人随时能接管。
 *
 * - `none`:谁都能动。
 * - `agent`:agent 拿着。它明说的(`control.take`),或者从它正在调的工具猜的。
 *   这时界面发来的改稿子请求一律拒绝。
 * - `user`:人在界面上接管了。这时 agent 的工具一律拒绝(拿回控制权那个除外),
 *   话术要它**停下、别重试、等人说继续**。
 */
export const Control = z.object({
  holder: z.enum(['none', 'agent', 'user']),
  /**
   * agent 是明说拿着的。猜的那种停下几秒就放;明说的要等它交还,或者长时间没动静 ——
   * agent 可能直接消失,不能让它把稿子锁死。
   */
  explicit: z.boolean(),
  /**
   * 这一整段活儿的名字:take_control 的 reason。胶囊第一行。人接管、agent 交还之后还留着 ——
   * 人得知道停下的、交回来的是哪件事。猜的持有没有这一项。
   */
  task: z.string().optional(),
  /** 此刻正在跑的那次工具调用,人话。胶囊第二行。调用结束就清掉。 */
  doing: z.string().optional(),
  /** agent 在等人批准什么。有值时第二行改成「等你批准:…」。 */
  waiting: z.string().optional(),
  /** 人按了「停止」:这件事不做了。和接管的区别是 agent 收到的话 —— 接管是暂停,停止是到此为止。 */
  stopped: z.boolean().optional(),
  /** agent 交还时留给人的话:「第 3 页的数字请你确认一下」。人看过之后清掉。 */
  message: z.string().optional(),
})
export type Control = z.infer<typeof Control>

/**
 * 「可录制应用」约定 v1(jevbot-mac docs/recordable-app-contract.md)里的一条事件:
 * 稿子被改了一次 —— 谁改的、改了什么、改完之后的版本号。回放的主体在宿主那边,
 * 应用只负责把「人在界面上做了什么」这类宿主看不到的事报出来。
 */
export const RecordingDocument = z.object({
  /** 稿子目录的绝对路径 —— 和 deckId 同一个值。 */
  id: z.string(),
  label: z.string(),
})
export const RecordingEvent = z.object({
  /** 游标。补零的序号,按字符串比较严格递增,重启后接着编号。 */
  id: z.string(),
  /** ISO 8601,精确到毫秒,带时区。 */
  at: z.string(),
  /** user:人在界面上;agent:经 MCP;external:只看到文件变了,不知道是谁。 */
  actor: z.enum(['user', 'agent', 'external']),
  summary: z.string(),
  document: RecordingDocument,
  target: z
    .object({
      kind: z.string(),
      index: z.number().int().nonnegative().optional(),
      id: z.string().optional(),
      label: z.string(),
    })
    .optional(),
  /** 这一步之后的版本号。 */
  revision: z.string(),
  /** agent 事件必需:触发它的 MCP 工具名,宿主靠它和自己的调用记录对上。 */
  tool: z.string().optional(),
  undoable: z.boolean().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** 被改的那一处在屏幕上的位置,改动显示到画布上那一刻量的。界面没开着、没量到就没有。 */
  uiTargets: UiTargetList.optional(),
})
export type RecordingEvent = z.infer<typeof RecordingEvent>

/** 撤销 / 重做一步的结果。成了就说是哪一页、那一处现在是什么字,界面拿它翻过去点亮。 */
const HistoryStep = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  slide: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  uiTargets: UiTargetList.optional(),
})

/** Live canvas evidence; selectors are scoped to the reported slide and revision. */
export const CanvasElement = z.object({
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  visible: z.boolean(),
  source: z.string().nullable(),
})
export type CanvasElement = z.infer<typeof CanvasElement>
export const CanvasError = z.object({
  kind: z.enum(['load', 'script', 'resource', 'promise']),
  message: z.string(),
  source: z.string().nullable(),
  stack: z.string().nullable(),
})
export type CanvasError = z.infer<typeof CanvasError>
export const CanvasEvidence = z.object({
  renderedRevision: z.string().nullable(),
  slide: z.number().int().nonnegative().nullable(),
  ready: z.boolean(),
  width: z.number().positive(),
  height: z.number().positive(),
  autoplay: z.boolean(),
  selection: CanvasElement.nullable(),
  elements: z.array(CanvasElement).max(500),
  elementsTruncated: z.boolean(),
  html: z.string().max(100000).nullable(),
  htmlLength: z.number().int().nonnegative(),
  htmlTruncated: z.boolean(),
  errors: z.array(CanvasError).max(50),
})
export type CanvasEvidence = z.infer<typeof CanvasEvidence>
const CanvasQuery = z.object({
  deckId: z.string(),
  include: z.enum(['context', 'elements', 'html', 'errors']).default('context'),
  expectedRevision: z.string().optional(),
})
const CanvasSelection = z.object({
  deckId: z.string(),
  // Null clears the selection. A selector never silently navigates to another page.
  selector: z.string().min(1).max(2000).nullable(),
  slide: z.number().int().nonnegative(),
  expectedRevision: z.string(),
})
const CanvasCommand = z.union([
  CanvasQuery.extend({ action: z.literal('inspect') }),
  CanvasSelection.extend({ action: z.literal('select') }),
])

export const requests = {
  'canvas.inspect': {
    params: CanvasQuery,
    result: CanvasEvidence.extend({
      deckId: z.string(),
      revision: z.string(),
      current: z.boolean(),
    }),
  },
  'canvas.select': {
    params: CanvasSelection,
    result: CanvasEvidence.extend({
      deckId: z.string(),
      revision: z.string(),
      current: z.boolean(),
    }),
  },
  /** Only the UI replies to an outstanding server→guest request. */
  'canvas.result': {
    params: z.object({
      requestId: z.string(),
      evidence: CanvasEvidence.optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  'skill.list': {
    params: z.object({
      path: z.string().default(''),
      offset: z.number().int().nonnegative().default(0),
    }),
    result: z.object({
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), directory: z.boolean() })),
      next: z.number().nullable(),
    }),
  },
  'skill.read': {
    params: z.object({
      path: z.string().default('SKILL.md'),
      offset: z.number().int().nonnegative().default(0),
    }),
    result: z.object({
      path: z.string(),
      text: z.string(),
      next: z.number().nullable(),
      total: z.number(),
    }),
  },
  'deck.current': {
    params: z.object({}),
    result: z.object({
      deckId: z.string().optional(),
      slide: z.number().int().nonnegative().optional(),
    }),
  },
  'deck.navigation': {
    params: z.object({
      deckId: z.string(),
      action: z.enum(['next', 'previous', 'replay', 'replayPage']),
      from: z.number().int().nonnegative().optional(),
    }),
    result: z.object({}),
  },
  'deck.visibleSlide': {
    params: z.object({ deckId: z.string(), index: z.number().int().nonnegative() }),
    result: z.object({}),
  },
  'deck.list': { params: z.object({}), result: z.object({ decks: z.array(DeckSummary) }) },
  'deck.open': {
    params: z.object({ path: z.string() }),
    result: z.object({
      deck: DeckSummary,
      slides: z.array(Slide),
      transitions: z.array(Transition),
      /**
       * 每次翻页一条,给时间轴用。来自 `.deck/plan.json`,没有就从稿子的 HTML 注释里
       * 解析 —— 不然打开任何一份现成稿子,时间轴都是空的。
       */
      transitionPlan: z.array(TransitionNote),
      /** 放映画布要加载的 loopback 地址。成品还没出来时为空。 */
      previewUrl: z.string(),
      /**
       * 这份稿子用的主题(文件名)。从它引的那行 `runtime/themes/<名字>.css` 认出来。
       * 空白起始文件没配主题时没有 —— 不猜一个。
       */
      theme: z.string().optional(),
      /**
       * 只读。稿子目录落在 skill 里(同款样稿、示例)就是只读的:改字、改页、换图、
       * 撤销重做服务端都会拒,界面也不给改。
       */
      readOnly: z.boolean().optional(),
      /**
       * 稿子里真实的页数。skill 做出来的 deck 没有 outline.json,slides 为空,
       * 翻页和页码要靠这个数 —— 它来自 HTML 本身,永远是准的。
       */
      slideCount: z.number().int().nonnegative(),
      /**
       * 每一页的标题,从稿子的 HTML 里读出来的。
       *
       * 和 `slides[].subject` 的区别:那个是 outline 阶段**定**下来的主角,是决定;
       * 这个只是从成品里认出来的标签,用来在没有 outline 时让页胶片说得出话。
       * 两者都有时以 outline 为准。
       */
      slideTitles: z.array(z.string().nullable()),
      /**
       * 每一页声明的页面类型(`<section data-page>`),没标的是 null。
       *
       * **不是给人选的菜单** —— 本产品的人不摆页面,他说话。它的用处是:界面显示
       * 这一页是什么(好让人发现它不对)、agent 能指代它、校验能按规范核它的坐标、
       * 转场规划能推理角色位置对不对得上。
       */
      pageTypes: z.array(z.string().nullable()),
      /**
       * 各阶段现在是什么状态。**从磁盘上的产物推出来** —— deck 是用户的目录,不是我们的
       * 私有状态,重开一次、换台机器、用别的工具改过,状态都得对。
       */
      phases: z.array(PhaseReport),
    }),
  },
  /**
   * 新建一份稿子。`from` 指一个模板或示例,不给就是个空目录。
   *
   * 模板和示例都来自 skill —— 它已经有一整套能直接放映的成稿,没道理让人从空白开始。
   */
  'deck.create': {
    params: z.object({
      /** 放在哪个目录下。不给就是 ~/Documents/Orca PPT(见 server 的 DEFAULT_DECKS_DIR)。 */
      parentDir: z.string().optional(),
      title: z.string(),
      /** 起始文件 `template:<文件名>`,或做同款时的 `recipe:<同款 id>`(复制同款样稿)。 */
      from: z.string().optional(),
      /** 空白模板配哪个主题。起始文件本身不带主题,不配的话新稿子没有样子。 */
      theme: z.string().optional(),
    }),
    result: z.object({ path: z.string() }),
  },
  /**
   * 新建时能从哪儿起头。**只有 skill 的空白起始文件**(汇报稿、故事稿)。
   *
   * 不列 `examples/`:那些是 skill 自己按**转场手法**命名的技术参考和回归用例,
   * 不是按场景组织的模板。skill 只向产品提供三样:主题样张、空白起始文件、规范。
   */
  'catalog.templates': {
    params: z.object({}),
    result: z.object({
      templates: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          /** 汇报稿还是故事稿。 */
          mode: z.string(),
        }),
      ),
    }),
  },
  /**
   * 同款:skill 里 `recipes/<id>/RECIPE.md` 的配方。首页就是同款画廊。
   * 案例(`examples/<id>/EXAMPLE.md`)也在这张列表里,`kind` 区分:只能打开看,不能做同款。
   *
   * 同款**不是起始文件**:界面不从它建稿,只给人看样片、复制 `prompt` 贴进自己的 agent ——
   * agent 读配方、照着做。所以这里没有「从同款新建」的方法,也不该有。
   */
  'catalog.recipes': {
    params: z.object({}),
    result: z.object({
      recipes: z.array(
        z.object({
          /**
           * recipe:同款,一个能换内容复刻的手法,有「做同款」。
           * example:案例,一整份完整的稿子,只给人看,没有「做同款」。
           */
          kind: z.enum(['recipe', 'example']),
          id: z.string(),
          title: z.string(),
          /** 汇报稿还是故事稿,原样取自配方。 */
          mode: z.string(),
          /** 一句话:什么场合用。 */
          summary: z.string().optional(),
          /**
           * 首页卡片封面的绝对路径:frontmatter 的 `poster` 指的那张图,跟着同款放在 skill 里。
           * 没写或文件不在就没有,卡片显示占位。
           */
          poster: z.string().optional(),
          /** 「做同款」的 agent 提示词,用户复制后贴进自己的 agent。案例没有。 */
          prompt: z.string().optional(),
        }),
      ),
    }),
  },
  /**
   * 打开一个同款的样稿看。首页点卡片走它,agent 说「打开这个同款给我看」也走它。
   *
   * 进的是普通工作台(页胶片、画布、转场时间轴都在),只是**只读**:样稿在 skill 里,
   * 发布版里那是 app 包内的文件。打开后和 `deck.open` 一样推 `deck.opened`,
   * `deck.open` 的结果里 `readOnly` 为真。
   */
  'recipe.present': {
    params: z.object({ id: z.string() }),
    /** 打开的样稿。agent 调的话,它接下来操作的就是这一份(见 MCP 的 present_recipe)。 */
    result: z.object({ deckId: z.string() }),
  },
  /**
   * 首页上指着某个同款给人看:打开它的「做同款」提示词(和点那个按钮一样)。`none` 收起。
   * 开着稿子的话先关掉回首页 —— 这只在首页上有。
   */
  'recipe.focus': {
    params: z.object({ id: z.string(), show: RecipeFocusShow }),
    result: z.object({}),
  },
  /** 关掉这份稿子,回首页。工具栏左上角的「首页」走它。 */
  'deck.close': {
    params: z.object({ deckId: z.string() }),
    result: z.object({}),
  },
  /** 跳到第几页。界面点页胶片走它,agent 说「你看第 4 页」也走它。 */
  'deck.showSlide': {
    params: z.object({ deckId: z.string(), index: z.number().int().nonnegative() }),
    result: z.object({}),
  },
  /**
   * 就地改一处文字。界面双击文字走它,agent 想精确换掉一句话也走它。
   *
   * **只换文字,一个标签一个属性都不动**。用 `oldText` 在那一页的源码里定位,不是
   * 靠选择器 —— 服务端没有 DOM,而 guest 里的 DOM 也不等于源文件(reveal 会克隆节点)。
   * 找不到或者有好几处一样的就拒绝,`reason` 给人话。不猜着改:静默毁掉一个
   * `data-carry` 会让转场哑掉,而且要等到放映才发现。
   */
  'deck.editPages': {
    params: z.object({
      deckId: z.string(),
      expectedRevision: z.string(),
      change: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('insert'),
          index: z.number().int().nonnegative(),
          title: z.string().trim().min(1).max(200),
        }),
        z.object({ action: z.literal('delete'), index: z.number().int().nonnegative() }),
        z.object({
          action: z.literal('move'),
          index: z.number().int().nonnegative(),
          to: z.number().int().nonnegative(),
        }),
      ]),
    }),
    result: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      revision: z.string().optional(),
      slide: z.number().int().nonnegative().optional(),
      uiTargets: UiTargetList.optional(),
    }),
  },
  'deck.replaceImage': {
    params: z.object({
      deckId: z.string(),
      expectedRevision: z.string(),
      slide: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2000),
      oldSource: z.string(),
      source: z.string().min(1).max(2000),
    }),
    result: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      revision: z.string().optional(),
      uiTargets: UiTargetList.optional(),
    }),
  },
  'deck.editText': {
    params: z.object({
      deckId: z.string(),
      slide: z.number().int().nonnegative(),
      oldText: z.string(),
      newText: z.string(),
    }),
    result: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      uiTargets: UiTargetList.optional(),
    }),
  },
  /**
   * 改转场计划注释里的一段字(注释在页面之外,editText 够不着)。和 editText 一样拿旧文字
   * 当锚,恰好出现一次才换,能撤销。只动注释,页面一个字节不碰。
   */
  'deck.editPlan': {
    params: z.object({ deckId: z.string(), oldText: z.string(), newText: z.string() }),
    result: z.object({
      ok: z.boolean(),
      reason: z.string().optional(),
      uiTargets: UiTargetList.optional(),
    }),
  },
  /**
   * 撤掉最近一次共享编辑(改字、页面编辑或换图,不管是 UI 还是 MCP)。
   *
   * 稿子还是那次改完的样子,就原样还回改之前;在那之后被别处改过(agent 直接写了
   * HTML、人在编辑器里动过),就退一步只把那段字换回去;连那段字都对不上了就拒绝,
   * 不猜。结构与换图要求关联文件仍完全匹配;直接写文件的改动不在这里面。
   */
  'deck.undo': {
    params: z.object({ deckId: z.string() }),
    result: HistoryStep,
  },
  /** 重做刚撤掉的那一步。又做过共享编辑之后就没有可重做的了。 */
  'deck.redo': {
    params: z.object({ deckId: z.string() }),
    result: HistoryStep,
  },
  /** 撤销 / 重做现在能不能点。打开稿子时问一次,之后跟着 `history.changed` 走。 */
  'deck.history': {
    params: z.object({ deckId: z.string() }),
    result: HistoryState,
  },
  /**
   * 诊断:这一侧的环境是什么样。agent 碰到 UI_DISCONNECTED、SKILL_NOT_FOUND 这类错误,
   * 或者工具行为不对时先看它 —— 比猜强。
   */
  'app.doctor': {
    params: z.object({}),
    result: z.object({
      app: z.object({ version: z.string() }),
      server: z.object({ port: z.number().int(), mcp: z.string() }),
      skill: z.object({
        path: z.string().optional(),
        /** explicit:ORCA_PPT_SKILL 指定的;bundled:app 自带的;local:开发时的本地仓;missing:没找到。 */
        source: z.enum(['explicit', 'bundled', 'local', 'missing']),
        searched: z.array(z.string()),
      }),
      /** 界面(窗口)连着没有。截图、缩略图、放映都要靠它。 */
      ui: z.object({ connected: z.boolean(), connections: z.number().int() }),
      decks: z.array(z.object({ id: z.string(), label: z.string() })),
      recording: z.object({ file: z.string(), events: z.number().int() }),
    }),
  },
  /** 某个游标之后发生的事件(可录制应用约定)。游标太旧、已经被清掉时 gap 为 true。 */
  'recording.events': {
    params: z.object({
      after: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    result: z.object({
      version: z.literal(1),
      events: z.array(RecordingEvent),
      cursor: z.string(),
      more: z.boolean(),
      gap: z.boolean(),
      revisionIsContentHash: z.boolean(),
    }),
  },
  /**
   * 一张缩略图(可录制应用约定)。**离屏渲**:不翻用户眼前的画布。只渲得了当前版本 ——
   * 要旧版本就 REVISION_UNAVAILABLE,宿主用当时记下的那张。
   */
  'recording.snapshot': {
    params: z.object({
      document: z.string().optional(),
      revision: z.string().optional(),
      maxSize: z.number().int().min(64).max(1280).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      /** 没办成时的原因,以错误码开头(REVISION_UNAVAILABLE: 等)。 */
      reason: z.string().optional(),
      /** base64。 */
      image: z.string().optional(),
      mimeType: z.enum(['image/png', 'image/jpeg']).optional(),
      document: RecordingDocument.optional(),
      revision: z.string().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      target: RecordingEvent.shape.target,
    }),
  },
  /** 稿子现在归谁动。连上时问一次,之后跟着 `control.changed` 走。 */
  'control.state': {
    params: z.object({}),
    result: Control,
  },
  /**
   * agent 明说拿起稿子,开始一段连续的活儿。人接管着的时候也能拿回来 —— 所以只该在人
   * 说了「继续」之后调(和 ego 一样,这条靠工具说明约束,不靠 server 拦)。
   */
  'control.take': {
    params: z.object({
      reason: z.string(),
      renew: z.boolean().optional(),
      /** 在等人批准什么。传了就设上,不传就清空 —— 批准完再调一次 take 不带它。 */
      waiting: z.string().optional(),
    }),
    result: Control,
  },
  /** agent 干完了,把稿子交还给人。可以留一句话:要人确认什么、接着做什么。 */
  'control.handOff': {
    params: z.object({ message: z.string().optional() }),
    result: Control,
  },
  /** 人接管。之后 agent 的工具一律拒绝,直到人交还或者 agent 在人同意后拿回。 */
  'control.takeOver': {
    params: z.object({}),
    result: Control,
  },
  /**
   * 人按了「停止」:这件事不做了,控制权回到人手上。之后 agent 的工具返回 USER_STOPPED ——
   * 和接管的 USER_IN_CONTROL 不同,宿主认出它就直接中断这一轮,不等模型自己停。
   */
  'control.stop': {
    params: z.object({}),
    result: Control,
  },
  /** 人交还控制权,或者看过 agent 留的话之后收起它。 */
  'control.release': {
    params: z.object({}),
    result: Control,
  },
  /** 某个阶段产物的绝对路径。界面拿它交给系统编辑器,agent 拿它去读写。 */
  'artifact.path': {
    params: z.object({ deckId: z.string(), phase: DeckPhase }),
    result: z.object({ path: z.string() }),
  },
  /**
   * 取某阶段的提示词。**上游产物不合规时直接拒绝** —— 闸门还在,只是从「我们推」
   * 变成「agent 拉」。
   */
  'phase.prompt': {
    params: z.object({ deckId: z.string(), phase: DeckPhase, request: z.string().optional() }),
    result: z.object({
      prompt: z.string().optional(),
      /** 被上游挡住了。issues 说清是哪一条。 */
      blockedBy: DeckPhase.optional(),
      issues: z.array(z.string()),
    }),
  },
  /** 跑一遍确定性校验,读磁盘上的产物。 */
  'phase.check': {
    params: z.object({ deckId: z.string(), phase: DeckPhase.optional() }),
    result: z.object({ phases: z.array(PhaseReport) }),
  },
  /**
   * 稿子此刻写的是什么:每一页**源文件里的原文**,和一个随内容变的版本号。
   *
   * 界面用不着它 —— 页胶片自己看得见。agent 看不见画布,改字前只能读这个;而且它要的
   * 是源文件里的原文,不是放映出来的样子(CSS 把 `Studio placeholder` 显示成大写,照着
   * 屏幕抄就对不上 `edit_text`)。版本号让宿主一眼看出一次调用到底动没动稿子。
   */
  'deck.inspect': {
    params: z.object({ deckId: z.string() }),
    result: z.object({
      revision: z.string(),
      slides: z.array(
        z.object({
          /** 从 0 数起,和其余工具的 `slide` 参数同一套。 */
          index: z.number().int().nonnegative(),
          title: z.string().nullable(),
          pageType: z.string().nullable(),
          /** 这一页里一段一段的文字,按源码顺序,实体已还原。 */
          texts: z.array(z.string()),
        }),
      ),
    }),
  },
  /**
   * 截一张画布的图。agent 靠它**自己看一眼**做出来的东西 —— 稿子好不好只有放映能回答,
   * 等人来描述等于让它闭着眼改。
   *
   * 界面(壳)才截得了图,所以 server 把请求推给它,壳截完回 `capture.result`。
   */
  'deck.capture': {
    params: z.object({
      deckId: z.string(),
      /** 不给就截当前这一页。 */
      slide: z.number().int().nonnegative().optional(),
      expectedRevision: z.string().optional(),
    }),
    result: z.object({
      path: z.string(),
      deckId: z.string().optional(),
      slide: z.number().int().nonnegative().optional(),
      renderedRevision: z.string().optional(),
    }),
  },
  /**
   * 全屏放映。稿子好不好只有放映能回答 —— 这是这个产品里最该有的一个动作。
   *
   * 走协议而不是界面自己开窗:agent 说「放给我看」也该能触发(那条不变量)。
   */
  'deck.present': {
    params: z.object({
      deckId: z.string(),
      /** 从第几页开始。不给就从第一页。 */
      slide: z.number().int().nonnegative().optional(),
    }),
    result: z.object({}),
  },
  /** 关掉放映窗口。agent 的 stop_present 走它。 */
  'deck.stopPresent': {
    params: z.object({ deckId: z.string() }),
    result: z.object({}),
  },
  /**
   * 自动播放:按每页自己声明的 `data-hold` 依次往后翻。
   *
   * 放在观看端而不是稿子里 —— 自动播放是看的人的选择,不是稿子的属性;同一份稿子在
   * 浏览器里打开仍然是手动翻页。
   */
  'deck.autoplay': {
    params: z.object({ deckId: z.string(), on: z.boolean() }),
    result: z.object({}),
  },
  /**
   * 给每一页出一张缩略图。没有图的「胶片」不叫胶片。
   *
   * 和 `deck.capture` 一样要绕到壳那边,但**不能驱动可见画布** —— 那样用户会看着它
   * 把每一页翻一遍。壳用一个隐藏窗口离屏渲。
   */
  'deck.thumbnails': {
    params: z.object({ deckId: z.string() }),
    result: z.object({ paths: z.array(z.string().nullable()) }),
  },
  /** 壳把缩略图交回来。只有壳会调。 */
  'thumbnails.result': {
    params: z.object({
      requestId: z.string(),
      paths: z.array(z.string().nullable()).optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  /**
   * 导出 PPTX。网页稿是作品本身,PPTX 是功能不完整的导出选项:每次翻页按 skill 的
   * 「导出 PPTX」表回退,结果里说清哪几次翻页降级了、哪些效果导不出来、要装哪些字体。
   *
   * 要逐页渲染,只有壳做得到:server 推 `pptx.request`,壳导好回 `pptx.result`,
   * server 再把文件放到 `path`。
   */
  'deck.exportPptx': {
    params: z.object({
      deckId: z.string(),
      /** 存到哪。绝对路径,以 .pptx 结尾,所在目录要已经存在;同名文件会被覆盖。 */
      path: z.string(),
    }),
    result: z.object({
      path: z.string(),
      slides: z.number().int().nonnegative(),
      degraded: z.array(PptxDegraded),
      lost: z.array(z.object({ slide: z.number().int().positive(), items: z.array(z.string()) })),
      /** 转成图片的元素一共几个。 */
      rasters: z.number().int().nonnegative(),
      fonts: z.array(z.string()),
    }),
  },
  /** 壳把 PPTX 导好了(或者导失败了)。只有壳会调。 */
  'pptx.result': {
    params: z.object({
      requestId: z.string(),
      report: PptxExportReport.optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  /** 壳把截好的图交回来。只有壳会调。 */
  /** 界面上几处东西此刻在屏幕上的哪儿(`studio.orca/ui-targets` v1)。只读。 */
  'ui.resolveTargets': {
    params: z.object({ queries: z.array(UiTargetQuery).min(1).max(UI_TARGETS_MAX_BATCH) }),
    result: UiTargets,
  },
  /** 界面把定位结果交回来。只有界面会调。 */
  'ui.targetsResult': {
    params: z.object({
      requestId: z.string(),
      targets: UiTargets.optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  /** 画布跟上了 agent 的一处改动(翻过去、点亮了),交回那一处的位置。只有界面会调。 */
  'edit.followed': {
    params: z.object({
      requestId: z.string(),
      targets: UiTargets.optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  /** 演示模式开没开。连上时问一次,之后跟着 `demo.changed` 走。 */
  'demo.state': { params: z.object({}), result: Demo },
  /** 开关演示模式。菜单「放映 › 演示模式」和 MCP 的 set_demo_mode 都走它。 */
  'demo.set': {
    params: z.object({
      on: z.boolean(),
      intervalMs: Demo.shape.intervalMs.optional(),
    }),
    result: Demo,
  },
  'capture.result': {
    params: z.object({
      requestId: z.string(),
      slide: z.number().int().nonnegative().optional(),
      renderedRevision: z.string().optional(),
      path: z.string().optional(),
      error: z.string().optional(),
    }),
    result: z.object({}),
  },
  /** 主题和版式是**选**出来的,不是聊出来的。目录来自 skill。 */
  'catalog.list': {
    params: z.object({}),
    result: z.object({
      themes: z.array(
        z.object({
          name: z.string(),
          title: z.string(),
          /** 一句话:适合什么场合、什么调子。**不是标签**,不参与分区和筛选。 */
          summary: z.string().optional(),
          /**
           * 标签。**从 skill 的 `runtime/tags.json` 里挑,不能自由决定** ——
           * 那份词表取自 Keynote 的主题侧边栏。不在词表里的会被丢掉并记进 unknownTags。
           */
          tags: z.array(z.string()),
          /** 样张的绝对路径。每个主题一张,内容完全一样,只有设计不同。 */
          sample: z.string().optional(),
          /**
           * 这个主题默认配哪套配色。
           *
           * **主题文件里已经没有颜色了** —— 颜色在 `runtime/palettes/<配色>.css`,
           * 主题只管字体/字阶/圆角/新增类。所以新建稿子时服务端必须按这个把配色一起链上,
           * 不然建出来的稿子是没有颜色的。界面上暂时不给选配色。
           */
          palette: z.string().optional(),
        }),
      ),
      /**
       * 最近用过的主题(文件名),最近的在前。**不是标签** —— 它不写在任何文件里,
       * 是系统从使用记录算出来的一个视图,今天有明天就没了。塞进 tags 就等于说它是
       * 这个主题的属性。
       */
      recent: z.array(z.string()),
      /** 词表本身。界面显示 label,文件里写的是 id。 */
      tags: z.array(z.object({ id: z.string(), label: z.string(), icon: z.string().optional() })),
      /** 页面类型词表。同样 id 进文件、label 上界面。 */
      pages: z.array(z.object({ id: z.string(), label: z.string() })),
      /**
       * 标签有毛病的条目,一条一句人话:拼错的、以及**一个标签都没挂的**。
       * 上新一份模板必须挑一个标签 —— 词表靠这份报告执行,不靠文档。
       */
      tagIssues: z.array(z.string()),
      layouts: z.array(z.string()),
      skillPath: z.string().optional(),
    }),
  },
  /** 挂一件待办。界面取一处锚、点一个阶段的「跑」,都走它。 */
  'requests.add': {
    params: z.union([
      z.object({ deckId: z.string(), kind: z.literal('anchor'), anchor: Anchor }),
      z.object({ deckId: z.string(), kind: z.literal('phase'), phase: DeckPhase }),
    ]),
    result: z.object({ id: z.string() }),
  },
  'requests.list': {
    params: z.object({ deckId: z.string() }),
    result: z.object({ requests: z.array(PendingRequest) }),
  },
  /** agent 取走待办,队列清空。界面上「等 agent 来取」的提示随之消失。 */
  'requests.take': {
    params: z.object({ deckId: z.string() }),
    result: z.object({ requests: z.array(PendingRequest) }),
  },
  'requests.remove': {
    params: z.object({ deckId: z.string(), id: z.string() }),
    result: z.object({}),
  },
} as const

export type RequestMethod = keyof typeof requests
export const requestMethods = Object.keys(requests) as RequestMethod[]

export type RequestParams<M extends RequestMethod> = z.infer<(typeof requests)[M]['params']>
export type RequestResult<M extends RequestMethod> = z.infer<(typeof requests)[M]['result']>

export const RequestEnvelope = z.object({
  id: z.string(),
  method: z.enum(requestMethods as [RequestMethod, ...RequestMethod[]]),
  params: z.unknown(),
})
export type RequestEnvelope = z.infer<typeof RequestEnvelope>

export const ResponseEnvelope = z.union([
  z.object({ id: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ message: z.string() }) }),
])
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>

export const pushes = {
  'canvas.request': CanvasCommand.and(z.object({ requestId: z.string() })),
  'deck.navigation': z.object({
    deckId: z.string(),
    action: z.enum(['next', 'previous', 'replay', 'replayPage']),
    from: z.number().int().nonnegative().optional(),
  }),
  /** deck 文件变了,画布该热更新了。previewUrl 变了也走这条(成品第一次出现时)。 */
  /**
   * 有人开了一份稿子 —— 可能是 agent。**界面要跟着开**:agent 是代替人执行的,
   * 它开了稿子而人的窗口还停在原地,后面一切都对不上(画布没加载,截图就超时)。
   *
   * 只带路径,不带整份数据:界面收到后走自己那套完整的打开流程(缩略图、待办队列
   * 都要跟着),把打开这件事复制一份到推送里迟早会漏东西。
   */
  'deck.opened': z.object({ deckId: z.string(), path: z.string() }),
  'deck.changed': z.object({
    deckId: z.string(),
    slides: z.array(Slide),
    slideCount: z.number().int().nonnegative(),
    slideTitles: z.array(z.string().nullable()),
    pageTypes: z.array(z.string().nullable()),
    previewUrl: z.string(),
    /** 磁盘上现在的版本号。画布已经就地换成这一版(见 `deck.patched`)就不用重载。 */
    revision: z.string().optional(),
  }),
  /**
   * 稿子刚被改了一小处,画布可以不重载、就地换掉:画布停在 `before` 那一版时,把 `text`
   * 那段字换掉,当作已经是 `revision`。没有 `text` 的是页面之外的改动(转场计划注释),
   * 画面上什么都不用动。换不了(版本对不上、那段字认不准)就什么也不做,等 `deck.changed` 重载。
   *
   * 为什么要它:改一个字就整份重载,画面白一下、左栏跟着重渲,录屏里一闪一闪的。
   */
  'deck.patched': z.object({
    deckId: z.string(),
    before: z.string(),
    revision: z.string(),
    text: z
      .object({
        slide: z.number().int().nonnegative(),
        oldText: z.string(),
        newText: z.string(),
      })
      .optional(),
  }),
  'transition.changed': z.object({
    deckId: z.string(),
    transitions: z.array(Transition),
    plan: z.array(TransitionNote),
  }),
  /** 阶段状态变了。产物本身用 artifact.path 去读,这里只报状态。 */
  'phase.changed': z.object({
    deckId: z.string(),
    phase: DeckPhase,
    status: PhaseStatus,
    issues: z.array(z.string()).default([]),
  }),
  /** 待办队列变了。界面据此显示「已取 N 处,去跟 agent 说一声」。 */
  'requests.changed': z.object({ deckId: z.string(), requests: z.array(PendingRequest) }),
  /** 请界面量几处东西的屏幕位置。量完调 `ui.targetsResult` 交回来。 */
  'ui.targets.request': z.object({
    requestId: z.string(),
    queries: z.array(UiTargetQuery),
  }),
  /**
   * agent 刚改了一处:画布翻到那一页,等新版本加载好,把那一处点亮,量出位置后调
   * `edit.followed`。`slide` 没有时(比如转场计划注释)不翻页;`text`、`selector` 都没有时
   * 指整张画布。`holdMs` 是点亮留多久 —— 演示模式下和停顿一样长。
   */
  'edit.follow': z.object({
    requestId: z.string(),
    deckId: z.string(),
    revision: z.string(),
    slide: z.number().int().nonnegative().optional(),
    text: z.string().optional(),
    selector: z.string().optional(),
    holdMs: z.number().int().nonnegative(),
  }),
  /** 演示模式开关变了。 */
  'demo.changed': Demo,
  /** 请壳截一张画布的图。壳截完调 `capture.result` 交回来。 */
  'capture.request': z.object({
    deckId: z.string(),
    requestId: z.string(),
    expectedRevision: z.string().optional(),
    slide: z.number().int().nonnegative().optional(),
  }),
  /** 自动播放开关变了。画布和放映窗口都跟着。 */
  'autoplay.changed': z.object({ deckId: z.string(), on: z.boolean() }),
  /** 撤销 / 重做的状态变了 —— 改了字、撤了、重做了,不管是谁做的。 */
  'history.changed': HistoryState.extend({ deckId: z.string() }),
  /** 稿子换了人拿。界面据此切换只读、显示接管 / 交还。 */
  'control.changed': Control,
  /** 稿子关了(回首页)。界面据此回到同款画廊。 */
  'deck.closed': z.object({ deckId: z.string() }),
  /** 请壳开一个全屏窗口放映。只有壳做得到。 */
  'present.request': z.object({
    deckId: z.string(),
    previewUrl: z.string(),
    slide: z.number().int().nonnegative(),
  }),
  /** 关掉放映窗口。 */
  'present.stop': z.object({ deckId: z.string() }),
  /** 首页上指着某个同款:打开「做同款」提示词 / 收起。见 `recipe.focus` 方法。 */
  'recipe.focus': z.object({ id: z.string(), show: RecipeFocusShow }),
  /**
   * agent 通过 MCP 动了一下。**agent 代替人执行,那它做的事就该和人做的一样看得见** ——
   * 否则画布自己翻页、文字自己变了,人只能干看着猜。
   *
   * 每次工具调用推两条:`start` 在工具跑**之前**,`done` 在之后。读也要先announce ——
   * `capture_slide` 会把画布跳到另一页,不先说一声的话人是懵的。
   */
  'mcp.activity': z.object({
    /** 一次调用的 id,start 和 done 靠它配对。 */
    id: z.string(),
    tool: z.string(),
    /** 动没动磁盘上的稿子。写过的地方高亮要留得久一点,让人看清改了哪儿。 */
    kind: z.enum(['read', 'write']),
    phase: z.enum(['start', 'done']),
    /** 人话,直接显示:「让你看第 4 页」「改第 3 页的文字」。 */
    label: z.string(),
    /** 涉及哪几页。空数组表示说不准是哪一页(比如截当前这页)。 */
    slides: z.array(z.number().int().nonnegative()),
    at: z.number(),
    /**
     * 定位用的线索:刚写进去的那段文字。界面拿它在画布上把那一处点亮 ——
     * 页胶片只说得出「哪一页」,一页上有十几个元素。
     */
    hint: z.string().optional(),
    /** 只在 `done` 上出现。工具自己拒绝(比如改不了那段文字)也算。 */
    error: z.string().optional(),
  }),
  /** 请壳离屏渲一份缩略图。壳渲完调 `thumbnails.result` 交回来。 */
  'thumbnails.request': z.object({
    deckId: z.string(),
    requestId: z.string(),
    previewUrl: z.string(),
    slideCount: z.number().int().nonnegative(),
    /** 只渲这几页(录制要的缩略图只要被改的那一页)。不给就是全部。 */
    slides: z.array(z.number().int().nonnegative()).optional(),
    /** 输出宽度。不给就是页胶片用的 320。 */
    width: z.number().int().positive().optional(),
    /** 写到哪个目录(缩略图缓存里的一格)。不给就由壳自己找个临时目录。 */
    outDir: z.string().optional(),
  }),
  /** 请壳把一份稿子导成 PPTX,写到 `outPath`(应用数据目录里的临时文件)。 */
  'pptx.request': z.object({
    deckId: z.string(),
    requestId: z.string(),
    previewUrl: z.string(),
    outPath: z.string(),
  }),
  /** 有人要求跳页 —— 可能是 agent。画布跟着走。 */
  'deck.slide': z.object({ deckId: z.string(), index: z.number().int().nonnegative() }),
} as const

export type PushChannel = keyof typeof pushes
export const pushChannels = Object.keys(pushes) as PushChannel[]
export type PushData<C extends PushChannel> = z.infer<(typeof pushes)[C]>

/**
 * push 信封带每连接单调递增的 sequence,客户端据此发现丢帧并重同步。
 */
export const PushEnvelope = z.object({
  channel: z.enum(pushChannels as [PushChannel, ...PushChannel[]]),
  sequence: z.number().int().nonnegative(),
  data: z.unknown(),
})
export type PushEnvelope = z.infer<typeof PushEnvelope>

export function parseParams<M extends RequestMethod>(method: M, raw: unknown): RequestParams<M> {
  return requests[method].params.parse(raw) as RequestParams<M>
}

export function parsePush<C extends PushChannel>(channel: C, raw: unknown): PushData<C> {
  return pushes[channel].parse(raw) as PushData<C>
}
