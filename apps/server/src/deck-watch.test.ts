import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeckWatcher, type WatchFn } from './deck-watch.js'

let watcher: DeckWatcher | undefined
afterEach(() => watcher?.closeAll())

/**
 * 攒批和去重用注入的假监听来测 —— 拿真实文件系统测「正好报一次」是在测 macOS 的
 * FSEvents 什么时候合并事件,不是在测我们的代码,而且必然 flaky。
 */
function fakeWatch() {
  const emitters = new Map<string, () => void>()
  const closed: string[] = []
  const watchFn: WatchFn = (path, onEvent) => {
    emitters.set(path, onEvent)
    return { close: () => closed.push(path) }
  }
  return { watchFn, emit: (path: string) => emitters.get(path)?.(), closed, emitters }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('DeckWatcher(攒批与去重)', () => {
  it('一串连续事件只报一次 —— 一次保存会触发好几个', async () => {
    const fake = fakeWatch()
    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 20, fake.watchFn)
    watcher.watch('d1', '/deck')

    for (let i = 0; i < 5; i += 1) fake.emit('/deck')
    await settle(60)
    expect(seen).toEqual(['d1'])
  })

  it('安静之后再来一次事件,是新的一批', async () => {
    const fake = fakeWatch()
    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 20, fake.watchFn)
    watcher.watch('d1', '/deck')

    fake.emit('/deck')
    await settle(60)
    fake.emit('/deck')
    await settle(60)
    expect(seen).toEqual(['d1', 'd1'])
  })

  it('同一份 deck 不重复监听', () => {
    const fake = fakeWatch()
    watcher = new DeckWatcher(vi.fn(), 20, fake.watchFn)
    watcher.watch('d1', '/deck')
    watcher.watch('d1', '/deck')
    expect(fake.emitters.size).toBe(1)
  })

  it('两份 deck 各自独立', async () => {
    const fake = fakeWatch()
    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 20, fake.watchFn)
    watcher.watch('a', '/a')
    watcher.watch('b', '/b')

    fake.emit('/b')
    await settle(60)
    expect(seen).toEqual(['b'])
  })

  it('停掉之后不再报,并且关掉了底层监听', async () => {
    const fake = fakeWatch()
    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 20, fake.watchFn)
    watcher.watch('d1', '/deck')
    watcher.unwatch('d1')

    fake.emit('/deck')
    await settle(60)
    expect(seen).toEqual([])
    expect(fake.closed).toEqual(['/deck'])
  })

  it('攒批期间被停掉,那一批也不报', async () => {
    const fake = fakeWatch()
    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 40, fake.watchFn)
    watcher.watch('d1', '/deck')

    fake.emit('/deck')
    watcher.unwatch('d1')
    await settle(80)
    expect(seen).toEqual([])
  })
})

describe('DeckWatcher(真实文件系统)', () => {
  it('稿子改了会报出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watch-'))
    await writeFile(join(dir, 'deck.html'), 'v1')

    const seen: string[] = []
    watcher = new DeckWatcher((id) => seen.push(id), 60)
    watcher.watch('d1', dir)
    // fs.watch 在 macOS 上要一会儿才真正开始收事件
    await settle(120)

    await writeFile(join(dir, 'deck.html'), 'v2')
    await settle(600)
    // 报几次由操作系统怎么合并事件决定,这里只确认它确实报了。
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['d1']))
  })
})
