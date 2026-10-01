import type {
  DeckPhase,
  PendingRequest,
  RequestMethod,
  RequestParams,
  RequestResult,
} from '@orca-ppt/contracts'
import { phaseOrder } from '@orca-ppt/contracts'
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

export function buildTools(call: ProtocolCaller, active: ActiveDeck): ToolSpec[] {
  return [
    {
      name: 'list_skill',
      config: {
        title: '列出随附规范资料',
        description: '浏览本版本 OrcaPPT 随附 Skill 的相对目录，分页返回；无需打开稿子。',
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
      name: 'navigate',
      config: {
        title: '翻页或重放转场',
        description: '与键盘翻页和 UI 重放共用操作。replay 必须带 from，页号从 0 数起。',
        annotations: looking,
        inputSchema: {
          action: z.enum(['next', 'previous', 'replay']),
          from: z.number().int().nonnegative().optional(),
        },
      },
      run: async (args) => {
        await call('deck.navigation', {
          deckId: await active.get(call),
          action: args.action as 'next' | 'previous' | 'replay',
          ...(typeof args.from === 'number' ? { from: args.from } : {}),
        })
        return text('已请求画布执行；完成后的页号请读取 deck_status。')
      },
    },
    {
      name: 'open_deck',
      activity: () => ({ kind: 'read', label: '打开稿子', slides: [] }),
      config: {
        title: '打开 deck',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '打开一个 deck 目录并在界面上放映它。认 deck.html 和 index.html;成品还没做出来的目录也能打开。返回页数、各阶段状态和放映地址。',
        inputSchema: { path: z.string().describe('deck 目录的绝对路径') },
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
        title: '新建 deck',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '新建稿子，可从 list_templates 选择起始模板并指定主题。省略模板则建空目录。建完用 open_deck 打开。',
        inputSchema: {
          parentDir: z.string().describe('放在哪个目录下'),
          title: z.string().describe('deck 名字,会成为目录名'),
          from: z.string().optional().describe('list_templates 返回的模板 id'),
          theme: z.string().optional().describe('list_themes 返回的主题名'),
        },
      },
      run: async (args) =>
        json(
          await call('deck.create', {
            parentDir: String(args.parentDir),
            title: String(args.title),
            ...(typeof args.from === 'string' ? { from: args.from } : {}),
            ...(typeof args.theme === 'string' ? { theme: args.theme } : {}),
          }),
        ),
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
      name: 'show_slide',
      activity: (args) => {
        const slides = slideArg(args, 'index')
        return { kind: 'read', label: `让你看${nth(slides)}`, slides }
      },
      config: {
        title: '让画布跳到第几页',
        annotations: looking,
        description:
          '界面上的放映画布跳到指定页(从 0 数起)。跟用户讨论某一页时先调它 —— 他看到的和你说的才是同一页。',
        inputSchema: { index: z.number().int().nonnegative().describe('页号,从 0 数起') },
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
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        description:
          '在源文件里把某一页的一段文字精确换成新的,标签和属性一个不动 —— 改文案用它,比你自己编辑 HTML 稳,不会误伤 data-id / data-carry 这些转场靠的属性。`old_text` 要和页面上现在那段字**一模一样**。找不到、或者这一页里有好几处一样的,它会拒绝并告诉你为什么,那时候再自己动手。',
        inputSchema: {
          slide: z.number().int().nonnegative().describe('页号,从 0 数起'),
          old_text: z.string().describe('现在那段文字,要一模一样'),
          new_text: z.string().describe('换成什么'),
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
      name: 'doctor',
      activity: () => ({ kind: 'read', label: '检查环境', slides: [] }),
      config: {
        title: '检查环境',
        annotations: looking,
        description:
          '查 OrcaPPT 这一侧的环境:应用版本、skill 在哪(从哪儿找到的、找过哪些位置)、界面连没连上、开着哪些稿子、操作记录存在哪。碰到 UI_DISCONNECTED、SKILL_NOT_FOUND、UI_TIMEOUT 这类错误,或者工具行为不对时先调它,别猜。',
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
        const state = await call('control.take', waiting ? { reason, waiting } : { reason })
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
      activity: () => ({ kind: 'write', label: '撤销上一处改字', slides: [] }),
      config: {
        title: '撤销上一处改字',
        // 会改稿子,但不丢东西:撤掉的那一步 redo 能拿回来。
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description:
          '撤掉最近一次改字 —— 不管是 edit_text 改的,还是用户在画布上双击改的,和界面上的撤销按钮是同一件事。只管改字:你直接写 HTML 的改动不在这里面。没有可撤的、或者那段字在那之后被改得对不上了,它会拒绝并说明。',
      },
      run: async () => {
        const result = await call('deck.undo', { deckId: await active.get(call) })
        if (!result.ok) return refuse(tag('没撤:', result.reason))
        return text(
          `撤销了第 ${(result.slide ?? 0) + 1} 页的改字,那里现在是「${result.text ?? ''}」。`,
        )
      },
    },
    {
      name: 'redo',
      activity: () => ({ kind: 'write', label: '重做刚撤掉的改字', slides: [] }),
      config: {
        title: '重做刚撤掉的改字',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        description: '把刚撤掉的那处改字重做回来。撤销之后又改过字,就没有可重做的了。',
      },
      run: async () => {
        const result = await call('deck.redo', { deckId: await active.get(call) })
        if (!result.ok) return refuse(tag('没重做:', result.reason))
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
      activity: (args) => ({ kind: 'read', label: '开始放映', slides: slideArg(args, 'from') }),
      config: {
        title: '全屏放映',
        annotations: looking,
        description:
          '把稿子在用户屏幕上全屏放映起来,从指定页开始(不给就从第一页)。用户说「放给我看」「演示一遍」时调它。转场只有放映时才看得见 —— 截图看不出。',
        inputSchema: {
          slide: z.number().int().nonnegative().optional().describe('从第几页开始,从 0 数起'),
        },
      },
      run: async (args) => {
        await call('deck.present', {
          deckId: await active.get(call),
          ...(args.slide === undefined ? {} : { slide: Number(args.slide) }),
        })
        return text('已经全屏放映起来了。用户按 Esc 退出。')
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
        inputSchema: { on: z.boolean().describe('开还是关') },
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
          slide: z.number().int().nonnegative().optional().describe('页号,从 0 数起'),
        },
      },
      run: async (args) => {
        const deckId = await active.get(call)
        if (args.slide !== undefined) {
          await call('deck.showSlide', { deckId, index: Number(args.slide) })
          // 转场要放完才是那一页最终的样子。
          await new Promise((resolve) => setTimeout(resolve, 1400))
        }
        const shot = await call('deck.capture', {
          deckId,
          ...(args.slide === undefined ? {} : { slide: Number(args.slide) }),
        })
        // 图直接给,不只给路径:不是每个宿主都让 agent 读任意文件,而且多读一趟也白费。
        // 读不到就退回只给路径 —— 截图本身是成功的。
        let data: string | undefined
        try {
          data = (await readFile(shot.path)).toString('base64')
        } catch {
          data = undefined
        }
        const note = text(`截好了:${shot.path}`)
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
          '来自 orca-ppt-skill 的主题和版式目录。选主题阶段先从这里挑,不合适再新建 —— 颜色只能来自主题文件,不要在稿子里改颜色。',
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
