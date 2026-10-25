import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { RECORDING_TOOLS } from './control.js'
import { ActiveDeck, buildTools, type ProtocolCaller, type ToolSpec } from './mcp-tools.js'
import { mcpCall } from './mcp-origin.js'

/**
 * MCP 就挂在这台 server 的 `/mcp` 上,和界面同一个进程、同一个端口。
 *
 * 为什么是 HTTP 不是 stdio:stdio 要在 agent 的配置里写一条指向本仓 dist 的路径
 * (打包之后就废了),还要多起一个进程、再想办法告诉它端口。HTTP 只要一行:
 *
 *   claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
 *
 * 代价是应用必须开着 —— 但本来就必须开着,画布在它里面。
 */
/** 一次工具调用在界面上的一声报告。和 `mcp.activity` 推送同形。 */
export interface McpActivity {
  id: string
  tool: string
  kind: 'read' | 'write'
  phase: 'start' | 'done'
  label: string
  slides: number[]
  at: number
  hint?: string
  error?: string
}

/**
 * 自报家门时带上图标(MCP `serverInfo.icons`)。宿主不一定能从装好的 .app 里取到图标 ——
 * 开发时壳是直接 `electron dist/main.js` 跑的,根本没有 .app —— 那它只能靠这里。
 * 用 data URI:不多开一个路由,宿主也不用再发一次请求。图读不到就不带,不影响工具。
 * 源图见 docs/brand/orca-app-icon.png,这份是 256 的派生。
 */
export function serverIcons(
  file = join(dirname(fileURLToPath(import.meta.url)), '../assets/icon.png'),
) {
  try {
    const data = readFileSync(file).toString('base64')
    return [{ src: `data:image/png;base64,${data}`, mimeType: 'image/png', sizes: ['256x256'] }]
  } catch {
    return []
  }
}

/**
 * MCP 握手时交给宿主的使用说明。宿主一般会把它放进模型的上下文 —— 不看工具列表也知道
 * 该先拿起稿子。不这么说的话,agent 多半不会调 take_control,人看到的遮罩就只在它每次
 * 调用前后闪一下。
 */
const INSTRUCTIONS = [
  '规范读取：先用 read_skill 读取随应用发布的 SKILL.md，引用资料用 list_skill/read_skill 按需获取，next 非空时继续读取。',
  'Orca PPT 是用户开着的演示稿应用,你和用户看着同一块画布。',
  '控制权:要改稿子,先调 take_control 说明要做什么 —— 画布会盖上遮罩,底部的胶囊显示这件事,用户不会和你同时改;' +
    '在等用户批准时再调一次并带上 waiting;全部做完调 hand_off 交还,需要用户确认的写进 message。' +
    '任何工具返回 USER_IN_CONTROL,说明用户接管了:立刻停下,不要重试,告诉用户你停在哪一步。' +
    '返回 USER_STOPPED,说明用户停止了这件事:结束这一轮,不要继续。',
  '改字:先调 deck_status 读每页的原文,edit_text 的 old_text 从那里照抄 —— 画布上的字可能被 CSS 改过大小写,' +
    '照屏幕抄会对不上。改完用 capture_slide 看一眼;改错了用 undo。',
  '页面和图片编辑: edit_pages / replace_image 与 UI 共用操作和撤销，必须使用 deck_status 的 expected_revision；改后检查新相邻转场。replace_image 只替换 deck 内已有资源引用。',
  '改一整页:read_page 读那一页的源码,改完用 write_page 写回 —— 画布只换这一页,不重载整份稿子;不要为了改一页去重写整个 HTML 文件。',
  '画布检视: get_canvas_context 读取当前页和实时选区，不消费用户意见；get_canvas_elements/get_canvas_html/get_canvas_errors 查看当前画面。选择元素时使用返回的 slide、revision 和页内选择器。改后用 expected_revision 等待 get_canvas_context/capture_slide 确认目标版本；current 为 false 不能当作最新画面。',
  '做新稿子:按阶段走 phase_prompt(定题 → 选主题 → 列页面 → 写转场 → 出稿)。上游产物不合格时它会拒绝并说明哪一条,' +
    '改好上游再往下走,不要跳过;check_phase 可以随时跑一遍校验。',
].join('\n')

export class McpEndpoint {
  /** 跨请求活着的只有「当前是哪份 deck」。其余每个请求自成一体。 */
  readonly #active = new ActiveDeck()
  /** 读一次就够了 —— 每个请求都要新建 server,别每次都读盘。 */
  readonly #icons = serverIcons()

  constructor(
    private readonly call: ProtocolCaller,
    /** 每次工具调用报两声(跑之前、跑之后),界面据此把 agent 做的事显示出来。 */
    private readonly onActivity: (activity: McpActivity) => void = () => {},
    /**
     * 这个工具现在能不能跑。人在界面上接管了稿子时,返回给 agent 的那段话 ——
     * 在工具跑之前就挡掉,也不报活动:它没做成任何事,界面上不该亮。
     */
    private readonly gate: (tool: string) => string | undefined = () => undefined,
    /** 握手时报的版本号:app 的真实版本。宿主靠它判断连的是哪一版,skill 也跟着这个版本发。 */
    private readonly version = '0.0.0-dev',
  ) {}

  /**
   * 给工具套上"报告"。**跑之前也要报一声**,不只是跑完 ——
   * `capture_slide` 会把画布跳到另一页,不先说一声的话,人看着画布莫名其妙翻页。
   *
   * 报告失败不该带垮工具本身:界面上少亮一下,远好过 agent 的调用平白报错。
   */
  #announce(tool: ToolSpec): ToolSpec['run'] {
    // 带上「这是哪个工具在调」:协议方法据此把操作记成 agent 做的(见 mcp-origin.ts)
    const run = (args: Record<string, unknown>) =>
      mcpCall.run({ tool: tool.name }, () => tool.run(args))
    // 录制工具不算 agent 的操作:不拦、不报活动,也就不会推断成 agent 拿着稿子
    if (RECORDING_TOOLS.has(tool.name)) return run
    return async (args) => {
      const blocked = this.gate(tool.name)
      if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true }

      const id = randomUUID()
      const shape = tool.activity?.(args) ?? {
        kind: 'read' as const,
        label: tool.config.title,
        slides: [],
      }
      const say = (phase: 'start' | 'done', error?: string) => {
        try {
          this.onActivity({
            id,
            tool: tool.name,
            ...shape,
            phase,
            at: Date.now(),
            ...(error ? { error } : {}),
          })
        } catch {
          // 界面那头出了什么事,不该让 agent 的调用跟着失败。
        }
      }

      say('start')
      try {
        const result = await run(args)
        // 工具跑到了但这件事没办成(isError),界面上也该显示成没办成 —— 报成功是不诚实的。
        say('done', result.isError ? firstLine(result) : undefined)
        return result
      } catch (error) {
        say('done', error instanceof Error ? error.message : String(error))
        throw error
      }
    }
  }

  /** 处理一个请求。不是 /mcp 就返回 false,交回给调用方。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return false

    // 无状态范式:**每个请求新建一套** server + transport。
    // 复用同一个 transport 会让它把响应发到上一个请求的 res 上 —— 第二个请求就静默空回。
    const server = new McpServer(
      {
        name: 'orca-ppt',
        title: 'Orca PPT',
        version: this.version,
        ...(this.#icons.length > 0 ? { icons: this.#icons } : {}),
      },
      { instructions: INSTRUCTIONS },
    )
    for (const tool of buildTools(this.call, this.#active)) {
      server.registerTool(
        tool.name,
        tool.config as never,
        (async (args: unknown) =>
          this.#announce(tool)((args ?? {}) as Record<string, unknown>)) as never,
      )
    }

    // 两处 as never 是因为 SDK 的类型没按 exactOptionalPropertyTypes 写(可选属性用
    // `x?: T` 而不是 `x?: T | undefined`)。我们不为此放宽整个仓库的严格度。
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never)
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport as never)
    await transport.handleRequest(req, res, await readBody(req))
    return true
  }

  async close(): Promise<void> {
    // 每个请求自己收尾,这里没有长驻的东西要关。
  }
}

/** 工具自己给的那句理由,直接摆到界面上。 */
function firstLine(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === 'text')?.text ?? '没办成'
}

/** transport 要的是解析好的 JSON body;GET(SSE)没有 body。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // 交给 transport 去回一个规范的 JSON-RPC 错误。
    return undefined
  }
}
