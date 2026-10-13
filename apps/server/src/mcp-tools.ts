import type {
  DeckPhase,
  PendingRequest,
  RequestMethod,
  RequestParams,
  RequestResult,
} from '@orca-ppt/contracts'
import { HOME_VISUAL_ACTIONS, phaseOrder } from '@orca-ppt/contracts'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AgentError, hasAgentCode } from './agent-errors.js'

/**
 * MCP 工具直接调 server 自己的协议方法 —— 它就住在 server 进程里,没有中间的连接。
 * 这也是那条不变量的落实:工具能做的就是界面能做的,同一批方法。
 */
export type ProtocolCaller = <M extends RequestMethod>(
  method: M,
  params: RequestParams<M>,
) => Promise<RequestResult<M>>

/**
 * MCP 工具。分两类,分界线是**要不要 agent 干活**:
 *
 * - 看与控:直接调、立刻生效,对应界面上的一个动作(反过来也成立)。
 * - 要 agent 干活的:人在界面上挂进待办队列,agent 用 take_requests 取走。
 */

/**
 * 当前这份 deck。工具签名里不带 deckId —— 人面前就开着一份,让模型猜路径只会猜错。
 *
 * 没显式 open_deck 过的话,回退到**应用里正开着的**那一份:正常情况下人早就把 deck
 * 打开了,再逼 agent 开一次纯属多余,而且它多半会猜错路径。
 */
export class ActiveDeck {
  #id: string | undefined

  set(id: string): void {
    this.#id = id
  }

  /** 稿子关了:下次按应用里正开着的那一份重新认。 */
  clear(): void {
    this.#id = undefined
  }

  async get(call: ProtocolCaller): Promise<string> {
    const current = await call('deck.current', {})
    if (this.#id) {
      if (current.deckId && current.deckId !== this.#id)
        throw new Error('DOCUMENT_CHANGED: 用户已切换稿子，请确认目标并用 open_deck 重新选择。')
      return this.#id
    }
    if (current.deckId) {
      this.#id = current.deckId
      return this.#id
    }

    const { decks } = await call('deck.list', {})
    if (decks.length === 1 && decks[0]) {
      this.#id = decks[0].id
      return this.#id
    }
    if (decks.length === 0) throw new Error(AgentError.noDeckOpen())
    throw new Error(AgentError.multipleDecks(decks.map((d) => d.path)))
  }
}

const Phase = z.enum(phaseOrder as [DeckPhase, ...DeckPhase[]])

/**
 * `isError` 是 MCP 自己的字段:工具跑到了,但这件事没办成。
 *
 * 用它而不是 throw:理由要原样交到 agent 手里(「这一页里有好几处一样的文字」比
 * 一个异常有用得多),同时界面也认得出这次没办成 —— 报成功是不诚实的。
 */
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type Text = { content: Content[]; isError?: boolean }
const text = (value: string): Text => ({ content: [{ type: 'text', text: value }] })
const refuse = (value: string): Text => ({
  content: [{ type: 'text', text: value }],
  isError: true,
})
const json = (value: unknown): Text => text(JSON.stringify(value, null, 2))
/** 拒绝理由前面加「没改:」之类;已经带错误码前缀的原样给 —— 前缀得在开头,宿主才认得出。 */
const tag = (prefix: string, reason: string | undefined): string =>
  reason && hasAgentCode(reason) ? reason : `${prefix}${reason ?? ''}`

/**
 * 这次调用在界面上该显示成什么。**agent 是代替人执行的,那它做的事就该和人做的一样
 * 看得见** —— 画布自己翻页、文字自己变了,人不该只能干看着猜。
 *
 * `slides` 空数组表示说不准是哪一页(比如截"当前这页",页号在画布那边)。
 */
export interface ToolActivity {
  /** 动没动磁盘上的稿子。写过的地方高亮留得久一点,让人看清改了哪儿。 */
  kind: 'read' | 'write'
  label: string
  slides: number[]
  /** 刚写进去的那段文字。界面拿它在画布上把那一处点亮。 */
  hint?: string
}

/**
 * MCP 自己的工具标注。宿主(比如 Jevbot)拿它决定一次调用要不要先问人,所以要说实话:
 *
 * - `readOnlyHint`:不动磁盘上的任何东西。翻页、放映、截图也算 —— 它们只动画布。
 * - `destructiveHint`:会不会丢东西。改字不算:原文就在参数里,反着调一次就回去了。
 * - `openWorldHint`:全是 false,这些工具只碰本机的这份稿子。
 */
export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint: boolean
}

const looking: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }

export interface ToolSpec {
  name: string
  config: {
    title: string
    _meta?: Record<string, unknown>
    description: string
    inputSchema?: z.ZodRawShape
    annotations: ToolAnnotations
  }
  run: (args: Record<string, unknown>) => Promise<Text>
  /** 不给就按「读、说不准哪一页、拿标题当说明」处理。 */
  activity?: (args: Record<string, unknown>) => ToolActivity
}

/** 参数里的页号。拿不到就返回空数组 —— 宁可不高亮,也别高亮错的那页。 */
function slideArg(args: Record<string, unknown>, key = 'slide'): number[] {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? [value] : []
}

const nth = (slides: number[]) =>
  slides[0] === undefined ? '当前这一页' : `第 ${slides[0] + 1} 页`

/** 翻页后等画布换页的时间。Reveal 一开始转场就换了当前页,不用等转场放完。 */
const NAV_SETTLE_MS = 250

export function buildTools(call: ProtocolCaller, active: ActiveDeck): ToolSpec[] {
  const canvasReads: ToolSpec[] = [
    [
      'get_canvas_context',
      '读取当前画布和选区',
      'context',
      '当前画布的页号、内容版本、已渲染版本、加载和播放状态、实时选区。读取不消费用户意见。current 为 false 时不能把它当成最新画面。',
    ],
    [
      'get_canvas_elements',
      '列出当前页元素',
      'elements',
      '当前页元素的页内选择器、文字、设计坐标几何、可见性和资源地址。最多 500 个，elementsTruncated 表示截断。选择器必须与页号和版本一起使用。',
    ],
    [
      'get_canvas_html',
      '读取当前页运行时 HTML',
      'html',
      '当前页运行时 DOM，不含应用界面和检视覆盖层。最多 100000 字符，htmlTruncated 表示截断；不含 Canvas/WebGL 像素。',
    ],
    [
      'get_canvas_errors',
      '读取当前画布错误',
      'errors',
      '当前加载中的画布错误：加载失败、脚本错误、资源失败和未处理 Promise。空列表仅表示未捕获到错误。',
    ],
  ].map(([name, title, include, description]) => ({
    name: name!,
    config: {
      title: title!,
      description: description!,
      annotations: looking,
      inputSchema: {
        expected_revision: z
          .string()
          .optional()
          .describe('要求画布显示这一版本，未加载时最多等待 10 秒；内容已变化则拒绝。'),
      },
    },
    run: async (args) =>
      json(
        await call('canvas.inspect', {
          deckId: await active.get(call),
          include: include as 'context' | 'elements' | 'html' | 'errors',
          ...(typeof args.expected_revision === 'string'
            ? { expectedRevision: args.expected_revision }
            : {}),
        }),
      ),
  }))
  return [
    ...canvasReads,
    {
      name: 'select_canvas_element',
      config: {
        title: '选择或取消选择画布元素',
        annotations: looking,
        description:
          '在用户当前页选择并持续高亮一个元素。selector 为 null 时取消选择。使用 get_canvas_elements 的页内选择器、slide 和 revision；目标版本或页已变时拒绝，不改稿子，不消费意见队列。',
        inputSchema: {
          selector: z.string().min(1).max(2000).nullable(),
          slide: z.number().int().nonnegative(),
          expected_revision: z.string(),
        },
      },
      run: async (args) =>
        json(
          await call('canvas.select', {
            deckId: await active.get(call),
            selector: args.selector as string | null,
            slide: Number(args.slide),
            expectedRevision: String(args.expected_revision),
          }),
        ),
    },
    {
      name: 'list_skill',
      config: {
        title: '列出随附规范资料',
        description: '浏览本版本 Orca PPT 随附 Skill 的相对目录，分页返回；无需打开稿子。',
        annotations: looking,
        inputSchema: {
          path: z.string().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      run: async (args) =>
        json(
          await call('skill.list', {
            path: typeof args.path === 'string' ? args.path : '',
            offset: typeof args.offset === 'number' ? args.offset : 0,
          }),
        ),
    },
    {
      name: 'read_skill',
      config: {
        title: '读取随附规范',
        description:
          '默认读取 SKILL.md。引用资料用相对路径读取；next 非空时以其作为 offset 继续。不需要宿主文件权限。仅文本，单文件最多 2 MB。',
        annotations: looking,
        inputSchema: {
          path: z.string().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      run: async (args) =>
        json(
          await call('skill.read', {
            path: typeof args.path === 'string' ? args.path : 'SKILL.md',
            offset: typeof args.offset === 'number' ? args.offset : 0,
          }),
        ),
    },
    {
      name: 'list_templates',
      config: {
        title: '查看起始模板',
        description: '列出 UI 新建稿子使用的相同模板，id 可传给 create_deck 的 from。',
        annotations: looking,
      },
      run: async () => json(await call('catalog.templates', {})),
    },
    {
      name: 'list_recipes',
      config: {
        title: '查看同款',
        description:
          '列出首页展示的同款配方（参考作品的内容结构 + 动效原则），含每个同款的「做同款」提示词。配方正文用 read_skill 读 recipes/<id>/RECIPE.md。',
        annotations: looking,
      },
      run: async () => json(await call('catalog.recipes', {})),
    },
    {
      name: 'present_recipe',
      activity: () => ({ kind: 'read', label: '放映同款样稿', slides: [] }),
      config: {
        title: '放映同款样稿',
        annotations: looking,
        description:
          '在应用的工作台里打开某个同款的样稿（只读），和首页点卡片一样。id 来自 list_recipes。看完用 close_deck 回首页。',
        inputSchema: { id: z.string().describe('list_recipes 返回的同款 id') },
      },
      run: async (args) => {
        const presented = await call('recipe.present', { id: String(args.id) })
        // 样稿是 agent 自己打开的,不是用户切走了:接下来的 present / close_deck 就对这一份。
        // 不同步的话,下一个工具就报 DOCUMENT_CHANGED,而恢复要走一次需要批准的 open_deck。
        active.set(presented.deckId)
        return json(presented)
      },
    },
    {
      name: 'preview_recipe',
      activity: (args) => ({
        kind: 'read',
        label: args.on === false ? '停掉同款样片' : '播放同款样片',
        slides: [],
      }),
      config: {
        title: '播放同款样片',
        annotations: looking,
        // 光标指那张卡的样片:visual_target 认这个 action,返回卡片的位置
        _meta: { 'dev.jevbot/ui': { version: 1, visual: true } },
        description:
          '在首页播某个同款卡片上的样片，和鼠标停在卡片上一样。给用户介绍同款、挑同款时用。开着稿子的话应用会先关掉它回首页。on=false 停下。id 来自 list_recipes。',
        inputSchema: {
          id: z.string().describe('list_recipes 返回的同款 id'),
          on: z.boolean().optional().describe('不给就是播;false 停下').meta({ title: '播放' }),
        },
      },
      run: async (args) => {
        const on = args.on !== false
        await call('recipe.focus', { id: String(args.id), show: on ? 'preview' : 'none' })
        // 开着的稿子被关了(首页才有样片),接下来要操作稿子得重新打开
        if (on) active.clear()
        return text(on ? '首页上这张同款卡片在播样片了。' : '样片停了。')
      },
    },
    {
      name: 'show_recipe_prompt',
      activity: (args) => ({
        kind: 'read',
        label: args.open === false ? '收起做同款提示词' : '打开做同款提示词',
        slides: [],
      }),
      config: {
        title: '打开做同款提示词',
        annotations: looking,
        // 光标指那张卡上的「做同款」按钮
        _meta: { 'dev.jevbot/ui': { version: 1, visual: true } },
        description:
          '在首页打开某个同款的「做同款」弹窗，用户能看到并复制那段提示词，和点卡片上的「做同款」一样。开着稿子的话应用会先关掉它回首页。open=false 收起。提示词正文 list_recipes 里也有。',
        inputSchema: {
          id: z.string().describe('list_recipes 返回的同款 id'),
          open: z.boolean().optional().describe('不给就是打开;false 收起').meta({ title: '打开' }),
        },
      },
      run: async (args) => {
        const open = args.open !== false
        await call('recipe.focus', { id: String(args.id), show: open ? 'prompt' : 'none' })
        if (open) active.clear()
        return text(open ? '首页上这个同款的「做同款」弹窗打开了。' : '弹窗收起了。')
      },
    },
    {
      name: 'close_deck',
      activity: () => ({ kind: 'read', label: '回首页', slides: [] }),
      config: {
        title: '关掉稿子回首页',
        description: '关掉当前稿子，应用回到同款首页。和工具栏左上角的「首页」一样。',
        annotations: looking,
      },
      run: async () => {
        await call('deck.close', { deckId: await active.get(call) })
        active.clear()
        return text('稿子已关上,应用回到了首页(同款画廊)。放映窗口如果开着也一并关了。')
      },
    },
    {
      name: 'navigate',
      config: {
        title: '翻页、重放转场或页内动画',
        // 翻页时宿主也画光标:visual_target 算出要翻到哪页,指向左栏那页的缩略图
        _meta: { 'dev.jevbot/ui': { version: 1, visual: true } },
        description:
          '与键盘翻页和 UI 重放共用操作。next 在有点击分步的页上先放下一步，放完才翻页。replay 重放从 from 页翻到下一页的转场；replayPage 把 from 页的页内动画从头放一遍。两者都必须带 from，页号从 0 数起。',
        annotations: looking,
        inputSchema: {
          action: z.enum(['next', 'previous', 'replay', 'replayPage']),
          from: z.number().int().nonnegative().optional(),
        },
      },
      run: async (args) => {
        const deckId = await active.get(call)
        await call('deck.navigation', {
          deckId,
          action: args.action as 'next' | 'previous' | 'replay' | 'replayPage',
          ...(typeof args.from === 'number' ? { from: args.from } : {}),
        })
        // 翻页是发给画布去做的。等它一拍,再从画布读回现在停在哪页 —— 不然 agent 还得
        // 自己再调一次工具才知道,而 deck_status 里没有实时页号。
        await new Promise((done) => setTimeout(done, NAV_SETTLE_MS))
        const live = await call('canvas.inspect', { deckId, include: 'context' }).catch(
          () => undefined,
        )
        const slide = live?.slide
        return typeof slide === 'number'
          ? text(
              `工作台画布现在停在第 ${slide + 1} 页(slide=${slide})。navigate 翻的是工作台画布,不是放映窗口。`,
            )
          : text('已请求画布执行；画布还没报回页号，要确认就调 get_canvas_context。')
      },
    },
    {
      name: 'open_deck',
      activity: () => ({ kind: 'read', label: '打开稿子', slides: [] }),
      config: {
        title: '打开稿子',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '打开一个 deck 目录并在界面上放映它。认 deck.html 和 index.html;成品还没做出来的目录也能打开。返回页数、各阶段状态和放映地址。',
        inputSchema: {
          path: z.string().describe('deck 目录的绝对路径').meta({ title: '稿子位置' }),
        },
      },
      run: async (args) => {
        const opened = await call('deck.open', { path: String(args.path) })
        active.set(opened.deck.id)
        return json({
          deck: opened.deck,
          slideCount: opened.slideCount,
          phases: opened.phases,
          // 有没有成品可放。不等于「窗口此刻正放着它」—— 别让模型误读。
          hasBuild: Boolean(opened.previewUrl),
        })
      },
    },
    {
      name: 'create_deck',
      activity: () => ({ kind: 'write', label: '新建稿子', slides: [] }),
      config: {
        title: '新建稿子',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '新建稿子，可从 list_templates 选择起始模板并指定主题；做同款时 from 填 recipe:<同款 id>，复制一份同款样稿（主题、配色、素材沿用样稿的，theme 不生效）。省略 from 则建空目录。建完用 open_deck 打开。',
        inputSchema: {
          parentDir: z
            .string()
            .optional()
            .describe('放在哪个目录下。不给就放在 ~/Documents/Orca PPT/,别去猜别的路径')
            .meta({ title: '保存位置' }),
          title: z.string().describe('deck 名字,会成为目录名').meta({ title: '稿子名称' }),
          from: z
            .string()
            .optional()
            .describe('list_templates 返回的模板 id,或 recipe:<list_recipes 返回的同款 id>')
            .meta({ title: '模板' }),
          theme: z.string().optional().describe('list_themes 返回的主题名').meta({ title: '主题' }),
        },
      },
      run: async (args) => {
        const created = await call('deck.create', {
          ...(typeof args.parentDir === 'string' ? { parentDir: args.parentDir } : {}),
          title: String(args.title),
          ...(typeof args.from === 'string' ? { from: args.from } : {}),
          ...(typeof args.theme === 'string' ? { theme: args.theme } : {}),
        })
        // 复制样稿时动过的地方要说出来:agent 照着样稿原文去找,找不到会以为复制坏了
        if (typeof args.from === 'string' && args.from.startsWith('recipe:')) {
          return json({
            ...created,
            changed: [
              `<title> 改成了「${String(args.title)}」,其余内容和样稿一字不差`,
              '入口文件叫 deck.html;引到 skill 的路径已改成从新位置回去的相对路径',
            ],
          })
        }
        return json(created)
      },
    },
    {
      name: 'deck_status',
      activity: () => ({ kind: 'read', label: '看稿子的状态', slides: [] }),
      config: {
        title: '看当前 deck 的状态',
        annotations: looking,
        description:
          '当前打开的 deck:一个版本号,每一页的标题、版式和**源文件里的原文**,还有各阶段的校验结果。`slide` 从 0 数起(和其余工具的参数一致),`page` 是跟用户说话时用的「第几页」。`edit_text` 的 `old_text` 从这里的 `texts` 原样抄 —— 画布上看到的字可能被 CSS 改过大小写。版本号只在稿子内容变了时才变,改完想确认有没有生效,前后比一下它。',
      },
      run: async () => {
        const deckId = await active.get(call)
        const [inspected, checked] = await Promise.all([
          call('deck.inspect', { deckId }),
          call('phase.check', { deckId }),
        ])
        return json({
          deckId,
          currentSlide: (await call('deck.current', {})).slide ?? null,
          revision: inspected.revision,
          slideCount: inspected.slides.length,
          slides: inspected.slides.map(({ index, ...rest }) => ({
            slide: index,
            page: index + 1,
            ...rest,
          })),
          phases: checked.phases,
        })
      },
    },
    {
      name: 'visual_target',
      config: {
        title: '定位操作目标',
        description: '宿主操作反馈接口：定位可见目标或报告操作结束，不改文档内容。',
        annotations: looking,
        _meta: { 'dev.jevbot/ui': { version: 1, resolves: true, tracks: true } },
        inputSchema: {
          action: z.enum([
            'show_slide',
            'navigate',
            'edit_text',
            'undo',
            'redo',
            ...HOME_VISUAL_ACTIONS,
          ]),
          arguments: z.record(z.string(), z.unknown()),
          phase: z.enum(['prepare', 'completed', 'failed', 'track']).default('prepare'),
          targetId: z.string().optional(),
        },
      },
      run: async (args) => {
        const arguments_ = args.arguments as Record<string, unknown>
        type Action = RequestParams<'visual.prepare'>['action']
        const phase = (args.phase ?? 'prepare') as 'prepare' | 'completed' | 'failed' | 'track'
        // 首页上的同款卡片不属于哪份稿子:不要求开着稿子。准备阶段 server 会先回首页,
        // 之前认下的那份稿子也就关了
        if ((HOME_VISUAL_ACTIONS as readonly string[]).includes(String(args.action))) {
          const target = await call('visual.prepare', {
            action: args.action as Action,
            arguments: arguments_,
            phase,
            ...(typeof args.targetId === 'string' ? { targetId: args.targetId } : {}),
          })
          if (phase === 'prepare') active.clear()
          return json(target)
        }
        const deckId = await active.get(call)
        if (
          (args.phase ?? 'prepare') === 'prepare' &&
          args.action === 'edit_text' &&
          Number.isInteger(arguments_.slide) &&
          Number(arguments_.slide) >= 0
        ) {
          await call('deck.showSlide', { deckId, index: Number(arguments_.slide) })
        }
        return json(
          await call('visual.prepare', {
            deckId,
            action: args.action as 'show_slide' | 'navigate' | 'edit_text' | 'undo' | 'redo',
            arguments: arguments_,
            phase: (args.phase ?? 'prepare') as 'prepare' | 'completed' | 'failed' | 'track',
            targetId: args.targetId as string | undefined,
          }),
        )
      },
    },
    {
      name: 'control_state',
      config: {
        title: '读取控制权',
        description: '宿主读取控制权状态，用于结束操作反馈；不取得或续期控制权。',
        annotations: looking,
        _meta: { 'dev.jevbot/ui': { version: 1, controlState: true } },
        inputSchema: {},
      },
      run: async () => json(await call('control.state', {})),
    },
    {
      name: 'show_slide',
      activity: (args) => {
        const slides = slideArg(args, 'index')
        return { kind: 'read', label: `让你看${nth(slides)}`, slides }
      },
      config: {
        title: '让画布跳到第几页',
        _meta: {
          'dev.jevbot/ui': { version: 1, label: '第 {index+1} 页', role: 'AXButton', visual: true },
        },
        annotations: looking,
        description:
          '界面上的放映画布跳到指定页(从 0 数起)。跟用户讨论某一页时先调它 —— 他看到的和你说的才是同一页。',
        inputSchema: {
          index: z
            .number()
            .int()
            .nonnegative()
            .describe(
              '页号,从 0 数起(第 1 页传 0)。x-jevbot-format 只管界面上怎么显示给人看,不改这里的数法',
            )
            .meta({ title: '页码', 'x-jevbot-format': 'one-based-index' }),
        },
      },
      run: async (args) => {
        await call('deck.showSlide', {
          deckId: await active.get(call),
          index: Number(args.index),
        })
        return text(`画布已跳到第 ${Number(args.index) + 1} 页`)
      },
    },
    {
      name: 'edit_pages',
      activity: (args) => ({
        kind: 'write',
        label: '修改页面顺序',
        slides: slideArg(args, 'index'),
      }),
      config: {
        title: '添加、删除或移动页面',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '与页面侧栏共用编辑操作。insert 在 index 前添加标题空白页（可等于页数）；delete 删除；move 将 index 移到最终位置 to。页号从 0 开始，expected_revision 来自 deck_status。同步大纲和仍然相邻的转场，所有操作可 undo。嵌套页面和不同步的大纲会拒绝。',
        inputSchema: {
          action: z.enum(['insert', 'delete', 'move']),
          index: z.number().int().nonnegative(),
          to: z.number().int().nonnegative().optional(),
          title: z.string().trim().min(1).max(200).optional(),
          expected_revision: z.string(),
        },
      },
      run: async (args) => {
        const index = Number(args.index)
        let change: RequestParams<'deck.editPages'>['change']
        if (args.action === 'insert') {
          if (typeof args.title !== 'string' || !args.title.trim())
            return refuse('添加页面需要 title')
          change = { action: 'insert', index, title: args.title }
        } else if (args.action === 'move') {
          if (typeof args.to !== 'number') return refuse('移动页面需要 to')
          change = { action: 'move', index, to: args.to }
        } else change = { action: 'delete', index }
        const result = await call('deck.editPages', {
          deckId: await active.get(call),
          expectedRevision: String(args.expected_revision),
          change,
        })
        return result.ok ? json(result) : refuse(tag('没改:', result.reason))
      },
    },
    {
      name: 'replace_image',
      activity: (args) => ({
        kind: 'write',
        label: `替换${nth(slideArg(args))}的图片`,
        slides: slideArg(args),
      }),
      config: {
        title: '替换页面图片',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '替换源文件 img 的 src，保留尺寸、样式和转场标记。使用 get_canvas_elements 的 slide、简单 id/data-anchor 选择器、source 和 revision。source_path 是 deck 内已有图片的相对文件路径；不导入外部文件。拒绝过期目标、srcset、运行时路径选择器；可 undo。',
        inputSchema: {
          slide: z.number().int().nonnegative(),
          selector: z.string().min(1).max(2000),
          old_source: z.string(),
          source_path: z.string().min(1).max(2000),
          expected_revision: z.string(),
        },
      },
      run: async (args) => {
        const result = await call('deck.replaceImage', {
          deckId: await active.get(call),
          slide: Number(args.slide),
          selector: String(args.selector),
          oldSource: String(args.old_source),
          source: String(args.source_path),
          expectedRevision: String(args.expected_revision),
        })
        return result.ok ? json(result) : refuse(tag('没改:', result.reason))
      },
    },
    {
      name: 'edit_text',
      activity: (args) => {
        const slides = slideArg(args)
        return {
          kind: 'write',
          label: `改${nth(slides)}的文字`,
          slides,
          ...(typeof args.new_text === 'string' ? { hint: args.new_text } : {}),
        }
      },
      config: {
        title: '换掉一句话',
        _meta: { 'dev.jevbot/ui': { version: 1, label: '{old_text}', role: 'AXStaticText' } },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '在源文件里把某一页的一段文字精确换成新的,标签和属性一个不动 —— 改文案用它,比你自己编辑 HTML 稳,能撤销,不会误伤 data-id / data-carry 这些转场靠的属性。`old_text` 优先按**整段文字**认(「12」不会撞上「2021」),整段对不上才按一段字里的一部分找。`new_text` 留空就把只装着这段字的那个元素整个删掉(比如不要的数字行、单位行)。找不到、或者这一页里有好几处一样的,它会拒绝并告诉你为什么,那时候再自己动手。',
        inputSchema: {
          slide: z
            .number()
            .int()
            .nonnegative()
            .describe(
              '页号,从 0 数起(第 1 页传 0)。x-jevbot-format 只管界面上怎么显示给人看,不改这里的数法',
            )
            .meta({ title: '页码', 'x-jevbot-format': 'one-based-index' }),
          old_text: z.string().describe('现在那段文字,要一模一样').meta({ title: '原文字' }),
          new_text: z.string().describe('换成什么;留空就删掉这个元素').meta({ title: '替换为' }),
        },
      },
      run: async (args) => {
        const result = await call('deck.editText', {
          deckId: await active.get(call),
          slide: Number(args.slide),
          oldText: String(args.old_text),
          newText: String(args.new_text),
        })
        if (!result.ok) return refuse(tag('没改:', result.reason))
        return text(`第 ${Number(args.slide) + 1} 页改好了。`)
      },
    },
    {
      name: 'edit_plan',
      activity: (args) => ({
        kind: 'write',
        label: '改转场计划',
        slides: [],
        ...(typeof args.new_text === 'string' ? { hint: args.new_text } : {}),
      }),
      config: {
        title: '改转场计划里的一句',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '把稿子开头「转场计划」注释里的一段字精确换掉 —— 页面之外的字 edit_text 够不着,比如做同款后注释里还留着样稿的示例公司、示例说明。只改注释,页面一个字节不动,能撤销。找不到、或者有好几处一样的,它会拒绝。',
        inputSchema: {
          old_text: z.string().describe('注释里现在那段文字,要一模一样').meta({ title: '原文字' }),
          new_text: z.string().describe('换成什么;留空就删掉这段字').meta({ title: '替换为' }),
        },
      },
      run: async (args) => {
        const result = await call('deck.editPlan', {
          deckId: await active.get(call),
          oldText: String(args.old_text),
          newText: String(args.new_text),
        })
        if (!result.ok) return refuse(tag('没改:', result.reason))
        return text('转场计划改好了。')
      },
    },
    {
      name: 'doctor',
      activity: () => ({ kind: 'read', label: '检查环境', slides: [] }),
      config: {
        title: '检查环境',
        annotations: looking,
        description:
          '查 Orca PPT 这一侧的环境:应用版本、skill 在哪(从哪儿找到的、找过哪些位置)、界面连没连上、开着哪些稿子、操作记录存在哪。碰到 UI_DISCONNECTED、SKILL_NOT_FOUND、UI_TIMEOUT 这类错误,或者工具行为不对时先调它,别猜。',
      },
      run: async () => json(await call('app.doctor', {})),
    },
    {
      name: 'recording_events',
      config: {
        title: '取操作记录',
        annotations: looking,
        description:
          '给宿主用于录制和回放,agent 不要调用。取某个游标之后稿子被改的事件(可录制应用约定 v1):谁改的(user / agent / external)、改了哪份稿子哪一页、改完的版本号。返回 JSON:{ version, events, cursor, more, gap, revisionIsContentHash }。',
        inputSchema: {
          after: z
            .string()
            .optional()
            .describe('游标:上次返回的 cursor。不给就从还保留着的最早一条开始'),
          limit: z.number().int().min(1).max(1000).optional().describe('最多几条,默认 200'),
        },
      },
      run: async (args) => {
        const after = typeof args.after === 'string' && args.after ? args.after : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        return json(
          await call('recording.events', {
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        )
      },
    },
    {
      name: 'recording_snapshot',
      config: {
        title: '取缩略图',
        annotations: looking,
        description:
          '给宿主用于录制和回放,agent 不要调用。当前版本的一张缩略图:被改的那一页,离屏渲染,不会翻动用户眼前的画布。旧版本渲不了,返回 REVISION_UNAVAILABLE。',
        inputSchema: {
          document: z
            .string()
            .optional()
            .describe('稿子 id(目录的绝对路径)。不给就是最近打开的那份'),
          revision: z.string().optional().describe('要哪个版本。只支持当前版本'),
          maxSize: z.number().int().min(64).max(1280).optional().describe('长边上限,默认 640'),
        },
      },
      run: async (args) => {
        const pick = (key: string) =>
          typeof args[key] === 'string' && args[key] ? (args[key] as string) : undefined
        const document = pick('document')
        const revision = pick('revision')
        const maxSize = typeof args.maxSize === 'number' ? args.maxSize : undefined
        const result = await call('recording.snapshot', {
          ...(document ? { document } : {}),
          ...(revision ? { revision } : {}),
          ...(maxSize !== undefined ? { maxSize } : {}),
        })
        if (!result.ok || !result.image || !result.mimeType) {
          return refuse(result.reason ?? 'REVISION_UNAVAILABLE:渲不出来')
        }
        const { document: doc, revision: rev, width, height, target } = result
        return {
          content: [
            { type: 'image', data: result.image, mimeType: result.mimeType },
            {
              type: 'text',
              text: JSON.stringify({ document: doc, revision: rev, width, height, target }),
            },
          ],
        }
      },
    },
    {
      name: 'take_control',
      config: {
        title: '拿起稿子',
        // 不动磁盘:只是让界面知道这段时间归你改。
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description:
          '开始一段连续的修改之前调一次,说清要做什么(reason 会显示给用户)。之后画布上会盖一层遮罩,用户不能同时改稿子,直到你调 hand_off,或者两分钟没有任何调用。不调也能用别的工具,只是用户看不到这段活儿叫什么,几步连着改时还可能被他插进来。' +
          '要等用户批准什么时,再调一次并带上 waiting(界面会显示「等你批准:…」);批准完再调一次不带 waiting 就清掉。' +
          '用户点了「接管」,你的工具会返回 USER_IN_CONTROL:硬停止,不要重试,也不要自己调 take_control 拿回来;结束这一轮告诉用户你停在哪儿,等他明确说继续再调 take_control。' +
          '用户点了「停止」,工具会返回 USER_STOPPED:这件事不做了,结束这一轮。',
        inputSchema: {
          renew: z.boolean().optional().describe('只续期当前操作；人工接管后拒绝，不夺回控制权'),
          reason: z.string().describe('接下来要做什么,一句人话,比如「重排第 2 到 4 页的标题」'),
          waiting: z
            .string()
            .optional()
            .describe('在等用户批准什么,比如「删掉第 5 页」。不在等就不写'),
        },
      },
      run: async (args) => {
        const reason = String(args.reason ?? '')
        const waiting = typeof args.waiting === 'string' && args.waiting ? args.waiting : undefined
        const state = await call('control.take', {
          reason,
          waiting,
          renew: args.renew as boolean | undefined,
        })
        return text(
          state.waiting
            ? `拿着了:${state.task ?? ''}。界面显示在等你批准:${state.waiting}。`
            : `拿着了:${state.task ?? ''}。改完调 hand_off 交还给用户。`,
        )
      },
    },
    {
      name: 'hand_off',
      config: {
        title: '交还稿子',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description:
          '干完了,把稿子交还给用户:画布上的遮罩撤掉,他又能改了。需要他确认或接着做什么,写进 message,会显示在画布下面。',
        inputSchema: {
          message: z
            .string()
            .optional()
            .describe('留给用户的一句话,比如「第 3 页的数字请你确认一下」。没有就不写'),
        },
      },
      run: async (args) => {
        const message = typeof args.message === 'string' && args.message ? args.message : undefined
        await call('control.handOff', message ? { message } : {})
        return text('交还了。')
      },
    },
    {
      name: 'undo',
      activity: () => ({ kind: 'write', label: '撤销上一处改动', slides: [] }),
      config: {
        _meta: { 'dev.jevbot/ui': { version: 1, label: '撤销', role: 'AXButton' } },
        title: '撤销上一处改动',
        // 会改稿子,但不丢东西:撤掉的那一步 redo 能拿回来。
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '撤销最近一次共享操作：改字、页面编辑或图片替换，和 UI 的撤销按钮共用历史。直接写文件的修改不在历史中；结构或图片修改后的文件被外部修改时拒绝撤销，改字可尝试只还原原文。',
      },
      run: async () => {
        const result = await call('deck.undo', { deckId: await active.get(call) })
        if (!result.ok) return refuse(tag('没撤:', result.reason))
        if (result.text === undefined) return json(result)
        return text(
          `撤销了第 ${(result.slide ?? 0) + 1} 页的改字,那里现在是「${result.text ?? ''}」。`,
        )
      },
    },
    {
      name: 'redo',
      activity: () => ({ kind: 'write', label: '重做刚撤掉的改动', slides: [] }),
      config: {
        _meta: { 'dev.jevbot/ui': { version: 1, label: '重做', role: 'AXButton' } },
        title: '重做刚撤掉的改动',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '重做刚撤销的共享操作。撤销之后有新的共享编辑会清空重做记录；文件不再匹配时拒绝，不覆盖外部改动。',
      },
      run: async () => {
        const result = await call('deck.redo', { deckId: await active.get(call) })
        if (!result.ok) return refuse(tag('没重做:', result.reason))
        if (result.text === undefined) return json(result)
        return text(
          `重做了第 ${(result.slide ?? 0) + 1} 页的改字,那里现在是「${result.text ?? ''}」。`,
        )
      },
    },
    {
      name: 'user_selection',
      activity: () => ({ kind: 'read', label: '取你指的地方', slides: [] }),
      config: {
        title: '用户正指着什么',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '用户在界面上点中的地方 —— 带页号、**相对那一页的** CSS 选择器、1920×1080 设计坐标,和一张带上下文的裁切图。他说「这儿太挤」「按我圈的地方改」「刚点的那处」时调它,不用猜他指的是哪儿。也包括他点了「跑」的阶段。读完就清空。',
      },
      run: async () => {
        const taken = await call('requests.take', { deckId: await active.get(call) })
        if (taken.requests.length === 0) {
          return text('用户现在没指着任何地方 —— 直接按他说的做,或者问他指哪儿。')
        }
        return json(taken.requests.map(describeRequest))
      },
    },
    {
      name: 'peek_selection',
      activity: () => ({ kind: 'read', label: '看你指的地方', slides: [] }),
      config: {
        title: '看一眼用户指着什么但不清空',
        annotations: looking,
        description: '和 user_selection 一样,但读完不清空。',
      },
      run: async () => {
        const pending = await call('requests.list', { deckId: await active.get(call) })
        return json(pending.requests.map(describeRequest))
      },
    },
    {
      name: 'phase_prompt',
      activity: (args) => ({
        kind: 'read',
        label: `取「${String(args.phase ?? '')}」阶段的做法`,
        slides: [],
      }),
      config: {
        title: '取一个阶段的做法',
        annotations: looking,
        description:
          '拿到某个阶段该怎么做的完整说明(定题 brief → 选主题 theme → 列页面 outline → 写转场 plan → 出稿 build)。上游产物不合规时**直接拒绝**并说清是哪一条 —— 闸门在这儿,别绕过去。',
        inputSchema: {
          phase: Phase.describe('阶段'),
          request: z.string().optional().describe('用户那句话,只有 brief 阶段要'),
        },
      },
      run: async (args) => {
        const result = await call('phase.prompt', {
          deckId: await active.get(call),
          phase: args.phase as DeckPhase,
          ...(args.request ? { request: String(args.request) } : {}),
        })
        if (!result.prompt) {
          return text(
            `这个阶段还不能开始,卡在「${result.blockedBy}」:\n${result.issues.map((i) => `- ${i}`).join('\n')}`,
          )
        }
        return text(result.prompt)
      },
    },
    {
      name: 'check_phase',
      activity: () => ({ kind: 'read', label: '校验各阶段', slides: [] }),
      config: {
        title: '校验阶段产物',
        annotations: looking,
        description:
          '对磁盘上的阶段产物跑确定性检查(版式理由写没写、格子凑不凑得满、转场是不是相邻两页、匹配剪辑有没有锚……)。写完一个阶段就调它,别等到出稿才发现。',
        inputSchema: { phase: Phase.optional().describe('不给就查全部') },
      },
      run: async (args) =>
        json(
          await call('phase.check', {
            deckId: await active.get(call),
            ...(args.phase ? { phase: args.phase as DeckPhase } : {}),
          }),
        ),
    },
    {
      name: 'artifact_path',
      activity: () => ({ kind: 'read', label: '找产物路径', slides: [] }),
      config: {
        title: '拿阶段产物的路径',
        annotations: looking,
        description: '某个阶段的产物文件在磁盘上的绝对路径,用来读写它。',
        inputSchema: { phase: Phase.describe('阶段') },
      },
      run: async (args) =>
        json(
          await call('artifact.path', {
            deckId: await active.get(call),
            phase: args.phase as DeckPhase,
          }),
        ),
    },
    {
      name: 'present',
      activity: (args) => ({ kind: 'read', label: '开始放映', slides: slideArg(args, 'slide') }),
      config: {
        title: '全屏放映',
        annotations: looking,
        description:
          '把稿子在用户屏幕上全屏放映起来,从指定页开始(不给就从第一页)。用户说「放给我看」「演示一遍」时调它。转场只有放映时才看得见,截图看不出。只是自己检查效果的话不用放映,工作台里的画布一样能看、navigate 翻的也是它。放完用 stop_present 关掉放映;close_deck 也会顺带关掉。',
        inputSchema: {
          slide: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              '从第几页开始,从 0 数起(第 1 页传 0)。x-jevbot-format 只管界面上怎么显示给人看,不改这里的数法',
            )
            .meta({ title: '起始页', 'x-jevbot-format': 'one-based-index' }),
        },
      },
      run: async (args) => {
        await call('deck.present', {
          deckId: await active.get(call),
          ...(args.slide === undefined ? {} : { slide: Number(args.slide) }),
        })
        return text('已经全屏放映起来了。用户按 Esc 退出;要关掉就调 stop_present。')
      },
    },
    {
      name: 'stop_present',
      activity: () => ({ kind: 'read', label: '退出放映', slides: [] }),
      config: {
        title: '退出放映',
        annotations: looking,
        description: '关掉全屏放映窗口(和用户按 Esc 一样)。没在放映时调它也没关系。',
      },
      run: async () => {
        await call('deck.stopPresent', { deckId: await active.get(call) })
        return text('已经关掉放映。')
      },
    },
    {
      name: 'autoplay',
      activity: (args) => ({
        kind: 'read',
        label: args.on === false ? '停掉自动播放' : '开始自动播放',
        slides: [],
      }),
      config: {
        title: '自动播放',
        annotations: looking,
        description:
          '让画布按每页声明的停留时长自动往后翻,用户不用一直按方向键。说「自动放一遍」「让它自己走」时调它。用户一动键盘鼠标就会停。',
        inputSchema: { on: z.boolean().describe('开还是关').meta({ title: '自动播放' }) },
      },
      run: async (args) => {
        const on = args.on !== false
        await call('deck.autoplay', { deckId: await active.get(call), on })
        return text(on ? '开始自动播放了。' : '停了。')
      },
    },
    {
      name: 'capture_slide',
      activity: (args) => {
        const slides = slideArg(args)
        return { kind: 'read', label: `在看${nth(slides)}`, slides }
      },
      config: {
        title: '截一张画布的图',
        annotations: looking,
        description:
          '把放映画布上的某一页截下来,图直接附在结果里,另给磁盘路径。**改完一定要看一眼** —— 稿子好不好只有放映能回答,光读 HTML 看不出挤不挤、对不对得上。不给页号就截当前这一页。',
        inputSchema: {
          expected_revision: z
            .string()
            .optional()
            .describe('从 deck_status 取得的目标版本；要求截图显示该版本。'),
          slide: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              '页号,从 0 数起(第 1 页传 0)。x-jevbot-format 只管界面上怎么显示给人看,不改这里的数法',
            )
            .meta({ title: '页码', 'x-jevbot-format': 'one-based-index' }),
        },
      },
      run: async (args) => {
        const deckId = await active.get(call)
        // 截别的页要先把画布翻过去。截完翻回人原来看的那一页:不然 agent 逐页截一遍,
        // 画布就停在最后截的那页,人看到的是「改完字自己跳到了第 7 页」
        let back: number | undefined
        if (args.slide !== undefined) {
          const before = await call('canvas.inspect', { deckId, include: 'context' }).catch(
            () => undefined,
          )
          if (typeof before?.slide === 'number' && before.slide !== Number(args.slide))
            back = before.slide
          await call('deck.showSlide', { deckId, index: Number(args.slide) })
          // 转场要放完才是那一页最终的样子。
          await new Promise((resolve) => setTimeout(resolve, 1400))
        }
        const shot = await call('deck.capture', {
          deckId,
          ...(args.slide === undefined ? {} : { slide: Number(args.slide) }),
          ...(typeof args.expected_revision === 'string'
            ? { expectedRevision: args.expected_revision }
            : {}),
        }).finally(() => {
          if (back !== undefined)
            void call('deck.showSlide', { deckId, index: back }).catch(() => {})
        })
        // 图直接给,不只给路径:不是每个宿主都让 agent 读任意文件,而且多读一趟也白费。
        // 读不到就退回只给路径 —— 截图本身是成功的。
        let data: string | undefined
        try {
          data = (await readFile(shot.path)).toString('base64')
        } catch {
          data = undefined
        }
        const note = text(
          `截好了:${shot.path}` +
            (shot.renderedRevision
              ? `\n${JSON.stringify({ deckId: shot.deckId, slide: shot.slide, renderedRevision: shot.renderedRevision })}`
              : ''),
        )
        if (!data) return note
        return { content: [...note.content, { type: 'image', data, mimeType: 'image/png' }] }
      },
    },
    {
      name: 'list_themes',
      activity: () => ({ kind: 'read', label: '看现成主题', slides: [] }),
      config: {
        title: '列出现成主题和版式',
        annotations: looking,
        description:
          '来自随附规范(skill)的主题和版式目录。选主题阶段先从这里挑,不合适再新建 —— 颜色只能来自主题文件,不要在稿子里改颜色。',
      },
      run: async () => json(await call('catalog.list', {})),
    },
  ]
}

/** 锚要让模型一眼看懂:页号从 1 数起,坐标说清是哪个坐标系。 */
function describeRequest(request: PendingRequest): unknown {
  if (request.kind === 'phase') return { 要跑的阶段: request.phase }

  const anchor = request.anchor
  if (anchor.kind === 'transition') {
    return {
      用户指的是: `第 ${anchor.from + 1} 页 → 第 ${anchor.to + 1} 页的转场`,
      他说: anchor.note,
    }
  }
  return {
    用户指的是: `第 ${anchor.slide + 1} 页的元素`,
    选择器: anchor.selector,
    位置: `1920×1080 画面的 (${anchor.box.x}, ${anchor.box.y}),尺寸 ${anchor.box.w}×${anchor.box.h}`,
    ...(anchor.text ? { 当前文本: anchor.text } : {}),
    ...(anchor.crop ? { 裁切图: anchor.crop } : {}),
    他说: anchor.note,
  }
}
