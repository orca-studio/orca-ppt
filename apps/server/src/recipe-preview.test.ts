import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localRefs, previewFiles, previewKey, pruneOthers } from './recipe-preview.js'

async function fixture() {
  const skill = await mkdtemp(join(tmpdir(), 'preview-'))
  await mkdir(join(skill, 'runtime'), { recursive: true })
  await mkdir(join(skill, 'recipes/a'), { recursive: true })
  await writeFile(join(skill, 'runtime/engine.js'), 'v1')
  const entry = join(skill, 'recipes/a/index.html')
  await writeFile(
    entry,
    '<link href="../../runtime/x.css"><script src="../../runtime/engine.js"></script><section>A</section>',
  )
  return { skill, dir: join(skill, 'recipes/a'), entry }
}

describe('localRefs', () => {
  it('只收本地相对路径', () => {
    expect(
      localRefs(
        '<link href="a.css"><script src="https://x/y.js"></script><img src="data:x"><a href="#top"><script src="b.js?v=1">',
      ),
    ).toEqual(['a.css', 'b.js'])
  })
})

describe('previewKey', () => {
  it('样稿不变,键不变', async () => {
    const { dir, entry } = await fixture()
    expect(await previewKey(dir, entry)).toBe(await previewKey(dir, entry))
  })

  it('样稿改了,键变', async () => {
    const { dir, entry } = await fixture()
    const before = await previewKey(dir, entry)
    await writeFile(entry, '<script src="../../runtime/engine.js"></script><section>B</section>')
    expect(await previewKey(dir, entry)).not.toBe(before)
  })

  it('引擎改了,键也变 —— 同一份样稿换了引擎录出来就不一样', async () => {
    const { skill, dir, entry } = await fixture()
    const before = await previewKey(dir, entry)
    await writeFile(join(skill, 'runtime/engine.js'), 'v2')
    expect(await previewKey(dir, entry)).not.toBe(before)
  })
})

describe('previewFiles / pruneOthers', () => {
  it('缓存放在应用数据目录,每个同款只留最新一份', async () => {
    const { dir, entry } = await fixture()
    const cache = await mkdtemp(join(tmpdir(), 'cache-'))
    const env = { ORCA_PPT_PREVIEW_DIR: cache }
    const files = await previewFiles('a', dir, entry, env)
    expect(files.video).toBe(join(cache, 'a', `${files.key}.webm`))
    await mkdir(join(cache, 'a'), { recursive: true })
    await writeFile(files.video, 'v')
    await writeFile(files.poster, 'p')
    await writeFile(join(cache, 'a', 'old.webm'), 'x')
    await pruneOthers(files)
    expect((await readdir(join(cache, 'a'))).sort()).toEqual(
      [`${files.key}.jpg`, `${files.key}.webm`].sort(),
    )
  })
})
