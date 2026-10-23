import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import { deckRevision } from './decks.js'
import { planPreview } from './preview.js'
import { PreviewHost, parseRange, assetFilePath } from './preview-host.js'

/**
 * `/asset` 是个文件服务,越界必须拒绝 —— 它服务的是用户机器上的绝对路径。
 */
let host: PreviewHost
let http: Server
let base: string

beforeEach(async () => {
  host = new PreviewHost()
  http = createServer((req, res) => {
    void host.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

afterEach(() => http.close())

const get = (path: string) => fetch(`${base}/asset${path}`)

describe('/asset', () => {
  it('放行目录里的图能取到,带正确的类型', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await writeFile(join(dir, 'thumb.jpg'), 'fake-jpeg')
    await host.allow(dir)

    const response = await get(`${dir}/thumb.jpg`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(await response.text()).toBe('fake-jpeg')
  })

  it('单独放行的文件能取到 —— 缩略图散在应用数据目录里,不放行整个目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'data-'))
    const file = join(dir, 'slide-0.png')
    await writeFile(file, 'png')
    host.allowFile(file)
    expect((await get(file)).status).toBe(200)
    // 同一个目录下没放行过的,照样拒绝。
    await writeFile(join(dir, 'other.png'), 'png')
    expect((await get(join(dir, 'other.png'))).status).toBe(403)
  })

  it('什么都没放行时一律拒绝 —— 默认不是「随便读」', async () => {
    expect((await get('/etc/passwd')).status).toBe(403)
  })

  it('往上跳目录跳不出去', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-'))
    await mkdir(join(root, 'inner'))
    await host.allow(join(root, 'inner'))
    await writeFile(join(root, 'secret.txt'), 'x')
    expect((await get(`${join(root, 'inner')}/../secret.txt`)).status).toBe(403)
  })

  it('只读:GET/HEAD 之外拒绝', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await writeFile(join(dir, 'a.png'), 'x')
    await host.allow(dir)
    const response = await fetch(`${base}/asset${join(dir, 'a.png')}`, { method: 'DELETE' })
    expect(response.status).toBe(405)
  })

  it('不缓存 —— 稿子一改缩略图就重渲,同名不同内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await writeFile(join(dir, 'a.png'), 'x')
    await host.allow(dir)
    expect((await get(`${dir}/a.png`)).headers.get('cache-control')).toBe('no-store')
  })

  it('不存在的文件是 404 不是 403', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await host.allow(dir)
    expect((await get(`${dir}/missing.png`)).status).toBe(404)
  })

  it('目录不是文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-'))
    await host.allow(dir)
    expect((await get(dir)).status).toBe(404)
  })
})

describe('preview version evidence', () => {
  it('keeps entry bytes unchanged and changes the navigation revision with content', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'preview-version-')))
    const file = join(dir, 'deck.html')
    const html = '<section><h2>Original</h2></section>'
    await writeFile(file, html)
    const mount = host.mount(planPreview(dir, file))
    const first = await fetch(base + mount.urlPath)
    expect(await first.text()).toBe(html)
    const revision = await deckRevision(dir)
    expect(first.headers.get('server-timing')).toBe(`orca-revision;desc="${revision}"`)
    await writeFile(file, html.replace('Original', 'Changed'))
    const second = await fetch(base + mount.urlPath)
    expect(second.headers.get('server-timing')).not.toBe(first.headers.get('server-timing'))
    expect(await second.text()).toContain('Changed')
    const head = await fetch(base + mount.urlPath, { method: 'HEAD' })
    expect(await head.text()).toBe('')
    expect(head.headers.get('server-timing')).toBe(second.headers.get('server-timing'))
  })
})

describe('parseRange', () => {
  it('认单段的三种写法', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('越界是 416,不认得的按整份回', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeUndefined()
    expect(parseRange(undefined, 1000)).toBeUndefined()
  })
})

describe('assetFilePath', () => {
  it('Windows 上去掉盘符前面那个 /', () => {
    expect(assetFilePath('/C:/Users/me/a b.png', 'win32')).toBe('C:/Users/me/a b.png')
  })
  it('macOS 和 Windows 上的非盘符路径原样', () => {
    expect(assetFilePath('/Users/me/a.png', 'darwin')).toBe('/Users/me/a.png')
    expect(assetFilePath('/C:/x.png', 'darwin')).toBe('/C:/x.png')
    expect(assetFilePath('/x.png', 'win32')).toBe('/x.png')
  })
})
