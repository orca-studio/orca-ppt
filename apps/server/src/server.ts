import { listSkill, readSkill } from './skill-content.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import {
  RequestEnvelope,
  artifactPath,
  type PushEnvelope,
  type RequestMethod,
  type ResponseEnvelope,
  parseParams,
} from '@orca-ppt/contracts'
import { WebSocketServer } from 'ws'
import { Roundtrip } from './roundtrip.js'
import { DeckWatcher } from './deck-watch.js'
import { applyTextEdit } from './edit.js'
import { DeckControl } from './control.js'
import { EditHistory } from './history.js'
import { noteThemeUsed, readRecentThemes, themeOf } from './recent.js'
import { McpEndpoint } from './mcp-http.js'
import { mcpCall } from './mcp-origin.js'
import { AgentError } from './agent-errors.js'
import { RecordingLog, recordingFilePath } from './recording.js'
import {
  deckRevision,
  findEntryName,
  openDeck,
  readPageTypes as readSlidePageTypes,
  readSlideTexts,
  readSlideTitles,
  type OpenedDeck,
} from './decks.js'
import { phaseGate, readPhaseStatus } from './phases.js'
import { planPreview } from './preview.js'
import { PreviewHost } from './preview-host.js'
import { clearPortFile, writePortFile } from './port-file.js'
import { PushBus } from './push-bus.js'
import { RequestQueue } from './requests-queue.js'
import { readCatalog, readPageTypes, readVocabulary, locateSkill, type Catalog } from './skill.js'
import { instantiate, listTemplates } from './templates.js'
import { readTransitionPlan } from './transitions.js'

/**
 * 本地 server 拥有全部状态。界面和 MCP server 都是它的薄客户端 —— 界面不 spawn 进程、
 * 不碰文件系统、不读凭证;需要这些就在这里加一个协议方法。
 *
 * **界面能做的每一件事都是这里的一个方法。** 这条不是为了整齐:agent 要能驱动画布,
 * 人也要能驱动 agent,两个方向走同一套方法才不会分叉成两个半残的产品。
 */
export interface OrcaServer {
  port: number
  bus: PushBus
  close(): Promise<void>
}

export async function startServer(
  options: {
    port?: number
    /**
     * 除 deck 目录之外还允许服务的目录。生产里就是 skill;测试用它注入一个假的。
     * 允许目录之外的引用一律 403 —— 这不是一个通用文件服务。
     */
    allowRoots?: string[]
    /** 操作记录落在哪。默认 ~/.orca-ppt/recording.jsonl;测试给一个临时文件。 */
    recordingFile?: string
  } = {},
): Promise<OrcaServer> {
  const bus = new PushBus()
  const previews = new PreviewHost()
  for (const root of options.allowRoots ?? []) await previews.allow(root)
  const openDecks = new Map<string, string>()
  /** 每份稿子的改字记录。打开过就一直在,直到进程退出 —— 见 history.ts。 */
  const histories = new Map<string, EditHistory>()
  const historyOf = (deckId: string): EditHistory => {
    let history = histories.get(deckId)
    if (!history) {
      history = new EditHistory()
      histories.set(deckId, history)
    }
    return history
  }
  /**
   * 操作记录(可录制应用约定)。每改一次稿子记一条 —— 谁改的、改了哪页、改完的版本号。
   * 回放在宿主那边,这里只报宿主看不到的:人在界面上改的、文件在外面被改的。
   */
  const recording = new RecordingLog(options.recordingFile ?? recordingFilePath())
  await recording.load()
  /** 每份稿子最近一次记下的版本号。文件监听看到的版本号和它不同,才是外面改的。 */
  const lastSeen = new Map<string, string>()
  /** 我们自己正在写的稿子:这时文件监听报的变化不是「外面改的」。 */
  const selfWriting = new Set<string>()
  /** 最近打开的那份:取缩略图没说是哪份时就用它。 */
  let lastOpened: string | undefined
  const visibleSlides = new Map<string, number>()

  const documentOf = (deckId: string) => ({ id: deckId, label: basename(deckPathOf(deckId)) })

  /** 稿子被我们改了一次,记一条。是不是经 MCP 来的决定记成人还是 agent。 */
  const recordChange = async (
    deckId: string,
    change: { summary: string; slide?: number; detail?: Record<string, unknown> },
  ) => {
    const revision = await deckRevision(deckPathOf(deckId))
    lastSeen.set(deckId, revision)
    const call = mcpCall.getStore()
    recording.append({
      actor: call ? 'agent' : 'user',
      summary: change.summary,
      document: documentOf(deckId),
      ...(change.slide !== undefined
        ? { target: { kind: 'slide', index: change.slide, label: `第 ${change.slide + 1} 页` } }
        : {}),
      revision,
      ...(call ? { tool: call.tool } : {}),
      undoable: true,
      ...(change.detail ? { detail: change.detail } : {}),
    })
  }

  /**
   * 文件监听报了变化:版本号和我们记的不一样,就是外面改的 —— agent 用自己的工具直接写了
   * HTML、人在编辑器里改了。只看得到结果,不知道是谁,记成 external。
   */
  const noticeExternal = async (deckId: string) => {
    if (selfWriting.has(deckId) || !openDecks.has(deckId)) return
    const revision = await deckRevision(deckPathOf(deckId))
    if (lastSeen.get(deckId) === revision) return
    lastSeen.set(deckId, revision)
    recording.append({
      actor: 'external',
      summary: '文件在外部被修改',
      document: documentOf(deckId),
      revision,
    })
  }

  /** 我们自己写稿子:写的这段时间里文件监听报的变化不算外面改的。 */
  const writeOwn = async (deckId: string, file: string, html: string) => {
    selfWriting.add(deckId)
    try {
      await writeFile(file, html, 'utf8')
    } finally {
      // 文件监听要攒 150ms 才报;报上来时版本号已经等于 lastSeen,会被认出是自己写的
      setTimeout(() => selfWriting.delete(deckId), 0)
    }
  }

  const announceHistory = (deckId: string) =>
    bus.broadcast('history.changed', { deckId, ...historyOf(deckId).state() })
  /** 撤销和重做是同一件事的两个方向。 */
  const stepHistory = async (deckId: string, direction: 'undo' | 'redo') => {
    const root = deckPathOf(deckId)
    const name = await findEntryName(root)
    if (!name) return { ok: false, reason: AgentError.noBuild() }
    const file = join(root, name)
    const history = historyOf(deckId)
    // 每次都重读磁盘:agent 可能刚写过,history 据此决定整份还回去还是只换那段字。
    const current = await readFile(file, 'utf8')
    const result = direction === 'undo' ? history.undo(current) : history.redo(current)
    if (!result.ok) return { ok: false, reason: result.reason }
    if (result.html !== current) await writeOwn(deckId, file, result.html)
    announceHistory(deckId)
    const { step } = result
    const text = direction === 'undo' ? step.oldText : step.newText
    await recordChange(deckId, {
      summary: `${direction === 'undo' ? '撤销' : '重做'}第 ${step.slide + 1} 页的改字,现在是「${clip(text)}」`,
      slide: step.slide,
    })
    return { ok: true, slide: step.slide, text: direction === 'undo' ? step.oldText : step.newText }
  }

  const captures = new Roundtrip<string, { slide?: number }>((payload) =>
    bus.broadcast('capture.request', payload),
  )
  // 一份稿子每页渲一张,比单张截图慢得多,给足时间。
  const thumbnails = new Roundtrip<
    Array<string | null>,
    { previewUrl: string; slideCount: number; slides?: number[]; width?: number }
  >((payload) => bus.broadcast('thumbnails.request', payload), 90_000)

  const queue = new RequestQueue((deckId, pending) =>
    bus.broadcast('requests.changed', { deckId, requests: pending }),
  )

  // 稿子变了就让画布重载 —— agent 改的和用户自己在编辑器里改的,一视同仁。
  const watcher = new DeckWatcher((deckId) => {
    void noticeExternal(deckId).catch(() => {})
    const path = openDecks.get(deckId)
    if (!path) return
    void announceDeck(deckId, path).catch(() => {
      // 稿子正被写到一半是常事,下一次事件会再来。
    })
  })

  async function announceDeck(deckId: string, path: string): Promise<OpenedDeck> {
    const opened = await openDeck(path)
    bus.broadcast('deck.changed', {
      deckId,
      slides: opened.slides,
      slideCount: opened.slideCount,
      slideTitles: opened.slideTitles,
      pageTypes: opened.pageTypes,
      // 成品第一次出现时 previewUrl 才有值,界面靠这条把画布接上。
      previewUrl: mountPreview(opened),
    })
    bus.broadcast('transition.changed', {
      deckId,
      transitions: opened.transitions,
      plan: readTransitionPlan(opened),
    })
    for (const report of await readPhaseStatus(path)) {
      bus.broadcast('phase.changed', { deckId, ...report })
    }
    return opened
  }

  /** 这个主题默认配哪套配色。主题里没有颜色,不链配色建出来的稿子是白的。 */
  function paletteFor(theme: string | undefined): string | undefined {
    return theme ? catalog.themes.find((item) => item.name === theme)?.palette : undefined
  }

  function mountPreview(opened: OpenedDeck): string {
    if (!opened.entryFile) return ''
    const plan = planPreview(opened.deck.path, opened.entryFile)
    return `http://127.0.0.1:${port}${previews.mount(plan).urlPath}`
  }

  // 稿子同一时刻只归一方动:agent 拿着时拦人(见 handle),人接管时拦 agent(见下面的 gate)。
  const control = new DeckControl((state) => bus.broadcast('control.changed', state))

  /** app 的版本。壳用 ORCA_PPT_APP_VERSION 告诉我们;单独跑 server 时退回它自己的包版本。 */
  const appVersion = process.env.ORCA_PPT_APP_VERSION ?? (await ownVersion())

  // MCP 和界面走同一个进程、同一个端口:工具调的就是界面调的那批方法。
  const mcp = new McpEndpoint(
    (method, params) => dispatch(method, params) as never,
    // agent 动了一下,界面就该看得见 —— 它是代替人执行的,做的事不该比人做的更隐蔽。
    (activity) => {
      control.observe(activity)
      bus.broadcast('mcp.activity', activity)
    },
    (tool) => control.blocksAgent(tool),
    appVersion,
  )

  const http = createHttpServer((req, res) => {
    void (async () => {
      if (await mcp.handle(req, res)) return
      if (await previews.handle(req, res)) return
      res.writeHead(404).end()
    })().catch((error: unknown) => {
      // 吞掉错误会让调试变成猜谜 —— 至少把它打出来。
      process.stderr.write(`[http] ${error instanceof Error ? error.stack : String(error)}\n`)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  const wss = new WebSocketServer({ server: http })

  wss.on('connection', (socket) => {
    const connectionId = randomUUID()
    bus.attach(connectionId, (envelope: PushEnvelope) => socket.send(JSON.stringify(envelope)))

    socket.on('message', async (raw) => {
      let envelope: RequestEnvelope
      try {
        envelope = RequestEnvelope.parse(JSON.parse(raw.toString()))
      } catch {
        // 连信封都解不出来就没有 id 可回,只能丢掉。
        return
      }
      socket.send(JSON.stringify(await handle(envelope)))
    })

    socket.on('close', () => {
      bus.detach(connectionId)
      // 界面走了就没人能截图了,挂着的别让 agent 干等。
      if (bus.connectionCount === 0) {
        captures.failAll(AgentError.uiDisconnected())
        thumbnails.failAll(AgentError.uiDisconnected())
      }
    })
  })

  // 只绑 loopback。这个 server 拥有用户的文件,不该出现在局域网上。
  await new Promise<void>((done) => http.listen(options.port ?? 0, '127.0.0.1', done))
  const port = (http.address() as AddressInfo).port
  // MCP server 是另一个进程,靠这个文件找到我们。
  await writePortFile(port)

  // skill 在哪一次解析,之后一直用。找不到也要能起来 —— 提示词里会如实说明。
  const skill = await locateSkill()
  const catalog: Catalog = await readCatalog(skill.path)
  // 词表读一次就够 —— 它跟着 skill 的文件走,和 catalog 一样。
  const vocabulary = catalog.skillPath ? readVocabulary(catalog.skillPath) : Promise.resolve([])
  const pageTypes = catalog.skillPath ? readPageTypes(catalog.skillPath) : Promise.resolve([])
  // deck 和 skill 隔得远时,稿子里的 `{{ROOT}}` 会深到把请求顶到服务器根。
  // 把 skill 目录列进 allow root,那些请求就还能服务到。
  await previews.allow(catalog.skillPath)

  function deckPathOf(deckId: string): string {
    const path = openDecks.get(deckId)
    if (!path) throw new Error(AgentError.deckNotOpen())
    return path
  }

  /**
   * 界面发来的请求。MCP 不走这里,它直接调 dispatch —— 所以「是人还是 agent」在这一层
   * 天然分得开,拦截放在协议层而不只是把按钮置灰:菜单里的 ⌘Z、以后别的客户端,都一样拦得住。
   */
  /**
   * 录制要的缩略图:被改的那一页(没有记录就第 1 页),**离屏渲** —— 用的是页胶片那套隐藏窗口,
   * 不翻用户眼前的画布。宿主每条事件之后都来取一张,人正在编辑时画面不能被来回拖。
   * 只渲得了当前版本:旧版本的内容没存,要旧的就 REVISION_UNAVAILABLE,宿主用当时记下的那张。
   */
  async function snapshot(params: {
    document?: string | undefined
    revision?: string | undefined
    maxSize?: number | undefined
  }) {
    const unavailable = (why: string) => ({ ok: false, reason: `REVISION_UNAVAILABLE:${why}` })
    const deckId = params.document ?? lastOpened
    if (!deckId || !openDecks.has(deckId)) return unavailable('这份稿子没有打开')
    const root = deckPathOf(deckId)
    const revision = await deckRevision(root)
    if (params.revision && params.revision !== revision) {
      return unavailable('只渲得了当前版本;旧版本请用当时记下的缩略图')
    }
    const opened = await openDeck(root)
    const previewUrl = mountPreview(opened)
    if (!previewUrl || opened.slideCount === 0) return unavailable('这份稿子还没有出稿文件')
    if (bus.connectionCount === 0) return unavailable('应用界面没开,渲不了缩略图')

    const slide = Math.min(recording.lastFor(deckId)?.target?.index ?? 0, opened.slideCount - 1)
    const width = Math.min(params.maxSize ?? 640, 1280)
    let path: string | null | undefined
    try {
      ;[path] = await thumbnails.request(deckId, {
        previewUrl,
        slideCount: opened.slideCount,
        slides: [slide],
        width,
      })
    } catch (cause) {
      return unavailable(cause instanceof Error ? cause.message : '渲不出来')
    }
    if (!path) return unavailable('这一页渲不出来')
    const bytes = await readFile(path)
    // 报图片的真实尺寸,不按比例推:推出来的和实际对不上时,宿主拿到的元信息就是错的
    const size = pngSize(bytes) ?? { width, height: Math.round((width * 9) / 16) }
    return {
      ok: true,
      image: bytes.toString('base64'),
      mimeType: path.endsWith('.jpg') ? ('image/jpeg' as const) : ('image/png' as const),
      document: documentOf(deckId),
      revision,
      ...size,
      target: { kind: 'slide', index: slide, label: `第 ${slide + 1} 页` },
    }
  }

  async function handle(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    if (envelope.method === 'deck.navigation' && control.blocksHuman()) {
      return { id: envelope.id, ok: false, error: { message: control.blocksHuman()! } }
    }
    const reason = HUMAN_EDITS.has(envelope.method) ? control.blocksHuman() : undefined
    if (reason) {
      // 按「没办成」答,不按出错:界面本来就会把 reason 摆到人刚才动的那处。
      return { id: envelope.id, ok: true, data: { ok: false, reason } }
    }
    try {
      return { id: envelope.id, ok: true, data: await dispatch(envelope.method, envelope.params) }
    } catch (error) {
      return {
        id: envelope.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  async function dispatch(method: RequestMethod, raw: unknown): Promise<unknown> {
    if (mcpCall.getStore() && ['deck.editText', 'deck.undo', 'deck.redo'].includes(method)) {
      const target = (raw as { deckId?: string }).deckId
      if (target !== lastOpened)
        throw new Error('DOCUMENT_CHANGED: 当前稿子已经切换，请重新读取状态。')
    }
    switch (method) {
      case 'skill.list': {
        const params = parseParams('skill.list', raw)
        return listSkill(catalog.skillPath, params.path, params.offset)
      }
      case 'skill.read': {
        const params = parseParams('skill.read', raw)
        return readSkill(catalog.skillPath, params.path, params.offset)
      }
      case 'deck.current': {
        parseParams('deck.current', raw)
        return lastOpened
          ? {
              deckId: lastOpened,
              ...(visibleSlides.has(lastOpened) ? { slide: visibleSlides.get(lastOpened) } : {}),
            }
          : {}
      }
      case 'deck.visibleSlide': {
        const params = parseParams('deck.visibleSlide', raw)
        deckPathOf(params.deckId)
        if (params.deckId === lastOpened) visibleSlides.set(params.deckId, params.index)
        return {}
      }
      case 'deck.navigation': {
        const params = parseParams('deck.navigation', raw)
        deckPathOf(params.deckId)
        if (params.deckId !== lastOpened)
          throw new Error('DOCUMENT_CHANGED: 当前稿子已经切换，请重新读取状态。')
        if (params.action === 'replay' && params.from === undefined)
          throw new Error('重放需要 from 页号')
        bus.broadcast('autoplay.changed', { deckId: params.deckId, on: false })
        bus.broadcast('deck.navigation', params)
        return {}
      }
      case 'deck.list': {
        parseParams('deck.list', raw)
        // 当前开着的那些。MCP 靠它回退:人已经在应用里开着 deck 了,agent 不该被迫再开一次。
        const decks = await Promise.all(
          [...openDecks.values()].map(async (path) => (await openDeck(path)).deck),
        )
        return { decks }
      }
      case 'deck.open': {
        const params = parseParams('deck.open', raw)
        const opened = await openDeck(params.path)

        openDecks.set(opened.deck.id, opened.deck.path)
        watcher.watch(opened.deck.id, opened.deck.path)
        if (lastOpened !== opened.deck.id) visibleSlides.delete(opened.deck.id)
        lastOpened = opened.deck.id
        // 打开时的版本号是基准:之后文件监听看到不一样的,才算外面改的
        if (!lastSeen.has(opened.deck.id)) {
          lastSeen.set(opened.deck.id, await deckRevision(opened.deck.path))
        }
        // 记一笔「最近用过这个主题」—— 选择器上最有用的那个标签(派生的,见 recent.ts)。
        // 读不出主题或者写不进去都不管:少一个标签,不值得让打开稿子这件事失败。
        const theme = opened.entryFile
          ? themeOf(await readFile(opened.entryFile, 'utf8').catch(() => ''))
          : undefined
        // 记一笔「最近用过这个主题」—— 选择器上最有用的那个标签(派生的,见 recent.ts)。
        // 写不进去也不管:少一个标签,不值得让打开稿子这件事失败。
        if (theme) void noteThemeUsed(theme)
        // 界面要跟着开。agent 开了稿子而人的窗口还停在原地的话,画布没加载,
        // 它接着调 capture_slide 就只会等到超时。
        bus.broadcast('deck.opened', { deckId: opened.deck.id, path: opened.deck.path })

        return {
          deck: opened.deck,
          slides: opened.slides,
          transitions: opened.transitions,
          slideCount: opened.slideCount,
          slideTitles: opened.slideTitles,
          pageTypes: opened.pageTypes,
          transitionPlan: readTransitionPlan(opened),
          phases: await readPhaseStatus(opened.deck.path),
          previewUrl: mountPreview(opened),
          ...(theme ? { theme } : {}),
        }
      }
      case 'deck.create': {
        const params = parseParams('deck.create', raw)
        const path = join(params.parentDir, slugify(params.title))

        if (params.from) {
          if (!catalog.skillPath) throw new Error(AgentError.skillNotFound())
          await instantiate({
            skillPath: catalog.skillPath,
            templateId: params.from,
            targetDir: path,
            title: params.title,
            ...(params.theme ? { theme: params.theme } : {}),
            // 主题文件里没有颜色,配色得一起链上 —— 不然建出来的稿子是没颜色的。
            ...(paletteFor(params.theme) ? { palette: paletteFor(params.theme)! } : {}),
          })
        } else {
          await mkdir(join(path, '.deck'), { recursive: true })
        }
        return { path }
      }
      case 'catalog.templates': {
        parseParams('catalog.templates', raw)
        return { templates: await listTemplates(catalog.skillPath) }
      }
      case 'deck.showSlide': {
        const params = parseParams('deck.showSlide', raw)
        deckPathOf(params.deckId)
        bus.broadcast('deck.slide', { deckId: params.deckId, index: params.index })
        return {}
      }
      case 'deck.editText': {
        const params = parseParams('deck.editText', raw)
        const root = deckPathOf(params.deckId)
        const name = await findEntryName(root)
        if (!name) return { ok: false, reason: AgentError.noBuild() }

        const file = join(root, name)
        // 每次都重读磁盘:agent 可能刚写过。旧文字对不上时下面会拒绝,这正是我们要的。
        const html = await readFile(file, 'utf8')
        const result = applyTextEdit(html, {
          slide: params.slide,
          oldText: params.oldText,
          newText: params.newText,
        })
        if (!result.ok) return { ok: false, reason: result.reason }
        if (result.html !== html) {
          await writeOwn(params.deckId, file, result.html)
          historyOf(params.deckId).record({
            slide: params.slide,
            oldText: params.oldText.trim(),
            newText: params.newText.trim(),
            before: html,
            after: result.html,
          })
          announceHistory(params.deckId)
          await recordChange(params.deckId, {
            summary: `把第 ${params.slide + 1} 页的「${clip(params.oldText)}」改成「${clip(params.newText)}」`,
            slide: params.slide,
            detail: { oldText: params.oldText.trim(), newText: params.newText.trim() },
          })
        }
        // 不用在这儿广播:文件一变,看稿子的 watcher 自己会推 deck.changed。
        return { ok: true }
      }
      case 'deck.undo': {
        const params = parseParams('deck.undo', raw)
        return stepHistory(params.deckId, 'undo')
      }
      case 'deck.redo': {
        const params = parseParams('deck.redo', raw)
        return stepHistory(params.deckId, 'redo')
      }
      case 'deck.history': {
        const params = parseParams('deck.history', raw)
        deckPathOf(params.deckId)
        return historyOf(params.deckId).state()
      }
      case 'control.state': {
        parseParams('control.state', raw)
        return control.state()
      }
      case 'control.take': {
        const params = parseParams('control.take', raw)
        return control.take(params.reason, params.waiting)
      }
      case 'control.handOff': {
        const params = parseParams('control.handOff', raw)
        return control.handOff(params.message)
      }
      case 'control.takeOver': {
        parseParams('control.takeOver', raw)
        return control.takeOver()
      }
      case 'control.stop': {
        parseParams('control.stop', raw)
        return control.stop()
      }
      case 'control.release': {
        parseParams('control.release', raw)
        return control.release()
      }
      case 'artifact.path': {
        const params = parseParams('artifact.path', raw)
        const root = deckPathOf(params.deckId)
        // 出稿的产物是这份 deck 实际的入口文件(可能叫 index.html)。还没出稿时
        // 给出它将来会落在哪。
        const name =
          params.phase === 'build'
            ? ((await findEntryName(root)) ?? artifactPath.build)
            : artifactPath[params.phase]
        return { path: join(root, name) }
      }
      case 'phase.prompt': {
        const params = parseParams('phase.prompt', raw)
        return phaseGate(deckPathOf(params.deckId), params.phase, {
          request: params.request,
          skillPath: catalog.skillPath,
          themes: catalog.themes.map((theme) => theme.name),
        })
      }
      case 'phase.check': {
        const params = parseParams('phase.check', raw)
        const all = await readPhaseStatus(deckPathOf(params.deckId))
        return { phases: params.phase ? all.filter((row) => row.phase === params.phase) : all }
      }
      case 'deck.inspect': {
        const params = parseParams('deck.inspect', raw)
        const root = deckPathOf(params.deckId)
        const name = await findEntryName(root)
        // 每次都重读磁盘,和 deck.editText 一样:agent 可能刚写过。
        const html = name ? await readFile(join(root, name), 'utf8') : ''
        const titles = readSlideTitles(html)
        const pageTypes = readSlidePageTypes(html)
        return {
          revision: await deckRevision(root),
          slides: readSlideTexts(html).map((texts, index) => ({
            index,
            title: titles[index] ?? null,
            pageType: pageTypes[index] ?? null,
            texts,
          })),
        }
      }
      case 'deck.capture': {
        const params = parseParams('deck.capture', raw)
        deckPathOf(params.deckId)
        // 界面不在就立刻说,别让 agent 干等 15 秒超时
        if (bus.connectionCount === 0) throw new Error(AgentError.uiDisconnected())
        return {
          path: await captures.request(params.deckId, {
            ...(params.slide === undefined ? {} : { slide: params.slide }),
          }),
        }
      }
      case 'capture.result': {
        const params = parseParams('capture.result', raw)
        // 界面待会儿要显示它,放行这一个文件 —— 见 PreviewHost.allowFile。
        previews.allowFile(params.path)
        captures.settle(params.requestId, { value: params.path, error: params.error })
        return {}
      }
      case 'deck.present': {
        const params = parseParams('deck.present', raw)
        const opened = await openDeck(deckPathOf(params.deckId))
        const previewUrl = mountPreview(opened)
        if (!previewUrl) throw new Error(AgentError.noBuild())

        bus.broadcast('present.request', {
          deckId: params.deckId,
          previewUrl,
          slide: params.slide ?? 0,
        })
        return {}
      }
      case 'deck.autoplay': {
        const params = parseParams('deck.autoplay', raw)
        deckPathOf(params.deckId)
        bus.broadcast('autoplay.changed', { deckId: params.deckId, on: params.on })
        return {}
      }
      case 'app.doctor': {
        parseParams('app.doctor', raw)
        return {
          app: { version: appVersion },
          server: { port, mcp: `http://127.0.0.1:${port}/mcp` },
          skill,
          ui: { connected: bus.connectionCount > 0, connections: bus.connectionCount },
          decks: [...openDecks.keys()].map(documentOf),
          recording: { file: recording.path, events: recording.size },
        }
      }
      case 'recording.events': {
        const params = parseParams('recording.events', raw)
        return {
          version: 1 as const,
          ...recording.since(params.after, params.limit ?? 200),
          // 版本号是内容哈希(deckRevision):改了又改回去,版本号也回得去
          revisionIsContentHash: true,
        }
      }
      case 'recording.snapshot': {
        return snapshot(parseParams('recording.snapshot', raw))
      }
      case 'deck.thumbnails': {
        const params = parseParams('deck.thumbnails', raw)
        const opened = await openDeck(deckPathOf(params.deckId))
        const previewUrl = mountPreview(opened)
        if (!previewUrl) return { paths: [] }

        return {
          paths: await thumbnails.request(params.deckId, {
            previewUrl,
            slideCount: opened.slideCount,
          }),
        }
      }
      case 'thumbnails.result': {
        const params = parseParams('thumbnails.result', raw)
        for (const path of params.paths ?? []) previews.allowFile(path ?? undefined)
        thumbnails.settle(params.requestId, { value: params.paths, error: params.error })
        return {}
      }
      case 'catalog.list': {
        parseParams('catalog.list', raw)
        /*
         * 「最近使用」**不是标签**,所以不混进主题的 tags,单独一个字段。
         *
         * 标签写在文件里、由词表管着、由维护者决定;最近使用是系统从使用记录算出来的,
         * 谁都没「决定」过它。塞进 tags 就等于说它是这个主题的一个属性 —— 它不是,
         * 它是这批主题的一个视图,今天有明天就没了。
         *
         * 也因此它必须**每次请求现算**:catalog 是启动时读一次就缓存的(跟着文件走)。
         */
        return {
          ...catalog,
          tags: await vocabulary,
          pages: await pageTypes,
          recent: await readRecentThemes(),
        }
      }
      case 'requests.add': {
        const params = parseParams('requests.add', raw)
        deckPathOf(params.deckId)
        return { id: queue.add(params.deckId, params) }
      }
      case 'requests.list': {
        const params = parseParams('requests.list', raw)
        return { requests: queue.list(params.deckId) }
      }
      case 'requests.take': {
        const params = parseParams('requests.take', raw)
        return { requests: queue.take(params.deckId) }
      }
      case 'requests.remove': {
        const params = parseParams('requests.remove', raw)
        queue.remove(params.deckId, params.id)
        return {}
      }
    }
  }

  return {
    port,
    bus,
    close: async () => {
      watcher.closeAll()
      control.close()
      await recording.flush()
      await mcp.close()
      await clearPortFile()
      await new Promise<void>((done) => {
        wss.close()
        http.close(() => done())
      })
    },
  }
}

/**
 * 没有壳告诉我们版本时(开发、单独跑 server):用 server 自己的包版本加 `-dev`。
 * 一眼看得出不是发布版 —— doctor 和握手报出来的版本号,宿主是要拿去判断兼容的。
 */
async function ownVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return `${pkg.version ?? '0.0.0'}-dev`
  } catch {
    return '0.0.0-dev'
  }
}

/** PNG 的宽高在 IHDR 里(第 16–24 字节)。不是 PNG(比如换成了 JPEG)就返回 undefined。 */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 事件摘要里引用原文时截短:一句人话,不是全文。 */
function clip(text: string, max = 24): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * agent 拿着稿子时,界面发来的这几个一律拒绝:它们都会改磁盘上的稿子。
 * 翻页、放映、指给 agent 看不在里面 —— 那些不改稿子,人随时能做。
 */
const HUMAN_EDITS = new Set<RequestMethod>(['deck.editText', 'deck.undo', 'deck.redo'])

/** 目录名。中文标题原样留着,只把路径里不能用的字符换掉。 */
function slugify(title: string): string {
  const cleaned = title.trim().replace(/[/\\:*?"<>|]/g, '-')
  return cleaned || `deck-${Date.now()}`
}
