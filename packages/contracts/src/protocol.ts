import { z } from 'zod'
import { Anchor, DeckPhase, DeckSummary, Slide, Transition, TransitionNote } from './domain.js'

/**
 * 线上协议。两个方向、每个载荷都在边界上校验 —— 这个包是唯一真相,改协议就是改这里,
 * server、界面和 MCP server 各自跟着 typecheck 报错,这是有意的。
 *
 * **不变量:界面能做的每一件事都是这里的一个方法。** MCP 是这个协议的第二个薄客户端;
 * 界面里有、这里没有的操作,不许存在(见 docs/ARCHITECTURE.md)。
 */

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
 * 改字的撤销 / 重做走到哪了。`undo` / `redo` 是下一步会撤掉 / 重做的那一处,
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
  /** agent 在做的事,或者它拿着的理由。人话,直接显示。 */
  label: z.string().optional(),
  /** agent 交还时留给人的话:「第 3 页的数字请你确认一下」。人看过之后清掉。 */
  message: z.string().optional(),
})
export type Control = z.infer<typeof Control>

/** 撤销 / 重做一步的结果。成了就说是哪一页、那一处现在是什么字,界面拿它翻过去点亮。 */
const HistoryStep = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  slide: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
})

export const requests = {
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
      parentDir: z.string(),
      title: z.string(),
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
  'deck.editText': {
    params: z.object({
      deckId: z.string(),
      slide: z.number().int().nonnegative(),
      oldText: z.string(),
      newText: z.string(),
    }),
    result: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  },
  /**
   * 撤掉最近一次改字(`deck.editText` 做的,不管是人双击改的还是 agent 改的)。
   *
   * 稿子还是那次改完的样子,就原样还回改之前;在那之后被别处改过(agent 直接写了
   * HTML、人在编辑器里动过),就退一步只把那段字换回去;连那段字都对不上了就拒绝,
   * 不猜 —— 和 `deck.editText` 同一个规矩。只管改字:直接写文件的改动不在这里面。
   */
  'deck.undo': {
    params: z.object({ deckId: z.string() }),
    result: HistoryStep,
  },
  /** 重做刚撤掉的那一步。又改过字之后就没有可重做的了。 */
  'deck.redo': {
    params: z.object({ deckId: z.string() }),
    result: HistoryStep,
  },
  /** 撤销 / 重做现在能不能点。打开稿子时问一次,之后跟着 `history.changed` 走。 */
  'deck.history': {
    params: z.object({ deckId: z.string() }),
    result: HistoryState,
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
    params: z.object({ reason: z.string() }),
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
    }),
    result: z.object({ path: z.string() }),
  },
  /**
   * 全屏放映。稿子好不好只有放映能回答 —— 这是这个产品里最该有的一个动作。
   *
   * 走协议而不是界面自己开窗:agent 说「放给我看」也该能触发(那条不变量)。
   */
  'deck.present': {
    params: z.object({
      deckId: z.string(),
      /** 从第几页开始。不给就从当前这一页。 */
      slide: z.number().int().nonnegative().optional(),
    }),
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
  /** 壳把截好的图交回来。只有壳会调。 */
  'capture.result': {
    params: z.object({
      requestId: z.string(),
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
  /** 请壳截一张画布的图。壳截完调 `capture.result` 交回来。 */
  'capture.request': z.object({
    deckId: z.string(),
    requestId: z.string(),
    slide: z.number().int().nonnegative().optional(),
  }),
  /** 自动播放开关变了。画布和放映窗口都跟着。 */
  'autoplay.changed': z.object({ deckId: z.string(), on: z.boolean() }),
  /** 撤销 / 重做的状态变了 —— 改了字、撤了、重做了,不管是谁做的。 */
  'history.changed': HistoryState.extend({ deckId: z.string() }),
  /** 稿子换了人拿。界面据此切换只读、显示接管 / 交还。 */
  'control.changed': Control,
  /** 请壳开一个全屏窗口放映。只有壳做得到。 */
  'present.request': z.object({
    deckId: z.string(),
    previewUrl: z.string(),
    slide: z.number().int().nonnegative(),
  }),
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
