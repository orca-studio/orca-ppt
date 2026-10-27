import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  latestCover,
  localRefs,
  partialDir,
  readThumbnails,
  storeThumbnails,
  thumbnailSlot,
} from './thumbnail-cache.js'

/** 一份引了主题文件和一张图的稿子 */
async function deck() {
  const dir = await mkdtemp(join(tmpdir(), 'thumb-deck-'))
  await writeFile(join(dir, 'theme.css'), 'body { color: red }')
  await writeFile(join(dir, 'a.png'), 'png')
  const entry = join(dir, 'index.html')
  await writeFile(
    entry,
    '<link href="theme.css"><div class="slides"><section><img src="a.png"></section></div>',
  )
  return { dir, entry, root: await mkdtemp(join(tmpdir(), 'thumb-cache-')) }
}

/** 扮演壳:往给的目录里渲几张图 */
async function render(dir: string, count: number) {
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    paths.push(join(dir, `${i}.png`))
    await writeFile(paths[i]!, `page ${i}`)
  }
  return paths
}

describe('缩略图缓存', () => {
  it('内容不变键就不变;稿子、引用的文件、宽度任何一处变了键就变', async () => {
    const { dir, entry, root } = await deck()
    const key = async (width = 320) => (await thumbnailSlot(dir, entry, width, root)).key
    const first = await key()
    expect(await key()).toBe(first)
    expect(await key(640)).not.toBe(first)
    await writeFile(join(dir, 'theme.css'), 'body { color: blue }')
    const themed = await key()
    expect(themed).not.toBe(first)
    await writeFile(join(dir, 'a.png'), 'png2')
    expect(await key()).not.toBe(themed)
  })

  it('渲完存进去,下次直接读到;页数对不上当没有', async () => {
    const { dir, entry, root } = await deck()
    const slot = await thumbnailSlot(dir, entry, 320, root)
    expect(await readThumbnails(slot, 2)).toBeUndefined()
    const partial = await partialDir(slot)
    const stored = await storeThumbnails(slot, partial, await render(partial, 2), 2)
    expect(stored).toEqual([join(slot.dir, slot.key, '0.png'), join(slot.dir, slot.key, '1.png')])
    expect(await readThumbnails(slot, 2)).toEqual(stored)
    expect(await readThumbnails(slot, 3)).toBeUndefined()
  })

  it('有一页没渲出来、被后来的请求顶掉(交回空的),都不进缓存', async () => {
    const { dir, entry, root } = await deck()
    const slot = await thumbnailSlot(dir, entry, 320, root)
    const partial = await partialDir(slot)
    const [first] = await render(partial, 1)
    await storeThumbnails(slot, partial, [first!, null], 2)
    expect(await readThumbnails(slot, 2)).toBeUndefined()
    await storeThumbnails(slot, await partialDir(slot), [], 2)
    expect(await readThumbnails(slot, 2)).toBeUndefined()
  })

  it('一份稿子只留最新的一版;别人正在渲的不删', async () => {
    const { dir, entry, root } = await deck()
    const old = await thumbnailSlot(dir, entry, 320, root)
    const oldPartial = await partialDir(old)
    await storeThumbnails(old, oldPartial, await render(oldPartial, 1), 1)

    await writeFile(join(dir, 'theme.css'), 'body { color: green }')
    const slot = await thumbnailSlot(dir, entry, 320, root)
    expect(slot.dir).toBe(old.dir)
    const busy = await partialDir(slot)
    const partial = await partialDir(slot)
    await storeThumbnails(slot, partial, await render(partial, 1), 1)
    const left = await readdir(slot.dir)
    expect(left).toContain(slot.key)
    expect(left).not.toContain(old.key)
    expect(left).toContain(busy.split('/').at(-1))
  })

  it('同一版被别人先存好了,用它的;那份是坏的就换成这一份', async () => {
    const { dir, entry, root } = await deck()
    const slot = await thumbnailSlot(dir, entry, 320, root)
    const a = await partialDir(slot)
    const b = await partialDir(slot)
    const first = await storeThumbnails(slot, a, await render(a, 1), 1)
    expect(await storeThumbnails(slot, b, await render(b, 1), 1)).toEqual(first)

    // 键目录在、但没有 index.json:渲到一半被打断留下的
    const other = await thumbnailSlot(dir, entry, 640, root)
    await mkdir(join(other.dir, other.key, 'junk'), { recursive: true })
    const c = await partialDir(other)
    const stored = await storeThumbnails(other, c, await render(c, 1), 1)
    expect(await readThumbnails(other, 1)).toEqual(stored)
  })
})

describe('latestCover', () => {
  it('首页封面是缓存里那版的第一页;稿子改过、键变了也照样用', async () => {
    const { dir, entry, root } = await deck()
    expect(await latestCover(dir, root)).toBeUndefined()
    const slot = await thumbnailSlot(dir, entry, 320, root)
    const partial = await partialDir(slot)
    const [first] = await storeThumbnails(slot, partial, await render(partial, 2), 2)
    await writeFile(join(dir, 'theme.css'), 'body { color: blue }')
    expect(await latestCover(dir, root)).toBe(first)
  })

  it('只有渲到一半的目录就没有封面', async () => {
    const { dir, entry, root } = await deck()
    await render(await partialDir(await thumbnailSlot(dir, entry, 320, root)), 1)
    expect(await latestCover(dir, root)).toBeUndefined()
  })
})

describe('localRefs', () => {
  it('只收本地相对路径', () => {
    expect(
      localRefs(
        '<link href="a.css"><script src="https://x/y.js"></script><img src="data:x"><a href="#top"><script src="b.js?v=1">',
      ),
    ).toEqual(['a.css', 'b.js'])
  })
})
