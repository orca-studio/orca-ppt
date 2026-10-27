import {
  applyPlanEdit,
  applyTextEdit,
  changedPages,
  deckRevision,
  deckSnapshot,
  editPages,
  findEntryName,
  instantiate,
  instantiateSample,
  listRecipes,
  listTemplates,
  openDeck,
  type OpenedDeck,
  phaseGate,
  readPage,
  readPageTypes as readSlidePageTypes,
  readPhaseStatus,
  readSlideTexts,
  readSlideTitles,
  recipeEntry,
  type RecipeSource,
  type Renderer,
  replaceImage,
  writePage,
} from '@orca-ppt/deck-core'
import { noRenderer } from './renderer-port.js'
import { allowClient, serveWeb } from './web-host.js'
import { readSpec } from '@orca-ppt/deck-agent'
import { pageMetadata } from './page-metadata.js'
import { readEditFile, writeEditFiles, type FileChanges } from './edit-files.js'
import { listSkill, readSkill } from './skill-content.js'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile, realpath, stat } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, isAbsolute, extname } from 'node:path'
import {
  CanvasEvidence,
  PptxExportReport,
  requests,
  RequestEnvelope,
  type RequestParams,
  type RequestResult,
  artifactPath,
  type PushEnvelope,
  type PushData,
  type RequestMethod,
  type ResponseEnvelope,
  parseParams,
  type UiTargetQuery,
  type UiTargetList,
  type UiTargets,
} from '@orca-ppt/contracts'
import { WebSocketServer } from 'ws'
import { Roundtrip } from './roundtrip.js'
import { pptxExportDir, pptxTargetProblem, summarizePptx } from './pptx.js'
import {
  dropPartial,
  partialDir,
  readThumbnails,
  storeThumbnails,
  thumbnailSlot,
} from './thumbnail-cache.js'
import { DeckWatcher } from './deck-watch.js'
import { DeckControl } from './control.js'
import { EditHistory } from './history.js'
import { noteThemeUsed, readRecentThemes, themeOf } from './recent.js'
import { McpEndpoint } from './mcp-http.js'
import { mcpCall } from './mcp-origin.js'
import { AgentError } from './agent-errors.js'
import { RecordingLog, recordingFilePath } from './recording.js'
import { planPreview } from './preview.js'
import { PreviewHost } from './preview-host.js'
import { clearPortFile, writePortFile } from './port-file.js'
import { PushBus } from './push-bus.js'
import { RequestQueue } from './requests-queue.js'
import { readCatalog, readPageTypes, readVocabulary, locateSkill, type Catalog } from './skill.js'
import { dropOldPreviews } from './recipe-preview.js'
import { readTransitionPlan } from './transitions.js'
import { planEditSummary, textEditSummary, textStepSummary } from './change-summary.js'

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
    /**
     * 缩略图、导出 PPTX 找谁渲。桌面版是主进程的隐藏窗口(见 renderer-port.ts),
     * 测试给一个假的;不给就一律报 NO_RENDERER。
     */
    renderer?: Renderer
    /** 托管界面的目录(`orca-ppt serve`)。不给就不托管 —— 桌面版从本地文件加载界面。 */
    webRoot?: string
    /** 启动 token。给了,浏览器发来的 WebSocket 连接就必须带对它(见 web-host.ts 的 allowClient)。 */
    token?: string
  } = {},
): Promise<OrcaServer> {
  const bus = new PushBus()
  const renderer = options.renderer ?? noRenderer
  const previews = new PreviewHost()
  for (const root of options.allowRoots ?? []) await previews.allow(root)
  const openDecks = new Map<string, string>()
  /** 只读的稿子(目录在 skill 里)。写操作在 dispatch 里统一拒。 */
  const readOnlyDecks = new Set<string>()
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
  /** 每份稿子最后一次让画布到达的那一版(源码和素材摘要)。下一版只差几页时就让画布就地换页。 */
  const shown = new Map<string, Awaited<ReturnType<typeof deckSnapshot>>>()
  const shownTails = new Map<string, Promise<void>>()
  /** 我们自己正在写的稿子:这时文件监听报的变化不是「外面改的」。 */
  const selfWriting = new Set<string>()
  /** 最近打开的那份:取缩略图没说是哪份时就用它。 */
  let lastOpened: string | undefined
  const visibleSlides = new Map<string, number>()

  const documentOf = (deckId: string) => ({ id: deckId, label: basename(deckPathOf(deckId)) })

  /**
   * agent 刚改了一处:让画布跟过去,量出那一处的屏幕位置。
   *
   * 在改稿子的串行队列里等它(见 dispatch 的 editTails),所以并发发来的几十条改动会一条一条
   * 显示出来 —— 不等的话几十毫秒就改完了,画布还停在第 1 页,录屏里什么也看不出。
   * 界面没开、没跟上都不算这次改动失败:字已经写进去了,只是回执和操作记录里少了位置。
   */
  const follow = async (
    deckId: string,
    revision: string,
    show: { slide?: number; text?: string; selector?: string; label?: string },
  ): Promise<UiTargets | undefined> => {
    if (bus.connectionCount === 0) return undefined
    try {
      return await follows.request(deckId, {
        path: deckPathOf(deckId),
        revision,
        ...(show.slide !== undefined ? { slide: show.slide } : {}),
        ...(show.text ? { text: show.text } : {}),
        ...(show.selector ? { selector: show.selector } : {}),
        ...(show.label ? { label: show.label } : {}),
      })
    } catch {
      return undefined
    }
  }

  /**
   * 稿子被我们改了一次,记一条。是不是经 MCP 来的决定记成人还是 agent。
   * agent 的改动还要让画布跟过去(见 follow);返回量到的位置。
   * 撤销、重做谁发起的都跟过去(`follow`):撤掉的可能不是眼前这页,人得看见动的是哪儿。
   */
  const recordChange = async (
    deckId: string,
    change: {
      summary: string
      slide?: number
      detail?: Record<string, unknown>
      /**
       * 画布上框哪一处:改完之后的文字,或者页内选择器。都没有就框整页。
       * `label` 是框上的小标签,说在做什么。
       */
      show?: { text?: string; selector?: string; label?: string }
      /** 不是 agent 改的也让画布跟过去 */
      follow?: boolean
    },
  ): Promise<UiTargetList | undefined> => {
    const revision = await deckRevision(deckPathOf(deckId))
    lastSeen.set(deckId, revision)
    const call = mcpCall.getStore()
    const measured =
      call || change.follow
        ? await follow(deckId, revision, {
            ...(change.slide !== undefined ? { slide: change.slide } : {}),
            ...change.show,
          })
        : undefined
    // 回执和记录里每一项自带量的时刻;一项都没有(比如转场计划不在页上)就不带
    const uiTargets = measured?.targets.length
      ? measured.targets.map((target) => ({ ...target, measuredAt: measured.measuredAt }))
      : undefined
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
      ...(uiTargets ? { uiTargets } : {}),
    })
    return uiTargets
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

  const writeChanges = async (deckId: string, changes: FileChanges) => {
    selfWriting.add(deckId)
    try {
      await writeEditFiles(deckPathOf(deckId), changes)
    } finally {
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
    const history = historyOf(deckId)
    // 每次都重读磁盘:agent 可能刚写过,history 据此决定整份还回去还是只换那段字。
    const current = await readEditFile(root, name)
    if (current === null) return { ok: false, reason: AgentError.noBuild() }
    const pending = history.peek(direction)
    const files: Record<string, string | null> = {}
    for (const path of Object.keys(pending?.files ?? {}))
      files[path] = await readEditFile(root, path)
    const result =
      direction === 'undo'
        ? history.undo(current, files, false)
        : history.redo(current, files, false)
    if (!result.ok) return { ok: false, reason: result.reason }
    const changes: FileChanges = { [name]: { before: current, after: result.html } }
    for (const [path, values] of Object.entries(result.step.files ?? {})) {
      changes[path] = {
        before: files[path]!,
        after: direction === 'undo' ? values.before : values.after,
      }
    }
    await writeChanges(deckId, changes)
    // 撤销改字、撤销换图都只动了那一页:就地换掉,不等 watcher 推 deck.changed 整份重载
    await patchCanvas(deckId, root)
    history.commit(direction)
    announceHistory(deckId)
    const { step } = result
    const text = direction === 'undo' ? step.oldText : step.newText
    const slide = direction === 'undo' ? (step.undoSlide ?? step.slide) : step.slide
    // 先让界面拿到新的页数和转场,画布跟过去时才对得上
    if (step.label) await announceDeck(deckId, root)
    const uiTargets = await recordChange(deckId, {
      summary: step.label
        ? `${direction === 'undo' ? '撤销' : '重做'}${step.label}`
        : textStepSummary(direction, step.slide),
      slide,
      show: {
        label: direction === 'undo' ? '撤销' : '重做',
        ...(step.label ? {} : { text: text.trim() }),
      },
      follow: true,
    })
    return {
      ok: true,
      slide,
      ...(step.label ? {} : { text }),
      ...(uiTargets ? { uiTargets } : {}),
    }
  }

  // 只量位置,界面答得很快;慢了说明它卡住了,宿主宁可这次不画框
  const uiTargetRequests = new Roundtrip<UiTargets, { queries: UiTargetQuery[] }>(
    ({ deckId: _deckId, ...payload }) => bus.broadcast('ui.targets.request', payload),
    2000,
  )
  // 要等画布重载出新版本再翻页、点亮:比量位置慢得多
  const follows = new Roundtrip<UiTargets, Omit<PushData<'edit.follow'>, 'deckId' | 'requestId'>>(
    (payload) => bus.broadcast('edit.follow', payload),
    8000,
  )
  type CanvasPush = PushData<'canvas.request'>
  const canvases = new Roundtrip<
    CanvasEvidence,
    | Omit<Extract<CanvasPush, { action: 'inspect' }>, 'deckId' | 'requestId'>
    | Omit<Extract<CanvasPush, { action: 'select' }>, 'deckId' | 'requestId'>
  >((payload) => bus.broadcast('canvas.request', payload))
  const captures = new Roundtrip<
    RequestResult<'deck.capture'>,
    { slide?: number; expectedRevision?: string }
  >((payload) => bus.broadcast('capture.request', payload))

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

  /**
   * 把画布带到磁盘上这一版,能不重载就不重载:推 `deck.patched` 让它只换一段字(`text`,
   * 只在画布正停在改之前那一版时)、只换变了的几页、或者只认版本(变的在画面之外)。
   * 结构变了(增删页、页外的东西、素材)就什么都不推,交给随后的 `deck.changed` 整份重载。
   * 按稿子排队:两次读盘交错的话,先读到的旧版会盖掉后读到的新版。
   */
  function patchCanvas(
    deckId: string,
    root: string,
    edit?: { before: string; text: NonNullable<PushData<'deck.patched'>['text']> },
  ): Promise<void> {
    const run = async () => {
      const next = await deckSnapshot(root)
      const prev = shown.get(deckId)
      shown.set(deckId, next)
      if (!prev || prev.revision === next.revision) return
      if (!prev.entry || !next.entry || prev.entry.file !== next.entry.file) return
      if (prev.assets !== next.assets) return
      const base = { deckId, before: prev.revision, revision: next.revision }
      if (edit && edit.before === prev.revision) {
        bus.broadcast('deck.patched', { ...base, text: edit.text })
        return
      }
      const sections = changedPages(prev.entry.html, next.entry.html)
      if (sections)
        bus.broadcast('deck.patched', { ...base, ...(sections.length ? { sections } : {}) })
    }
    const tail = (shownTails.get(deckId) ?? Promise.resolve()).then(run, run)
    shownTails.set(
      deckId,
      tail.catch(() => {}),
    )
    return tail
  }

  async function announceDeck(deckId: string, path: string): Promise<OpenedDeck> {
    await patchCanvas(deckId, path)
    const opened = await openDeck(path)
    bus.broadcast('deck.changed', {
      deckId,
      revision: await deckRevision(path),
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
    for (const report of await readPhaseStatus(path, await spec)) {
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
      if (options.webRoot && (await serveWeb(options.webRoot, req, res))) return
      res.writeHead(404).end()
    })().catch((error: unknown) => {
      // 吞掉错误会让调试变成猜谜 —— 至少把它打出来。
      process.stderr.write(`[http] ${error instanceof Error ? error.stack : String(error)}\n`)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  const wss = new WebSocketServer({
    server: http,
    verifyClient: (info: { origin: string; req: { url?: string | undefined } }) =>
      allowClient(options.token, info.origin || undefined, info.req.url),
  })
  // ws 会把 http server 的 error 原样再发一遍;监听失败已经在下面 listen 那里报出去了,
  // 这里不接的话同一个错误会变成进程级的未捕获异常
  wss.on('error', () => {})

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
        uiTargetRequests.failAll(AgentError.uiDisconnected())
        follows.failAll(AgentError.uiDisconnected())
        captures.failAll(AgentError.uiDisconnected())
        canvases.failAll(AgentError.uiDisconnected())
      }
    })
  })

  // 只绑 loopback。这个 server 拥有用户的文件,不该出现在局域网上。
  // 端口被占要报出来(serve 据此说人话),不能变成进程级的未捕获异常
  await new Promise<void>((done, fail) => {
    http.once('error', fail)
    http.listen(options.port ?? 0, '127.0.0.1', () => {
      http.off('error', fail)
      done()
    })
  })
  const port = (http.address() as AddressInfo).port
  // MCP server 是另一个进程,靠这个文件找到我们。
  await writePortFile(port)

  // skill 在哪一次解析,之后一直用。找不到也要能起来 —— 提示词里会如实说明。
  const skill = await locateSkill()
  const catalog: Catalog = await readCatalog(skill.path)
  // 词表读一次就够 —— 它跟着 skill 的文件走,和 catalog 一样。
  const vocabulary = catalog.skillPath ? readVocabulary(catalog.skillPath) : Promise.resolve([])
  const pageTypes = catalog.skillPath ? readPageTypes(catalog.skillPath) : Promise.resolve([])
  // 出稿检查的规范数字(skill 的 runtime/spec.json)。读不到就跳过坐标检查,不自己编一份
  const spec = readSpec(catalog.skillPath)
  // deck 和 skill 隔得远时,稿子里的 `{{ROOT}}` 会深到把请求顶到服务器根。
  // 把 skill 目录列进 allow root,那些请求就还能服务到。
  await previews.allow(catalog.skillPath)
  // 旧版本在首页现录的样片缓存,现在封面跟着同款放在 skill 里了,清掉一次
  void dropOldPreviews()

  /** 稿子目录在不在 skill 里。两边都 realpath 再比 —— 软链路径(/tmp → /private/tmp)这里踩过。 */
  async function insideSkill(path: string): Promise<boolean> {
    if (!catalog.skillPath) return false
    const [root, target] = await Promise.all([
      realpath(catalog.skillPath).catch(() => undefined),
      realpath(path).catch(() => undefined),
    ])
    if (!root || !target) return false
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  /** 这个目录是不是某个同款的样稿目录。 */
  async function recipeAt(path: string) {
    const target = await realpath(path).catch(() => undefined)
    if (!target || !catalog.skillPath) return undefined
    for (const recipe of await listRecipes(catalog.skillPath)) {
      // 样稿可能在配方目录里,也可能是 sample 指向的示例目录
      const found = await recipeEntry(catalog.skillPath, recipe.id)
      const dir = found ? await realpath(found.dir).catch(() => '') : ''
      if (dir === target) return recipe
    }
    return undefined
  }

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

    const slide = Math.min(recording.lastFor(deckId)?.target?.index ?? 0, opened.slideCount - 1)
    const width = Math.min(params.maxSize ?? 640, 1280)
    let path: string | null | undefined
    try {
      ;[path] = await renderer.thumbnails({
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

  const editTails = new Map<string, Promise<unknown>>()
  async function dispatch(method: RequestMethod, raw: unknown): Promise<unknown> {
    if (!HUMAN_EDITS.has(method)) return dispatchUnlocked(method, raw)
    const key = (raw as { deckId?: string } | null)?.deckId ?? ''
    // 只读稿子:和「agent 拿着」一样按没办成答,界面会把理由摆到人刚才动的那处
    if (readOnlyDecks.has(key)) return { ok: false, reason: AgentError.readOnly() }
    const previous = editTails.get(key) ?? Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(() => {
        const blocked = mcpCall.getStore()
          ? control.blocksAgent(mcpCall.getStore()!.tool)
          : control.blocksHuman()
        if (blocked) return { ok: false, reason: blocked }
        return dispatchUnlocked(method, raw)
      })
    editTails.set(key, pending)
    try {
      return await pending
    } finally {
      if (editTails.get(key) === pending) editTails.delete(key)
    }
  }

  async function dispatchUnlocked(method: RequestMethod, raw: unknown): Promise<unknown> {
    if (mcpCall.getStore() && HUMAN_EDITS.has(method)) {
      const target = (raw as { deckId?: string }).deckId
      if (target !== lastOpened)
        throw new Error('DOCUMENT_CHANGED: 当前稿子已经切换，请重新读取状态。')
    }
    switch (method) {
      case 'canvas.inspect':
      case 'canvas.select': {
        const params =
          method === 'canvas.inspect'
            ? parseParams('canvas.inspect', raw)
            : parseParams('canvas.select', raw)
        const root = deckPathOf(params.deckId)
        if (params.deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED')
        if (method === 'canvas.select') {
          const blocked = mcpCall.getStore()
            ? control.blocksAgent('select_element')
            : control.blocksHuman()
          if (blocked) throw new Error(blocked)
        }
        if (bus.connectionCount === 0) throw new Error(AgentError.uiDisconnected())
        const revision = await deckRevision(root)
        if (params.expectedRevision && params.expectedRevision !== revision)
          throw new Error('STALE_REVISION: 稿子已改变，请重新读取画布。')
        const command =
          'selector' in params
            ? { ...params, action: 'select' as const }
            : { ...params, action: 'inspect' as const }
        const { deckId, ...query } = command
        const evidence = CanvasEvidence.parse(await canvases.request(deckId, query))
        if (deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED')
        const latest = await deckRevision(root)
        if (params.expectedRevision && latest !== params.expectedRevision)
          throw new Error('STALE_REVISION: 检视过程中稿子已改变，请重新读取画布。')
        if (params.expectedRevision && (!evidence.ready || evidence.renderedRevision !== latest))
          throw new Error('RENDER_NOT_READY: 画布尚未确认目标版本。')
        return requests[method].result.parse({
          ...evidence,
          deckId,
          revision: latest,
          current: evidence.ready && evidence.renderedRevision === latest,
        })
      }
      case 'canvas.result': {
        const params = parseParams('canvas.result', raw)
        canvases.settle(params.requestId, { value: params.evidence, error: params.error })
        return {}
      }
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
        if (
          (params.action === 'replay' || params.action === 'replayPage') &&
          params.from === undefined
        )
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
        const opened = await openDeck(expandHome(params.path))

        openDecks.set(opened.deck.id, opened.deck.path)
        const readOnly = await insideSkill(opened.deck.path)
        if (readOnly) readOnlyDecks.add(opened.deck.id)
        else readOnlyDecks.delete(opened.deck.id)
        watcher.watch(opened.deck.id, opened.deck.path)
        // 界面接着会加载这一版:之后的改动跟它比
        shown.set(opened.deck.id, await deckSnapshot(opened.deck.path))
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

        // 同款样稿的目录名是 id(recap-credits),标题用配方里给人看的那个
        const recipe = readOnly ? await recipeAt(opened.deck.path) : undefined
        return {
          deck: recipe ? { ...opened.deck, title: recipe.title } : opened.deck,
          slides: opened.slides,
          transitions: opened.transitions,
          slideCount: opened.slideCount,
          slideTitles: opened.slideTitles,
          pageTypes: opened.pageTypes,
          transitionPlan: readTransitionPlan(opened),
          phases: await readPhaseStatus(opened.deck.path, await spec),
          previewUrl: mountPreview(opened),
          ...(theme ? { theme } : {}),
          ...(readOnly ? { readOnly } : {}),
        }
      }
      case 'deck.close': {
        const params = parseParams('deck.close', raw)
        openDecks.delete(params.deckId)
        readOnlyDecks.delete(params.deckId)
        watcher.unwatch(params.deckId)
        shown.delete(params.deckId)
        if (lastOpened === params.deckId) lastOpened = undefined
        bus.broadcast('deck.closed', { deckId: params.deckId })
        return {}
      }
      case 'deck.create': {
        const params = parseParams('deck.create', raw)
        const path = join(expandHome(params.parentDir ?? DEFAULT_DECKS_DIR), slugify(params.title))

        if (params.from?.startsWith('recipe:')) {
          // 做同款:从同款的样稿起头,主题和配色沿用样稿的
          const sample = await recipeEntry(catalog.skillPath, params.from.slice('recipe:'.length))
          if (!sample) throw new Error(`不认识的同款:${params.from}(id 来自 list_recipes)`)
          if (sample.kind === 'example')
            throw new Error(`${params.from} 是案例,不是同款:案例只能打开看,不能做同款`)
          await instantiateSample({
            sampleDir: sample.dir,
            entry: sample.entry,
            targetDir: path,
            title: params.title,
          })
        } else if (params.from) {
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
      case 'recipe.present': {
        const params = parseParams('recipe.present', raw)
        const found = await recipeEntry(catalog.skillPath, params.id)
        if (!found) throw new Error(`RECIPE_NOT_FOUND: 没有这个同款,或者它没有样稿:${params.id}`)
        // 和 agent 调 open_deck 同一条路:打开、推 deck.opened,界面跟着进工作台。
        // 样稿在 skill 里,deck.open 会把它认成只读。
        const opened = (await dispatchUnlocked('deck.open', { path: found.dir })) as {
          deck: { id: string }
        }
        return { deckId: opened.deck.id }
      }
      case 'recipe.focus': {
        const params = parseParams('recipe.focus', raw)
        const recipes = await listRecipes(catalog.skillPath)
        const target = recipes.find((recipe) => recipe.id === params.id)
        if (!target) throw new Error(`RECIPE_NOT_FOUND: 没有这个同款:${params.id}`)
        // 案例卡片只有封面:没有样片可播,也没有「做同款」可打开
        if (target.kind === 'example' && params.show !== 'none')
          throw new Error(
            `${params.id} 是案例:首页只放封面,没有样片和「做同款」,用 present_recipe 打开看`,
          )
        // 「做同款」只在首页上有:开着稿子就先关掉,和点「首页」一样
        if (params.show !== 'none') {
          for (const deckId of [...openDecks.keys()])
            await dispatchUnlocked('deck.close', { deckId })
        }
        bus.broadcast('recipe.focus', { id: params.id, show: params.show })
        return {}
      }
      case 'catalog.recipes': {
        parseParams('catalog.recipes', raw)
        // 每次现读:写配方、改样稿时不用重启应用就能在首页看到。
        return { recipes: await listRecipes(catalog.skillPath) }
      }
      case 'deck.showSlide': {
        const params = parseParams('deck.showSlide', raw)
        deckPathOf(params.deckId)
        bus.broadcast('deck.slide', { deckId: params.deckId, index: params.index })
        return {}
      }
      case 'deck.editPages':
      case 'deck.replaceImage': {
        const params =
          method === 'deck.editPages'
            ? parseParams('deck.editPages', raw)
            : parseParams('deck.replaceImage', raw)
        const root = deckPathOf(params.deckId)
        if (params.deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED: 当前稿子已经切换')
        if ((await deckRevision(root)) !== params.expectedRevision)
          return { ok: false, reason: 'STALE_REVISION: 内容已变化，请重新读取稿子' }
        const name = await findEntryName(root)
        if (!name) return { ok: false, reason: AgentError.noBuild() }
        const before = await readEditFile(root, name)
        if (before === null) return { ok: false, reason: AgentError.noBuild() }
        try {
          let after: string, slide: number, label: string
          let files: FileChanges = {}
          if ('change' in params) {
            const edited = editPages(before, params.change)
            after = edited.html
            slide = edited.slide
            label =
              params.change.action === 'insert'
                ? `添加第 ${slide + 1} 页`
                : params.change.action === 'delete'
                  ? `删除第 ${params.change.index + 1} 页`
                  : `将第 ${params.change.index + 1} 页移到第 ${slide + 1} 页`
            if (after !== before) files = await pageMetadata(root, edited, params.change)
          } else {
            // Only existing packaged image files, no remote URL or arbitrary host file reads.
            if (
              isAbsolute(params.source) ||
              /[?#\\]/.test(params.source) ||
              /^[a-z]+:/i.test(params.source)
            )
              throw new Error('请填写 deck 内图片的相对路径')
            const target = await realpath(join(root, params.source))
            const path = relative(root, target)
            if (
              path === '..' ||
              path.startsWith('../') ||
              isAbsolute(path) ||
              !(await stat(target)).isFile()
            )
              throw new Error('图片必须在 deck 目录内')
            if (
              !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg'].includes(
                extname(target).toLowerCase(),
              )
            )
              throw new Error('请选择图片文件')
            const source = path.split('/').map(encodeURIComponent).join('/')
            after = replaceImage(before, params.slide, params.selector, params.oldSource, source)
            slide = params.slide
            label = `替换第 ${slide + 1} 页的图片`
          }
          if (after === before) return { ok: true, revision: params.expectedRevision, slide }
          if ((await deckRevision(root)) !== params.expectedRevision)
            throw new Error('STALE_REVISION: 内容已变化，请重新读取稿子')
          await writeChanges(params.deckId, { [name]: { before, after }, ...files })
          historyOf(params.deckId).record({
            slide,
            oldText: '',
            newText: '',
            before,
            after,
            label,
            files,
            ...('change' in params && params.change.action === 'delete'
              ? { undoSlide: params.change.index }
              : {}),
          })
          announceHistory(params.deckId)
          await announceDeck(params.deckId, root)
          // 换图点亮那张图;页面增删移动指整页(删除时是删完之后停在的那一页)
          const uiTargets = await recordChange(params.deckId, {
            summary: label,
            slide,
            show:
              'selector' in params
                ? { selector: params.selector, label: '换图片' }
                : {
                    label:
                      params.change.action === 'insert'
                        ? '新增这一页'
                        : params.change.action === 'delete'
                          ? '删掉了一页'
                          : '移动这一页',
                  },
          })
          return {
            ok: true,
            revision: await deckRevision(root),
            slide,
            ...(uiTargets ? { uiTargets } : {}),
          }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'deck.readPage': {
        const params = parseParams('deck.readPage', raw)
        // 源码和版本号出自同一次读盘:拿这个版本号去 writePage 才对得上读到的这一页
        const snapshot = await deckSnapshot(deckPathOf(params.deckId))
        if (!snapshot.entry) throw new Error(AgentError.noBuild())
        const page = readPage(snapshot.entry.html, params.slide)
        return { revision: snapshot.revision, slideCount: page.count, html: page.html }
      }
      case 'deck.writePage': {
        const params = parseParams('deck.writePage', raw)
        const root = deckPathOf(params.deckId)
        if (params.deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED: 当前稿子已经切换')
        if ((await deckRevision(root)) !== params.expectedRevision)
          return { ok: false, reason: 'STALE_REVISION: 内容已变化，请重新读取这一页' }
        const name = await findEntryName(root)
        if (!name) return { ok: false, reason: AgentError.noBuild() }
        const before = await readEditFile(root, name)
        if (before === null) return { ok: false, reason: AgentError.noBuild() }
        try {
          const after = writePage(before, params.slide, params.html)
          if (after === before) return { ok: true, revision: params.expectedRevision }
          if ((await deckRevision(root)) !== params.expectedRevision)
            throw new Error('STALE_REVISION: 内容已变化，请重新读取这一页')
          const label = `改写第 ${params.slide + 1} 页`
          await writeChanges(params.deckId, { [name]: { before, after } })
          historyOf(params.deckId).record({
            slide: params.slide,
            oldText: '',
            newText: '',
            before,
            after,
            label,
          })
          announceHistory(params.deckId)
          // 只动了这一页:announceDeck 先让画布就地换掉它,再推 deck.changed(标题可能变了)
          await announceDeck(params.deckId, root)
          const uiTargets = await recordChange(params.deckId, {
            summary: label,
            slide: params.slide,
            show: { label: '重写这一页' },
          })
          return {
            ok: true,
            revision: await deckRevision(root),
            ...(uiTargets ? { uiTargets } : {}),
          }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'deck.editText': {
        const params = parseParams('deck.editText', raw)
        const root = deckPathOf(params.deckId)
        const name = await findEntryName(root)
        if (!name) return { ok: false, reason: AgentError.noBuild() }

        const file = join(root, name)
        // 每次都重读磁盘:agent 可能刚写过。旧文字对不上时下面会拒绝,这正是我们要的。
        const before = await deckRevision(root)
        const html = await readFile(file, 'utf8')
        const result = applyTextEdit(html, {
          slide: params.slide,
          oldText: params.oldText,
          newText: params.newText,
        })
        if (!result.ok) return { ok: false, reason: result.reason }
        if (result.html !== html) {
          await writeChanges(params.deckId, { [name]: { before: html, after: result.html } })
          // 只换了一段字:让画布就地换,不整份重载。删掉元素(新文字为空)动了结构,换整页
          await patchCanvas(
            params.deckId,
            root,
            params.newText.trim()
              ? {
                  before,
                  text: {
                    slide: params.slide,
                    oldText: params.oldText.trim(),
                    newText: params.newText.trim(),
                  },
                }
              : undefined,
          )
          historyOf(params.deckId).record({
            slide: params.slide,
            oldText: params.oldText.trim(),
            newText: params.newText.trim(),
            before: html,
            after: result.html,
          })
          announceHistory(params.deckId)
          const uiTargets = await recordChange(params.deckId, {
            summary: textEditSummary(params.slide, params.newText),
            slide: params.slide,
            detail: { oldText: params.oldText.trim(), newText: params.newText.trim() },
            // 新文字留空是删掉那个元素:没有可框的,框整页
            show: params.newText.trim()
              ? { text: params.newText.trim(), label: '改文字' }
              : { label: '删掉文字' },
          })
          if (uiTargets) return { ok: true, uiTargets }
        }
        // 不用在这儿广播:文件一变,看稿子的 watcher 自己会推 deck.changed。
        return { ok: true }
      }
      case 'deck.editPlan': {
        const params = parseParams('deck.editPlan', raw)
        const root = deckPathOf(params.deckId)
        const name = await findEntryName(root)
        if (!name) return { ok: false, reason: AgentError.noBuild() }

        const file = join(root, name)
        const html = await readFile(file, 'utf8')
        const result = applyPlanEdit(html, { oldText: params.oldText, newText: params.newText })
        if (!result.ok) return { ok: false, reason: result.reason }
        if (result.html !== html) {
          const summary = planEditSummary(params.oldText, params.newText)
          await writeChanges(params.deckId, { [name]: { before: html, after: result.html } })
          // 注释在页面之外:画面上什么都没变,不用重载
          await patchCanvas(params.deckId, root)
          // 带 label:撤的时候要求整份还是改完的样子才还回去,不按页去找那段字
          historyOf(params.deckId).record({
            slide: 0,
            oldText: params.oldText.trim(),
            newText: params.newText.trim(),
            before: html,
            after: result.html,
            label: summary,
          })
          announceHistory(params.deckId)
          const uiTargets = await recordChange(params.deckId, {
            summary,
            detail: { oldText: params.oldText.trim(), newText: params.newText.trim() },
          })
          if (uiTargets) return { ok: true, uiTargets }
        }
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
        return control.take(params.reason, params.waiting, params.renew)
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
          spec: await spec,
        })
      }
      case 'phase.check': {
        const params = parseParams('phase.check', raw)
        const all = await readPhaseStatus(deckPathOf(params.deckId), await spec)
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
      case 'ui.resolveTargets': {
        const params = parseParams('ui.resolveTargets', raw)
        // 界面没开:每一处都量不了,照样按请求的顺序一条一条答,不编矩形
        const unavailable = (reason: string): UiTargets => ({
          measuredAt: Date.now(),
          coordinateSpace: 'screen_points_top_left',
          targets: params.queries.map((query) => ({ query, status: 'unavailable', reason })),
        })
        if (bus.connectionCount === 0) return unavailable('ui_disconnected')
        try {
          return await uiTargetRequests.request('', { queries: params.queries })
        } catch {
          return unavailable('ui_timeout')
        }
      }
      case 'ui.targetsResult': {
        const params = parseParams('ui.targetsResult', raw)
        uiTargetRequests.settle(params.requestId, { value: params.targets, error: params.error })
        return {}
      }
      case 'edit.followed': {
        const params = parseParams('edit.followed', raw)
        follows.settle(params.requestId, { value: params.targets, error: params.error })
        return {}
      }
      case 'deck.capture': {
        const params = parseParams('deck.capture', raw)
        const root = deckPathOf(params.deckId)
        if (params.deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED')
        if (bus.connectionCount === 0) throw new Error(AgentError.uiDisconnected())
        const revision = await deckRevision(root)
        if (params.expectedRevision && params.expectedRevision !== revision)
          throw new Error('STALE_REVISION')
        const shot = await captures.request(params.deckId, {
          ...(params.slide === undefined ? {} : { slide: params.slide }),
          ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {}),
        })
        if (params.deckId !== lastOpened) throw new Error('DOCUMENT_CHANGED')
        if (
          params.expectedRevision &&
          (shot.renderedRevision !== revision || (await deckRevision(root)) !== revision)
        )
          throw new Error('STALE_REVISION: 截图未确认目标版本。')
        if (params.slide !== undefined && shot.slide !== undefined && params.slide !== shot.slide)
          throw new Error('SLIDE_CHANGED: 截图页号与目标不一致。')
        return requests['deck.capture'].result.parse({ ...shot, deckId: params.deckId })
      }
      case 'capture.result': {
        const params = parseParams('capture.result', raw)
        previews.allowFile(params.path)
        captures.settle(params.requestId, {
          ...(params.path
            ? {
                value: {
                  path: params.path,
                  ...(params.slide === undefined ? {} : { slide: params.slide }),
                  ...(params.renderedRevision ? { renderedRevision: params.renderedRevision } : {}),
                },
              }
            : {}),
          error: params.error,
        })
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
      case 'deck.exportPptx': {
        const params = parseParams('deck.exportPptx', raw)
        const target = expandHome(params.path)
        const problem = await pptxTargetProblem(target)
        if (problem) throw new Error(problem)
        const opened = await openDeck(deckPathOf(params.deckId))
        const previewUrl = mountPreview(opened)
        if (!previewUrl) throw new Error(AgentError.noBuild())

        const dir = pptxExportDir()
        await mkdir(dir, { recursive: true })
        const outPath = join(dir, `${randomUUID()}.pptx`)
        try {
          // 报告的形状在这里按契约校验:渲染方是另一个进程(或以后的另一个浏览器)
          const report = PptxExportReport.parse(await renderer.exportPptx({ previewUrl, outPath }))
          // 不用 rename:临时目录和目标可能不在同一个卷上
          await copyFile(outPath, target)
          return summarizePptx(target, report)
        } finally {
          await rm(outPath, { force: true })
        }
      }
      case 'deck.stopPresent': {
        const params = parseParams('deck.stopPresent', raw)
        deckPathOf(params.deckId)
        bus.broadcast('present.stop', { deckId: params.deckId })
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
        if (!previewUrl || !opened.entryFile) return { paths: [] }

        // 内容没变就用上次渲的:打开稿子时左栏立刻有图,不用等每一页离屏渲一遍
        const slot = await thumbnailSlot(opened.deck.path, opened.entryFile, 320)
        const cached = await readThumbnails(slot, opened.slideCount)
        if (cached) {
          for (const path of cached) previews.allowFile(path)
          return { paths: cached }
        }
        const outDir = await partialDir(slot)
        try {
          const rendered = await renderer.thumbnails({
            previewUrl,
            slideCount: opened.slideCount,
            outDir,
          })
          const paths = await storeThumbnails(slot, outDir, rendered, opened.slideCount)
          for (const path of paths) previews.allowFile(path ?? undefined)
          return { paths }
        } catch (cause) {
          await dropPartial(outDir)
          throw cause
        }
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

/**
 * agent 拿着稿子时,界面发来的这几个一律拒绝:它们都会改磁盘上的稿子。
 * 翻页、放映、指给 agent 看不在里面 —— 那些不改稿子,人随时能做。
 */
/**
 * agent 新建稿子没说放哪时的默认目录。不给默认值的话,agent 会从别的稿子路径里猜,
 * 猜出来的地方每次不一样。稿子是磁盘上的普通目录,放在文稿里用户找得到、拿得走。
 */
const DEFAULT_DECKS_DIR = join(homedir(), 'Documents', 'Orca PPT')

/**
 * agent 常写 `~/Documents/…`。不展开的话它会被当成相对路径,拼到 server 的工作目录下
 * (`apps/desktop/~/Documents/…`),报一个让人摸不着头脑的 ENOENT。
 */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

const HUMAN_EDITS = new Set<RequestMethod>([
  'deck.editText',
  'deck.editPlan',
  'deck.editPages',
  'deck.replaceImage',
  'deck.writePage',
  'deck.undo',
  'deck.redo',
])

/** 目录名。中文标题原样留着,只把路径里不能用的字符换掉。 */
function slugify(title: string): string {
  const cleaned = title.trim().replace(/[/\\:*?"<>|]/g, '-')
  return cleaned || `deck-${Date.now()}`
}
