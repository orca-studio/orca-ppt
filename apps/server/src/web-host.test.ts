import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer, type OrcaServer } from './server.js'
import { allowClient } from './web-host.js'

describe('allowClient', () => {
  it('没配 token 不拦(测试)', () => {
    expect(allowClient(undefined, 'https://evil.example', '/')).toBe(true)
  })

  it('不带 Origin 的是本机进程,不拦', () => {
    expect(allowClient('t0k', undefined, '/')).toBe(true)
  })

  it('浏览器发来的必须带对 token', () => {
    expect(allowClient('t0k', 'https://evil.example', '/')).toBe(false)
    expect(allowClient('t0k', 'https://evil.example', '/?token=nope')).toBe(false)
    expect(allowClient('t0k', 'http://127.0.0.1:6722', '/?token=t0k')).toBe(true)
  })
})

describe('serve:托管界面 + 拦浏览器连接', () => {
  let server: OrcaServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function start() {
    const webRoot = await mkdtemp(join(tmpdir(), 'web-'))
    await writeFile(join(webRoot, 'index.html'), '<title>Orca PPT</title>')
    await mkdir(join(webRoot, 'assets'))
    await writeFile(join(webRoot, 'assets/app.js'), 'export {}')
    // 界面目录之外的文件,不该被读到
    await writeFile(join(webRoot, '..', 'secret.txt'), 'secret')
    server = await startServer({ webRoot, token: 't0k' })
    return `127.0.0.1:${server.port}`
  }

  const connect = (url: string, origin?: string) =>
    new Promise<'open' | 'rejected'>((done) => {
      const socket = new WebSocket(url, origin ? { origin } : {})
      socket.once('open', () => {
        socket.close()
        done('open')
      })
      socket.once('error', () => done('rejected'))
    })

  it('根路径给界面,资源照常给,目录之外 404', async () => {
    const host = await start()
    const index = await fetch(`http://${host}/?token=t0k`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('Orca PPT')
    expect((await fetch(`http://${host}/assets/app.js`)).headers.get('content-type')).toContain(
      'javascript',
    )
    expect((await fetch(`http://${host}/..%2Fsecret.txt`)).status).toBe(404)
  })

  it('别的网页连不上;带对 token 的界面、本机进程连得上', async () => {
    const host = await start()
    expect(await connect(`ws://${host}/`, 'https://evil.example')).toBe('rejected')
    expect(await connect(`ws://${host}/?token=nope`, `http://${host}`)).toBe('rejected')
    expect(await connect(`ws://${host}/?token=t0k`, `http://${host}`)).toBe('open')
    expect(await connect(`ws://${host}/`)).toBe('open')
  })

  it('端口被占要报出来,不是进程级异常', async () => {
    const host = await start()
    const port = Number(host.split(':')[1])
    await expect(startServer({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('浏览器版的稿子放在另一个源', () => {
  let server: OrcaServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('稿子在另一个端口,入口页末尾加一行 guest 脚本;界面那个源上不给稿子', async () => {
    server = await startServer({ isolate: { previewPort: 0, guestScript: '/guest.js' } })
    const dir = await mkdtemp(join(tmpdir(), 'deck-'))
    await writeFile(join(dir, 'deck.html'), '<html><body><p>稿子</p></body></html>')

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`)
    await new Promise((done) => socket.once('open', done))
    const opened = await new Promise<any>((done) => {
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString())
        if (message.id === 'open') done(message)
      })
      socket.send(JSON.stringify({ id: 'open', method: 'deck.open', params: { path: dir } }))
    })
    socket.close()

    const preview = new URL(opened.data.previewUrl)
    expect(preview.port).not.toBe(String(server.port))
    const html = await (await fetch(preview)).text()
    expect(html).toBe(
      `<html><body><p>稿子</p><script src="http://127.0.0.1:${server.port}/guest.js"></script></body></html>`,
    )
    // 磁盘上的文件不动
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).not.toContain('guest.js')

    preview.port = String(server.port)
    expect((await fetch(preview)).status).toBe(404)
  })
})
