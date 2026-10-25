import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { toUrlPath } from './preview.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type OrcaServer } from './server.js'

let server: OrcaServer
let socket: WebSocket
let pushes: any[]
/** 每个用例可以在 startServer 之前往里塞允许目录(假 skill)。 */
let allowRoots: string[]

beforeEach(async () => {
  allowRoots = []
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

describe('deck.editText', () => {
  const deck = (...sections: string[]) => `<div class="slides">${sections.join('')}</div>`

  it('把改动落到磁盘上的源文件,标签属性一个不动', async () => {
    const { dir, id } = await builtDeck(
      deck('<section><p data-carry="t" class="t-h1">走过的四站。</p></section>'),
    )
    const response = await call('deck.editText', {
      deckId: id,
      slide: 0,
      oldText: '走过的四站。',
      newText: '四站,一年',
    })
    expect(response.data).toEqual({ ok: true })
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toContain(
      '<p data-carry="t" class="t-h1">四站,一年</p>',
    )
  })

  it('旧文字对不上就拒绝并给人话 —— 多半是 agent 刚写过', async () => {
    const { dir, id } = await builtDeck(deck('<section><p>现在的文字</p></section>'))
    const before = await readFile(join(dir, 'deck.html'), 'utf8')
    const response = await call('deck.editText', {
      deckId: id,
      slide: 0,
      oldText: '旧的文字',
      newText: 'x',
    })
    expect(response.data.ok).toBe(false)
    expect(response.data.reason).toContain('找不到')
    // 拒绝就是一个字都不写。
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(before)
  })

  it('没打开的 deck 改不了', async () => {
    expect(
      (await call('deck.editText', { deckId: '/nope', slide: 0, oldText: 'a', newText: 'b' })).ok,
    ).toBe(false)
  })
})

describe('deck.editPlan', () => {
  it('改转场计划注释里的一句,能撤销', async () => {
    const plan = '<!-- 转场计划\n示例内容：北岸软件是虚构的公司。\n-->\n'
    const { dir, id } = await builtDeck(
      `${plan}<div class="slides"><section><p>北岸软件</p></section></div>`,
    )
    const file = join(dir, 'deck.html')
    const original = await readFile(file, 'utf8')
    const response = await call('deck.editPlan', {
      deckId: id,
      oldText: '北岸软件是虚构的公司。',
      newText: '素材来自用户的年报。',
    })
    expect(response.data).toEqual({ ok: true })
    const edited = await readFile(file, 'utf8')
    expect(edited).toContain('示例内容：素材来自用户的年报。')
    expect(edited).toContain('<p>北岸软件</p>')
    expect((await call('deck.undo', { deckId: id })).data.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(original)
  })
})

describe('recipe.focus', () => {
  it('没有这个同款就报错', async () => {
    expect((await call('recipe.focus', { id: 'no-such-recipe', show: 'prompt' })).ok).toBe(false)
  })
})

describe('撤销 / 重做', () => {
  const deck = (...sections: string[]) => `<div class="slides">${sections.join('')}</div>`

  it('撤掉一处改字,磁盘上原样还回去;重做又回来', async () => {
    const { dir, id } = await builtDeck(deck('<section><p class="t-h1">走过的四站。</p></section>'))
    const file = join(dir, 'deck.html')
    const original = await readFile(file, 'utf8')
    await call('deck.editText', { deckId: id, slide: 0, oldText: '走过的四站。', newText: '四站' })
    const edited = await readFile(file, 'utf8')

    const undone = await call('deck.undo', { deckId: id })
    expect(undone.data).toEqual({ ok: true, slide: 0, text: '走过的四站。' })
    expect(await readFile(file, 'utf8')).toBe(original)

    const redone = await call('deck.redo', { deckId: id })
    expect(redone.data).toEqual({ ok: true, slide: 0, text: '四站' })
    expect(await readFile(file, 'utf8')).toBe(edited)
  })

  it('状态推给界面,按钮跟着亮灭', async () => {
    const { id } = await builtDeck(deck('<section><p>甲</p></section>'))
    expect((await call('deck.history', { deckId: id })).data).toEqual({
      canUndo: false,
      canRedo: false,
    })
    await call('deck.editText', { deckId: id, slide: 0, oldText: '甲', newText: '乙' })
    await new Promise((r) => setTimeout(r, 30))
    const changed = pushes.filter((p) => p.channel === 'history.changed').pop()
    expect(changed.data).toMatchObject({ deckId: id, canUndo: true, canRedo: false })
  })

  it('没有可撤的就如实拒绝,不动磁盘', async () => {
    const { dir, id } = await builtDeck(deck('<section><p>甲</p></section>'))
    const before = await readFile(join(dir, 'deck.html'), 'utf8')
    const response = await call('deck.undo', { deckId: id })
    expect(response.data).toEqual({ ok: false, reason: '没有可以撤销的改动' })
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(before)
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

  it('稿子里的 ../../ 原样解析到 skill —— 没有改写过 HTML', async () => {
    const { root, deck } = await skillLayout()
    await restartWithSkill(root)

    const opened = await call('deck.open', { path: deck })
    expect(opened.ok).toBe(true)
    expect((await fetch(opened.data.previewUrl)).status).toBe(200)

    const css = await fetch(new URL('../../runtime/tokens.css', opened.data.previewUrl))
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--accent')
  })

  it('深引用一样解析得到 —— deck 和 skill 隔得远时正是这种路径', async () => {
    const { root } = await skillLayout()
    const far = await mkdtemp(join(tmpdir(), 'far-'))
    const deck = join(far, 'a', 'b', 'c', 'deck')
    await mkdir(deck, { recursive: true })

    const toSkill = relative(deck, root).split(sep).join('/')
    await writeFile(
      join(deck, 'deck.html'),
      `<link rel="stylesheet" href="${toSkill}/runtime/tokens.css">
       <div class="slides"><section>1</section></div>`,
    )
    await restartWithSkill(root)

    const opened = await call('deck.open', { path: deck })
    const css = await fetch(new URL(`${toSkill}/runtime/tokens.css`, opened.data.previewUrl))
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--accent')
  })

  it('deck 和 skill 之外的东西一律 403 —— 这不是通用文件服务', async () => {
    const { root, deck } = await skillLayout()
    await writeFile(join(root, '..', 'outside.txt'), '不该被服务出去').catch(() => {})
    await restartWithSkill(root)

    const opened = await call('deck.open', { path: deck })
    const base = new URL(opened.data.previewUrl)
    const mount = base.pathname.split('/').slice(0, 3).join('/')
    expect(await rawRequest(server.port, `${mount}/etc/passwd`)).toBe(403)
  })

  // fetch 会按 URL 规范把 `../` 和 `%2e%2e` 都消掉,请求根本到不了我们这儿。
  // 要验服务端自己的判断,只能自己拼请求行。
  it('穿越到允许目录之外一律拒绝', async () => {
    const { root, deck } = await skillLayout()
    await restartWithSkill(root)
    const opened = await call('deck.open', { path: deck })
    const mount = new URL(opened.data.previewUrl).pathname.split('/').slice(0, 3).join('/')

    for (const suffix of [
      `${toUrlPath(deck)}/../../../../etc/passwd`,
      `${toUrlPath(deck)}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
    ]) {
      expect(await rawRequest(server.port, mount + suffix)).toBe(403)
    }
  })

  it('只读:GET/HEAD 之外拒绝', async () => {
    const { root, deck } = await skillLayout()
    await restartWithSkill(root)
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

/** 换一台把假 skill 列进允许目录的 server —— allow root 是启动时定的。 */
async function restartWithSkill(skillRoot: string): Promise<void> {
  socket.close()
  await server.close()
  allowRoots = [skillRoot]
  server = await startServer({ allowRoots })
  socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await new Promise((done) => socket.once('open', done))
  pushes = []
  socket.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel) pushes.push(message)
  })
}

it('当前稿子跟随 UI 打开，旧画布报告不能覆盖新稿子的可见页', async () => {
  const a = await builtDeck()
  await call('deck.visibleSlide', { deckId: a.id, index: 0 })
  expect((await call('deck.current', {})).data).toEqual({ deckId: a.id, slide: 0 })
  const b = await builtDeck()
  await call('deck.visibleSlide', { deckId: a.id, index: 8 })
  expect((await call('deck.current', {})).data).toEqual({ deckId: b.id })
})

it('导航走共享推送，停止自动播放，拒绝旧稿子和不完整重放', async () => {
  const a = await builtDeck()
  const b = await builtDeck()
  expect((await call('deck.navigation', { deckId: a.id, action: 'next' })).ok).toBe(false)
  expect((await call('deck.navigation', { deckId: b.id, action: 'replay' })).ok).toBe(false)
  expect((await call('deck.navigation', { deckId: b.id, action: 'replay', from: 0 })).ok).toBe(true)
  // 重放页内动画也要说是哪一页 —— server 不知道画布现在停在哪
  expect((await call('deck.navigation', { deckId: b.id, action: 'replayPage' })).ok).toBe(false)
  expect((await call('deck.navigation', { deckId: b.id, action: 'replayPage', from: 1 })).ok).toBe(
    true,
  )
  expect(
    pushes.some(
      (p) => p.channel === 'deck.navigation' && p.data.action === 'replay' && p.data.from === 0,
    ),
  ).toBe(true)
  expect(pushes.some((p) => p.channel === 'autoplay.changed' && p.data.on === false)).toBe(true)
})

it('ui.resolveTargets 交给界面量,按查询的顺序答', async () => {
  const respond = (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel !== 'ui.targets.request') return
    void call('ui.targetsResult', {
      requestId: message.data.requestId,
      targets: {
        measuredAt: 5,
        coordinateSpace: 'screen_points_top_left',
        targets: message.data.queries.map((query: unknown) => ({ query, status: 'not_visible' })),
      },
    })
  }
  socket.on('message', respond)
  const queries = [{ controlId: 'canvas' }, { slide: 2, text: '1970' }]
  const result = await call('ui.resolveTargets', { queries })
  socket.off('message', respond)
  expect(result.data.targets.map((t: { query: unknown }) => t.query)).toEqual(queries)
  expect(result.data.targets.every((t: { rect?: unknown }) => !t.rect)).toBe(true)
})

it('改字推 deck.patched 让画布就地换;文件监听随后推的 deck.changed 带着同一个版本号', async () => {
  const deck = await builtDeck('<div class="slides"><section><p>1970</p></section></div>')
  pushes.length = 0
  await call('deck.editText', { deckId: deck.id, slide: 0, oldText: '1970', newText: '1971' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const patched = pushes.find((p) => p.channel === 'deck.patched')!.data
  expect(patched).toMatchObject({ text: { slide: 0, oldText: '1970', newText: '1971' } })
  expect(patched.before).not.toBe(patched.revision)
  const changed = pushes.filter((p) => p.channel === 'deck.changed').at(-1)!.data
  expect(changed.revision).toBe(patched.revision)
})

it('删掉一个元素动了这一页的结构:整页换掉,不重载整份', async () => {
  const deck = await builtDeck('<div class="slides"><section><p>1970</p><p>留</p></section></div>')
  pushes.length = 0
  await call('deck.editText', { deckId: deck.id, slide: 0, oldText: '1970', newText: '' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const patched = pushes.find((p) => p.channel === 'deck.patched')!.data
  expect(patched.text).toBeUndefined()
  expect(patched.sections).toEqual([{ index: 0, html: expect.stringContaining('<p>留</p>') }])
  expect(patched.sections[0].html).not.toContain('1970')
})

describe('按页读写,画布只换那一页', () => {
  const two =
    '<div class="slides"><section><h2>一</h2></section><section><h2>二</h2></section></div>'

  it('readPage 给原文和同一次读盘的版本号;writePage 推只含那一页的 deck.patched', async () => {
    const deck = await builtDeck(two)
    const read = (await call('deck.readPage', { deckId: deck.id, slide: 1 })).data
    expect(read).toMatchObject({ slideCount: 2, html: '<section><h2>二</h2></section>' })
    pushes.length = 0
    const page = '<section data-auto-animate><h2>贰</h2></section>'
    const written = await call('deck.writePage', {
      deckId: deck.id,
      slide: 1,
      html: page,
      expectedRevision: read.revision,
    })
    expect(written.data.ok).toBe(true)
    expect(await readFile(join(deck.dir, 'deck.html'), 'utf8')).toBe(two.replace(read.html, page))
    await new Promise((resolve) => setTimeout(resolve, 600))
    const patched = pushes.find((p) => p.channel === 'deck.patched')!.data
    expect(patched).toMatchObject({ before: read.revision, sections: [{ index: 1, html: page }] })
    expect(pushes.filter((p) => p.channel === 'deck.changed').at(-1)!.data.revision).toBe(
      patched.revision,
    )
    // 撤销也只换回那一页
    pushes.length = 0
    expect((await call('deck.undo', { deckId: deck.id })).data.ok).toBe(true)
    expect(pushes.find((p) => p.channel === 'deck.patched')!.data.sections).toEqual([
      { index: 1, html: read.html },
    ])
  })

  it('版本号过期、源码不是一页,都不写', async () => {
    const deck = await builtDeck(two)
    const { revision } = (await call('deck.readPage', { deckId: deck.id, slide: 0 })).data
    const stale = await call('deck.writePage', {
      deckId: deck.id,
      slide: 0,
      html: '<section>x</section>',
      expectedRevision: 'old',
    })
    expect(stale.data.reason).toContain('STALE_REVISION')
    const bad = await call('deck.writePage', {
      deckId: deck.id,
      slide: 0,
      html: '<div>x</div>',
      expectedRevision: revision,
    })
    expect(bad.data).toMatchObject({ ok: false, reason: expect.stringContaining('<section>') })
    expect(await readFile(join(deck.dir, 'deck.html'), 'utf8')).toBe(two)
  })

  it('外面直接改了文件里的一页:文件监听推只含那一页的 deck.patched', async () => {
    const deck = await builtDeck(two)
    pushes.length = 0
    await writeFile(join(deck.dir, 'deck.html'), two.replace('<h2>一</h2>', '<h2>壹</h2>'))
    await vi.waitFor(() => expect(pushes.some((p) => p.channel === 'deck.changed')).toBe(true), {
      timeout: 3000,
    })
    expect(pushes.find((p) => p.channel === 'deck.patched')!.data.sections).toEqual([
      { index: 0, html: '<section><h2>壹</h2></section>' },
    ])
  })

  it('增删了页:不推 deck.patched,整份重载', async () => {
    const deck = await builtDeck(two)
    pushes.length = 0
    await writeFile(join(deck.dir, 'deck.html'), two.replace('<section><h2>二</h2></section>', ''))
    await vi.waitFor(() => expect(pushes.some((p) => p.channel === 'deck.changed')).toBe(true), {
      timeout: 3000,
    })
    expect(pushes.some((p) => p.channel === 'deck.patched')).toBe(false)
  })
})

it('演示模式:开关广播 demo.changed,间隔有上下限', async () => {
  expect((await call('demo.state', {})).data).toEqual({ on: false, intervalMs: 1200 })
  expect((await call('demo.set', { on: true, intervalMs: 800 })).data).toEqual({
    on: true,
    intervalMs: 800,
  })
  // 不带间隔就沿用上次的
  expect((await call('demo.set', { on: false })).data).toEqual({ on: false, intervalMs: 800 })
  expect((await call('demo.set', { on: true, intervalMs: 50 })).ok).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(pushes.filter((p) => p.channel === 'demo.changed').map((p) => p.data.on)).toEqual([
    true,
    false,
  ])
})

const canvasEvidence = (revision: string, overrides: Record<string, unknown> = {}) => ({
  renderedRevision: revision,
  slide: 0,
  ready: true,
  width: 1920,
  height: 1080,
  autoplay: false,
  selection: null,
  elements: [],
  elementsTruncated: false,
  html: null,
  htmlLength: 0,
  htmlTruncated: false,
  errors: [],
  ...overrides,
})

function respondToCanvas(reply: (request: any) => Promise<unknown>) {
  const listener = (raw: Buffer) => {
    const message = JSON.parse(raw.toString())
    if (message.channel === 'canvas.request') void reply(message.data)
  }
  socket.on('message', listener)
  return () => socket.off('message', listener)
}

describe('shared canvas protocol', () => {
  it('returns live evidence with content/render identity and does not consume opinions', async () => {
    const { id } = await builtDeck()
    const revision = (await call('deck.inspect', { deckId: id })).data.revision
    await call('requests.add', {
      deckId: id,
      kind: 'anchor',
      anchor: { kind: 'transition', from: 0, to: 1, note: 'Review' },
    })
    const stop = respondToCanvas(async (request) => {
      expect(request).toMatchObject({ deckId: id, action: 'inspect', include: 'elements' })
      return call('canvas.result', {
        requestId: request.requestId,
        evidence: canvasEvidence(revision),
      })
    })
    const result = await call('canvas.inspect', {
      deckId: id,
      include: 'elements',
      expectedRevision: revision,
    })
    stop()
    expect(result).toMatchObject({
      ok: true,
      data: { deckId: id, revision, renderedRevision: revision, current: true },
    })
    expect((await call('requests.list', { deckId: id })).data.requests).toHaveLength(1)
  })
  it('reports stale rendered context and rejects it when a specific version is required', async () => {
    const { id } = await builtDeck()
    const revision = (await call('deck.inspect', { deckId: id })).data.revision
    const stop = respondToCanvas((request) =>
      call('canvas.result', { requestId: request.requestId, evidence: canvasEvidence('old') }),
    )
    expect((await call('canvas.inspect', { deckId: id })).data.current).toBe(false)
    const result = await call('canvas.inspect', { deckId: id, expectedRevision: revision })
    stop()
    expect(result).toMatchObject({ ok: false })
    expect(result.error.message).toContain('RENDER_NOT_READY')
  })
  it('rejects a stale content version without sending a guest request', async () => {
    const { id } = await builtDeck()
    const result = await call('canvas.select', {
      deckId: id,
      selector: 'h2',
      slide: 0,
      expectedRevision: 'old',
    })
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('STALE_REVISION')
    expect(pushes.some((p) => p.channel === 'canvas.request')).toBe(false)
  })
  it('rejects a deck switch during an outstanding inspection', async () => {
    const { id } = await builtDeck()
    const stop = respondToCanvas(async (request) => {
      await builtDeck('<div class="slides"><section>Other</section></div>')
      return call('canvas.result', {
        requestId: request.requestId,
        evidence: canvasEvidence('old'),
      })
    })
    const result = await call('canvas.inspect', { deckId: id })
    stop()
    expect(result.error.message).toContain('DOCUMENT_CHANGED')
  })
  it('validates guest evidence and forwards guest failure without hanging', async () => {
    const { id } = await builtDeck()
    const stop = respondToCanvas(async (request) => {
      const invalid = await call('canvas.result', {
        requestId: request.requestId,
        evidence: { ready: true },
      })
      expect(invalid.ok).toBe(false)
      return call('canvas.result', { requestId: request.requestId, error: 'RENDER_NOT_READY' })
    })
    const result = await call('canvas.inspect', { deckId: id })
    stop()
    expect(result.error.message).toBe('RENDER_NOT_READY')
  })
  it('returns selection evidence and refuses user selection while agent holds control', async () => {
    const { id } = await builtDeck()
    const revision = (await call('deck.inspect', { deckId: id })).data.revision
    const selection = {
      selector: 'h2',
      tag: 'h2',
      text: 'Title',
      box: { x: 0, y: 0, w: 100, h: 30 },
      visible: true,
      source: null,
    }
    const stop = respondToCanvas((request) =>
      call('canvas.result', {
        requestId: request.requestId,
        evidence: canvasEvidence(revision, { selection }),
      }),
    )
    expect(
      (
        await call('canvas.select', {
          deckId: id,
          selector: 'h2',
          slide: 0,
          expectedRevision: revision,
        })
      ).data.selection,
    ).toEqual(selection)
    stop()
    await call('control.take', { reason: 'Editing' })
    const blocked = await call('canvas.select', {
      deckId: id,
      selector: null,
      slide: 0,
      expectedRevision: revision,
    })
    expect(blocked.ok).toBe(false)
  })
})

describe('version-bound canvas capture', () => {
  function replyToCapture(reply: (request: any) => Promise<unknown>) {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel === 'capture.request') void reply(message.data)
    }
    socket.on('message', listener)
    return () => socket.off('message', listener)
  }
  it('returns the actual page and version and rejects a mismatched rendered version', async () => {
    const { id } = await builtDeck()
    const revision = (await call('deck.inspect', { deckId: id })).data.revision
    let renderedRevision = revision
    const stop = replyToCapture((request) =>
      call('capture.result', {
        requestId: request.requestId,
        path: '/tmp/canvas-evidence.png',
        slide: 0,
        renderedRevision,
      }),
    )
    const result = await call('deck.capture', { deckId: id, slide: 0, expectedRevision: revision })
    expect(result).toMatchObject({
      ok: true,
      data: { deckId: id, slide: 0, renderedRevision: revision, path: '/tmp/canvas-evidence.png' },
    })
    renderedRevision = 'old'
    expect(
      (await call('deck.capture', { deckId: id, expectedRevision: revision })).error.message,
    ).toContain('STALE_REVISION')
    stop()
  })
  it('refuses evidence for another page', async () => {
    const { id } = await builtDeck()
    const stop = replyToCapture((request) =>
      call('capture.result', {
        requestId: request.requestId,
        path: '/tmp/canvas-evidence.png',
        slide: 1,
      }),
    )
    const result = await call('deck.capture', { deckId: id, slide: 0 })
    stop()
    expect(result.error.message).toContain('SLIDE_CHANGED')
  })
})

describe('shared page and image edits', () => {
  const html =
    '<!-- 转场计划\n1→2 关系：一到二\n2→3 关系：二到三\n--><div class="slides"><section><h2>A</h2></section><section><h2>B</h2></section><section><img id="photo" src="assets/a.png"></section></div><script>const marker = "<section>"</script>'
  const revisionOf = async (id: string) =>
    (await call('deck.inspect', { deckId: id })).data.revision
  it('moves pages, syncs metadata, and undoes/redoes all files byte exactly', async () => {
    const { dir, id } = await builtDeck(html)
    await mkdir(join(dir, '.deck'))
    const outline = JSON.stringify({
      slides: ['A', 'B', 'C'].map((subject, index) => ({
        index,
        subject,
        layout: 'cover',
        points: [],
        layoutReason: 'explicit',
      })),
      extra: 'keep',
    })
    const plan = JSON.stringify({
      transitions: [0, 1].map((from) => ({
        from,
        to: from + 1,
        relation: 'next',
        technique: 'shared-element',
      })),
    })
    await writeFile(join(dir, '.deck/outline.json'), outline)
    await writeFile(join(dir, '.deck/plan.json'), plan)
    const result = await call('deck.editPages', {
      deckId: id,
      expectedRevision: await revisionOf(id),
      change: { action: 'move', index: 0, to: 2 },
    })
    expect(result.data.ok).toBe(true)
    expect(
      JSON.parse(await readFile(join(dir, '.deck/outline.json'), 'utf8')).slides.map(
        (s: any) => s.subject,
      ),
    ).toEqual(['B', 'C', 'A'])
    expect(JSON.parse(await readFile(join(dir, '.deck/plan.json'), 'utf8')).transitions).toEqual([
      { from: 0, to: 1, relation: 'next', technique: 'shared-element' },
    ])
    const changed = await readFile(join(dir, 'deck.html'), 'utf8')
    expect((await call('deck.undo', { deckId: id })).data.ok).toBe(true)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(html)
    expect(await readFile(join(dir, '.deck/outline.json'), 'utf8')).toBe(outline)
    expect(await readFile(join(dir, '.deck/plan.json'), 'utf8')).toBe(plan)
    expect((await call('deck.redo', { deckId: id })).data.ok).toBe(true)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(changed)
  })
  it('serializes concurrent edits, refusing the second stale revision', async () => {
    const { dir, id } = await builtDeck(html)
    const revision = await revisionOf(id)
    const results = await Promise.all(
      [1, 2].map((index) =>
        call('deck.editPages', {
          deckId: id,
          expectedRevision: revision,
          change: { action: 'delete', index },
        }),
      ),
    )
    expect(results.map((r) => r.data.ok).sort()).toEqual([false, true])
    expect(results.find((r) => !r.data.ok)?.data.reason).toContain('STALE_REVISION')
    expect((await readFile(join(dir, 'deck.html'), 'utf8')).match(/<section>/g)).toHaveLength(3) // includes the untouched script marker
    await call('deck.undo', { deckId: id })
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(html)
  })
  it('inserts/deletes a page and refuses structural undo after an external change', async () => {
    const { dir, id } = await builtDeck(html)
    const insert = await call('deck.editPages', {
      deckId: id,
      expectedRevision: await revisionOf(id),
      change: { action: 'insert', index: 3, title: '<new>' },
    })
    expect(insert.data.ok).toBe(true)
    expect((await call('deck.inspect', { deckId: id })).data.slides).toHaveLength(4)
    const remove = await call('deck.editPages', {
      deckId: id,
      expectedRevision: insert.data.revision,
      change: { action: 'delete', index: 3 },
    })
    expect(remove.data.ok).toBe(true)
    expect((await call('deck.undo', { deckId: id })).data).toMatchObject({ ok: true, slide: 3 })
    expect((await call('deck.redo', { deckId: id })).data.ok).toBe(true)
    const external = (await readFile(join(dir, 'deck.html'), 'utf8')) + '<!-- external -->'
    await writeFile(join(dir, 'deck.html'), external)
    expect((await call('deck.undo', { deckId: id })).data.ok).toBe(false)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(external)
    expect((await call('deck.history', { deckId: id })).data.canUndo).toBe(true)
  })
  it('replaces a packaged image, preserves attributes and shares undo', async () => {
    const { dir, id } = await builtDeck(html)
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'assets/b.png'), 'fixture')
    const result = await call('deck.replaceImage', {
      deckId: id,
      slide: 2,
      selector: '#photo',
      oldSource: 'assets/a.png',
      source: 'assets/b.png',
      expectedRevision: await revisionOf(id),
    })
    expect(result.data.ok).toBe(true)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(
      html.replace('assets/a.png', 'assets/b.png'),
    )
    expect((await call('deck.undo', { deckId: id })).data.ok).toBe(true)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(html)
    const refused = await call('deck.replaceImage', {
      deckId: id,
      slide: 2,
      selector: '#photo',
      oldSource: 'assets/a.png',
      source: '../outside.png',
      expectedRevision: await revisionOf(id),
    })
    expect(refused.data.ok).toBe(false)
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).toBe(html)
  })
  it('blocks human page edits while agent holds control', async () => {
    const { id } = await builtDeck(html)
    await call('control.take', { reason: 'working' })
    expect(
      (
        await call('deck.editPages', {
          deckId: id,
          expectedRevision: await revisionOf(id),
          change: { action: 'delete', index: 1 },
        })
      ).data.ok,
    ).toBe(false)
  })
})

describe('导出 PPTX', () => {
  const report = {
    slides: [
      { index: 1, lost: [], rasters: [] },
      { index: 2, lost: ['页内动画'], rasters: [{ name: 'img', reason: '<img>' }] },
    ],
    degraded: [{ from: 1, to: 2, technique: '整页推近', tier: '降级', kind: 'fade' }],
    fonts: ['Inter'],
  }
  /** 扮演壳:收到导出请求就往 server 给的临时文件里写点东西,交回报告 */
  function actAsShell(reply: (request: any) => Promise<unknown>) {
    const requests: any[] = []
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel !== 'pptx.request') return
      requests.push(message.data)
      void reply(message.data)
    }
    socket.on('message', listener)
    return { requests, stop: () => socket.off('message', listener) }
  }
  beforeEach(async () => {
    process.env.ORCA_PPT_PPTX_DIR = await mkdtemp(join(tmpdir(), 'pptx-tmp-'))
  })
  afterEach(() => {
    delete process.env.ORCA_PPT_PPTX_DIR
  })

  it('壳导到临时文件,server 挪到要的位置,临时文件删掉,报告说给人听', async () => {
    const { id } = await builtDeck()
    const shell = actAsShell(async (request) => {
      await writeFile(request.outPath, 'pptx')
      await call('pptx.result', { requestId: request.requestId, report })
    })
    const target = join(await mkdtemp(join(tmpdir(), 'pptx-out-')), '稿子.pptx')
    const result = await call('deck.exportPptx', { deckId: id, path: target })
    shell.stop()
    expect(result.data).toEqual({
      path: target,
      slides: 2,
      degraded: report.degraded,
      lost: [{ slide: 2, items: ['页内动画'] }],
      rasters: 1,
      fonts: ['Inter'],
    })
    expect(await readFile(target, 'utf8')).toBe('pptx')
    expect(shell.requests[0].outPath.startsWith(process.env.ORCA_PPT_PPTX_DIR!)).toBe(true)
    await expect(readFile(shell.requests[0].outPath)).rejects.toThrow()
  })

  it('目标路径不对就不请壳导', async () => {
    const { id } = await builtDeck()
    const shell = actAsShell(async () => {})
    const dir = await mkdtemp(join(tmpdir(), 'pptx-out-'))
    for (const [path, message] of [
      ['相对/稿子.pptx', '绝对路径'],
      [join(dir, '稿子.key'), '.pptx'],
      [join(dir, '没有这个目录', '稿子.pptx'), '目录不存在'],
    ]) {
      expect((await call('deck.exportPptx', { deckId: id, path })).error.message).toContain(message)
    }
    shell.stop()
    expect(shell.requests).toEqual([])
  })

  it('壳导失败,原因带回来', async () => {
    const { id } = await builtDeck()
    const shell = actAsShell((request) =>
      call('pptx.result', { requestId: request.requestId, error: '稿子没有录制接口' }),
    )
    const target = join(await mkdtemp(join(tmpdir(), 'pptx-out-')), 'a.pptx')
    const result = await call('deck.exportPptx', { deckId: id, path: target })
    shell.stop()
    expect(result.error.message).toContain('稿子没有录制接口')
    await expect(readFile(target)).rejects.toThrow()
  })
})

describe('页胶片缩略图缓存', () => {
  it('第一次请壳渲到缓存里,内容不变再要就直接给,改了再渲', async () => {
    const { id, dir } = await builtDeck(
      '<div class="slides"><section>1</section><section>2</section></div>',
    )
    const requests: any[] = []
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString())
      if (message.channel !== 'thumbnails.request') return
      requests.push(message.data)
      void (async () => {
        const paths = [0, 1].map((i) => join(message.data.outDir, `${i}.png`))
        for (const path of paths) await writeFile(path, 'png')
        await call('thumbnails.result', { requestId: message.data.requestId, paths })
      })()
    }
    socket.on('message', listener)

    const first = (await call('deck.thumbnails', { deckId: id })).data.paths
    expect(requests).toHaveLength(1)
    expect(requests[0].outDir.startsWith(process.env.ORCA_PPT_THUMBNAIL_DIR!)).toBe(true)
    expect(first).toHaveLength(2)

    const again = (await call('deck.thumbnails', { deckId: id })).data.paths
    expect(requests).toHaveLength(1)
    expect(again).toEqual(first)

    await writeFile(
      join(dir, 'deck.html'),
      '<div class="slides"><section>一</section><section>2</section></div>',
    )
    await call('deck.thumbnails', { deckId: id })
    socket.off('message', listener)
    expect(requests).toHaveLength(2)
  })
})
