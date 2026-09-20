import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type OrcaServer } from './server.js'

let server: OrcaServer
let socket: WebSocket
let pushes: any[]

beforeEach(async () => {
  server = await startServer()
  socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await new Promise((done) => socket.once('open', done))
  pushes = []
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel) pushes.push(message)
  })
})

afterEach(async () => {
  socket.close()
  await server.close()
})

function call(method: string, params: unknown): Promise<any> {
  const id = Math.random().toString(36).slice(2)
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** 一份已经打开的空 deck(成品还没出来)。 */
async function emptyDeck() {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'))
  await mkdir(join(dir, '.deck'), { recursive: true })
  const opened = await call('deck.open', { path: dir })
  return { dir, id: opened.data.deck.id }
}

async function builtDeck(html = '<div class="slides"><section>1</section></div>') {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'))
  await writeFile(join(dir, 'deck.html'), html)
  const opened = await call('deck.open', { path: dir })
  return { dir, id: opened.data.deck.id, opened: opened.data }
}

describe('server', () => {
  it('只绑 loopback', () => {
    expect(server.port).toBeGreaterThan(0)
  })

  it('参数不合法时回错误而不是断连', async () => {
    const response = await call('deck.open', { path: 42 })
    expect(response.ok).toBe(false)
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('解不出来的载荷被丢掉,连接还活着', async () => {
    socket.send('not json')
    expect((await call('catalog.list', {})).ok).toBe(true)
  })
})

describe('deck.open', () => {
  it('打开手工跑 skill 做出来的目录 —— 只有 index.html,没有 .deck/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(
      join(dir, 'index.html'),
      '<div class="slides"><section>1</section><section>2</section></div>',
    )
    const response = await call('deck.open', { path: dir })
    expect(response.ok).toBe(true)
    expect(response.data.slides).toEqual([])
    // outline 没有,页数照样是准的 —— 它来自 HTML 本身。
    expect(response.data.slideCount).toBe(2)
  })

  it('成品还没出来的 deck 照样能打开 —— 不然就成了要先有稿子才能做稿子', async () => {
    const { id } = await emptyDeck()
    const response = await call('deck.open', { path: id })
    expect(response.data.previewUrl).toBe('')
    expect(response.data.phases.every((p: any) => p.status === 'idle')).toBe(true)
  })

  it('阶段状态从磁盘上的产物推出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await mkdir(join(dir, '.deck'), { recursive: true })
    await writeFile(
      join(dir, '.deck/brief.json'),
      JSON.stringify({
        topic: 'Q3',
        audience: '团队',
        tone: '平实',
        mode: 'report',
        slideCount: 4,
        assumptions: [],
      }),
    )
    const response = await call('deck.open', { path: dir })
    const brief = response.data.phases.find((p: any) => p.phase === 'brief')
    expect(brief.status).toBe('done')
  })
})

describe('deck.showSlide', () => {
  it('推给所有客户端 —— agent 说「你看第 4 页」画布就跳过去', async () => {
    const { id } = await builtDeck()
    const response = await call('deck.showSlide', { deckId: id, index: 3 })
    expect(response.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(pushes.find((p) => p.channel === 'deck.slide').data).toEqual({ deckId: id, index: 3 })
  })

  it('没打开的 deck 不能跳页', async () => {
    expect((await call('deck.showSlide', { deckId: '/nope', index: 0 })).ok).toBe(false)
  })
})

describe('待办队列', () => {
  it('界面挂一处锚,agent 取走后队列清空', async () => {
    const { id } = await builtDeck()
    const anchor = {
      kind: 'element',
      slide: 3,
      selector: 'h2',
      box: { x: 180, y: 220, w: 1560, h: 120 },
      note: '这儿太挤',
    }
    await call('requests.add', { deckId: id, kind: 'anchor', anchor })

    const listed = await call('requests.list', { deckId: id })
    expect(listed.data.requests).toHaveLength(1)

    const taken = await call('requests.take', { deckId: id })
    expect(taken.data.requests[0]).toMatchObject({ kind: 'anchor', anchor: { slide: 3 } })
    expect((await call('requests.list', { deckId: id })).data.requests).toEqual([])
  })

  it('队列变动推给界面,好显示「等 agent 来取」', async () => {
    const { id } = await builtDeck()
    await call('requests.add', { deckId: id, kind: 'phase', phase: 'outline' })
    await new Promise((r) => setTimeout(r, 30))
    const changed = pushes.filter((p) => p.channel === 'requests.changed').pop()
    expect(changed.data.requests).toHaveLength(1)
  })

  it('没打开的 deck 不能挂待办', async () => {
    expect(
      (await call('requests.add', { deckId: '/nope', kind: 'phase', phase: 'brief' })).ok,
    ).toBe(false)
  })
})

describe('阶段闸门', () => {
  it('第一个阶段没有上游,直接给提示词', async () => {
    const { id } = await emptyDeck()
    const response = await call('phase.prompt', { deckId: id, phase: 'brief', request: '讲讲 Q3' })
    expect(response.data.prompt).toContain('.deck/brief.json')
    expect(response.data.prompt).toContain('讲讲 Q3')
  })

  it('上游还没写就挡住,说清卡在哪一步', async () => {
    const { id } = await emptyDeck()
    const response = await call('phase.prompt', { deckId: id, phase: 'plan' })
    expect(response.data.prompt).toBeUndefined()
    expect(response.data.blockedBy).toBe('brief')
    expect(response.data.issues.join()).toContain('brief.json')
  })

  it('上游写了但不合规也挡住,并指出哪条不合规', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await mkdir(join(dir, '.deck'), { recursive: true })
    const opened = await call('deck.open', { path: dir })
    await writeFile(
      join(dir, '.deck/brief.json'),
      JSON.stringify({
        topic: 'Q3',
        audience: '团队',
        tone: '平实',
        mode: 'report',
        slideCount: 4,
        assumptions: [],
      }),
    )
    await writeFile(join(dir, '.deck/theme.json'), JSON.stringify({ name: 'clearing', reason: '' }))
    const response = await call('phase.prompt', {
      deckId: opened.data.deck.id,
      phase: 'outline',
    })
    expect(response.data.blockedBy).toBe('theme')
    expect(response.data.issues.join()).toContain('reason')
  })
})

describe('artifact.path', () => {
  it('给出产物的绝对路径', async () => {
    // deckId 就是 realpath 之后的 deck 目录(macOS 的 /var → /private/var)
    const { id } = await emptyDeck()
    const response = await call('artifact.path', { deckId: id, phase: 'outline' })
    expect(response.data.path).toBe(join(id, '.deck/outline.json'))
  })
})

describe('放映画布的 loopback 服务', () => {
  /** 照 skill 的布局搭一份:资源在 deck 目录外面两层。 */
  async function skillLayout() {
    const root = await mkdtemp(join(tmpdir(), 'skill-'))
    const deck = join(root, 'examples', 'forest-timeline')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await mkdir(deck, { recursive: true })
    await writeFile(join(root, 'runtime', 'tokens.css'), ':root{--accent:#4ade80}')
    await writeFile(
      join(deck, 'index.html'),
      `<link rel="stylesheet" href="../../runtime/tokens.css">
       <div class="slides"><section>1</section></div>`,
    )
    return { root, deck }
  }

  it('服务根倒推到 skill 根,稿子里的 ../../ 能解析出来', async () => {
    const { deck } = await skillLayout()
    const opened = await call('deck.open', { path: deck })
    expect(opened.ok).toBe(true)

    const page = await fetch(opened.data.previewUrl)
    expect(page.status).toBe(200)

    // 稿子里的相对引用,原样解析 —— 没有改写过 HTML
    const css = await fetch(new URL('../../runtime/tokens.css', opened.data.previewUrl))
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--accent')
  })

  // fetch 会按 URL 规范把 `../` 和 `%2e%2e` 都消掉,请求根本到不了我们这儿。
  // 要验服务端自己的判断,只能自己拼请求行。
  it('穿越到服务根之外一律拒绝', async () => {
    const { deck } = await skillLayout()
    const opened = await call('deck.open', { path: deck })
    const mount = new URL(opened.data.previewUrl).pathname.split('/').slice(0, 3).join('/')

    for (const suffix of [
      '/../../../../etc/passwd',
      '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/../examples/forest-timeline/../../../etc/passwd',
    ]) {
      expect(await rawRequest(server.port, mount + suffix)).toBe(403)
    }
  })

  it('只读:GET/HEAD 之外拒绝', async () => {
    const { deck } = await skillLayout()
    const opened = await call('deck.open', { path: deck })
    expect((await fetch(opened.data.previewUrl, { method: 'POST' })).status).toBe(405)
  })

  it('不是预览路径的请求 404', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/etc/passwd`)).status).toBe(404)
  })
})

describe('deck.create', () => {
  it('建出目录,标题里的路径字符换掉', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'decks-'))
    const response = await call('deck.create', { parentDir: parent, title: 'Q3/增长 复盘' })
    expect(response.data.path).toBe(join(parent, 'Q3-增长 复盘'))
    // .deck/ 一并建好,阶段产物有地方落
    await writeFile(join(response.data.path, '.deck/probe'), 'x')
  })
})

/** fetch 会按 URL 规范把 `../` 消掉,所以要验裸路径就得自己拼请求行。 */
function rawRequest(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (chunk) => (buffer += chunk.toString()))
    socket.on('end', () => resolve(Number(buffer.split(' ')[1])))
    socket.on('error', reject)
  })
}
