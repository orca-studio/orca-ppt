import type {
  DeckPhase,
  PendingRequest,
  RequestMethod,
  RequestParams,
  RequestResult,
} from '@orca-ppt/contracts'
import { phaseOrder } from '@orca-ppt/contracts'
import { z } from 'zod'

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
    if (this.#id) return this.#id

    const { decks } = await call('deck.list', {})
    if (decks.length === 1 && decks[0]) {
      this.#id = decks[0].id
      return this.#id
    }
    if (decks.length === 0) {
      throw new Error('应用里还没打开 deck —— 让用户打开一份,或者用 open_deck 指定路径')
    }
    throw new Error(
      `应用里开着好几份 deck,用 open_deck 指定是哪一份:${decks.map((d) => d.path).join('、')}`,
    )
  }
}

const Phase = z.enum(phaseOrder as [DeckPhase, ...DeckPhase[]])

/**
 * `isError` 是 MCP 自己的字段:工具跑到了,但这件事没办成。
 *
 * 用它而不是 throw:理由要原样交到 agent 手里(「这一页里有好几处一样的文字」比
 * 一个异常有用得多),同时界面也认得出这次没办成 —— 报成功是不诚实的。
 */
type Text = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
const text = (value: string): Text => ({ content: [{ type: 'text', text: value }] })
const refuse = (value: string): Text => ({
  content: [{ type: 'text', text: value }],
  isError: true,
})
const json = (value: unknown): Text => text(JSON.stringify(value, null, 2))

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

export interface ToolSpec {
  name: string
  config: { title: string; description: string; inputSchema?: z.ZodRawShape }
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
      name: 'open_deck',
      activity: () => ({ kind: 'read', label: '打开稿子', slides: [] }),
      config: {
        title: '打开 deck',
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
        description: '在一个目录下建一份空 deck。建完还要 open_deck 才会在界面上打开。',
        inputSchema: {
          parentDir: z.string().describe('放在哪个目录下'),
          title: z.string().describe('deck 名字,会成为目录名'),
        },
      },
      run: async (args) =>
        json(
          await call('deck.create', {
            parentDir: String(args.parentDir),
            title: String(args.title),
          }),
        ),
    },
    {
      name: 'deck_status',
      activity: () => ({ kind: 'read', label: '看稿子的状态', slides: [] }),
      config: {
        title: '看当前 deck 的状态',
        description:
          '当前打开的 deck 有几页、每一页的主角和版式、转场计划、各阶段跑到哪了。改完稿子想确认结果就调它。',
      },
      run: async () => {
        const status = await call('phase.check', { deckId: await active.get(call) })
        return json(status)
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
        if (!result.ok) return refuse(`没改:${result.reason}`)
        return text(`第 ${Number(args.slide) + 1} 页改好了。`)
      },
    },
    {
      name: 'user_selection',
      activity: () => ({ kind: 'read', label: '取你指的地方', slides: [] }),
      config: {
        title: '用户正指着什么',
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
        description:
          '把放映画布上的某一页截下来,返回图片路径,你自己读它看效果。**改完一定要看一眼** —— 稿子好不好只有放映能回答,光读 HTML 看不出挤不挤、对不对得上。不给页号就截当前这一页。',
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
        return text(`截好了:${shot.path}\n用你的读文件工具打开它看。`)
      },
    },
    {
      name: 'list_themes',
      activity: () => ({ kind: 'read', label: '看现成主题', slides: [] }),
      config: {
        title: '列出现成主题和版式',
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
