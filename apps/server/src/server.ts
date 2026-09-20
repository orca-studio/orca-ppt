import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
import { McpEndpoint } from './mcp-http.js'
import { findEntryName, openDeck, type OpenedDeck } from './decks.js'
import { phaseGate, readPhaseStatus } from './phases.js'
import { planPreview } from './preview.js'
import { PreviewHost } from './preview-host.js'
import { clearPortFile, writePortFile } from './port-file.js'
import { PushBus } from './push-bus.js'
import { RequestQueue } from './requests-queue.js'
import { readCatalog, resolveSkillPath, type Catalog } from './skill.js'
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
  } = {},
): Promise<OrcaServer> {
  const bus = new PushBus()
  const previews = new PreviewHost()
  for (const root of options.allowRoots ?? []) await previews.allow(root)
  const openDecks = new Map<string, string>()

  const captures = new Roundtrip<string, { slide?: number }>((payload) =>
    bus.broadcast('capture.request', payload),
  )
  // 一份稿子每页渲一张,比单张截图慢得多,给足时间。
  const thumbnails = new Roundtrip<
    Array<string | null>,
    { previewUrl: string; slideCount: number }
  >((payload) => bus.broadcast('thumbnails.request', payload), 90_000)

  const queue = new RequestQueue((deckId, pending) =>
    bus.broadcast('requests.changed', { deckId, requests: pending }),
  )

  // 稿子变了就让画布重载 —— agent 改的和用户自己在编辑器里改的,一视同仁。
  const watcher = new DeckWatcher((deckId) => {
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

  function mountPreview(opened: OpenedDeck): string {
    if (!opened.entryFile) return ''
    const plan = planPreview(opened.deck.path, opened.entryFile)
    return `http://127.0.0.1:${port}${previews.mount(plan).urlPath}`
  }

  // MCP 和界面走同一个进程、同一个端口:工具调的就是界面调的那批方法。
  const mcp = new McpEndpoint(
    (method, params) => dispatch(method, params) as never,
    // agent 动了一下,界面就该看得见 —— 比不管三七二十一都提示「还没连上?」诚实。
    (tool) => bus.broadcast('mcp.activity', { tool, at: Date.now() }),
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
        captures.failAll('界面断开了')
        thumbnails.failAll('界面断开了')
      }
    })
  })

  // 只绑 loopback。这个 server 拥有用户的文件,不该出现在局域网上。
  await new Promise<void>((done) => http.listen(options.port ?? 0, '127.0.0.1', done))
  const port = (http.address() as AddressInfo).port
  // MCP server 是另一个进程,靠这个文件找到我们。
  await writePortFile(port)

  // skill 在哪一次解析,之后一直用。找不到也要能起来 —— 提示词里会如实说明。
  const catalog: Catalog = await readCatalog(await resolveSkillPath())
  // deck 和 skill 隔得远时,稿子里的 `{{ROOT}}` 会深到把请求顶到服务器根。
  // 把 skill 目录列进 allow root,那些请求就还能服务到。
  await previews.allow(catalog.skillPath)

  function deckPathOf(deckId: string): string {
    const path = openDecks.get(deckId)
    if (!path) throw new Error('这份 deck 还没打开')
    return path
  }

  async function handle(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
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
    switch (method) {
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

        return {
          deck: opened.deck,
          slides: opened.slides,
          transitions: opened.transitions,
          slideCount: opened.slideCount,
          slideTitles: opened.slideTitles,
          transitionPlan: readTransitionPlan(opened),
          phases: await readPhaseStatus(opened.deck.path),
          previewUrl: mountPreview(opened),
        }
      }
      case 'deck.create': {
        const params = parseParams('deck.create', raw)
        const path = join(params.parentDir, slugify(params.title))

        if (params.from) {
          if (!catalog.skillPath) throw new Error('找不到 skill,没有模板可用')
          await instantiate({
            skillPath: catalog.skillPath,
            templateId: params.from,
            targetDir: path,
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
      case 'deck.capture': {
        const params = parseParams('deck.capture', raw)
        deckPathOf(params.deckId)
        return {
          path: await captures.request(params.deckId, {
            ...(params.slide === undefined ? {} : { slide: params.slide }),
          }),
        }
      }
      case 'capture.result': {
        const params = parseParams('capture.result', raw)
        captures.settle(params.requestId, { value: params.path, error: params.error })
        return {}
      }
      case 'deck.present': {
        const params = parseParams('deck.present', raw)
        const opened = await openDeck(deckPathOf(params.deckId))
        const previewUrl = mountPreview(opened)
        if (!previewUrl) throw new Error('成品还没出来,没有东西可放映')

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
        thumbnails.settle(params.requestId, { value: params.paths, error: params.error })
        return {}
      }
      case 'catalog.list': {
        parseParams('catalog.list', raw)
        return catalog
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
      await mcp.close()
      await clearPortFile()
      await new Promise<void>((done) => {
        wss.close()
        http.close(() => done())
      })
    },
  }
}

/** 目录名。中文标题原样留着,只把路径里不能用的字符换掉。 */
function slugify(title: string): string {
  const cleaned = title.trim().replace(/[/\\:*?"<>|]/g, '-')
  return cleaned || `deck-${Date.now()}`
}
