import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { instantiate, instantiateSample, listTemplates } from './templates.js'

/** 照 skill 的布局搭一份假的。**只搭产品用得到的那部分** —— examples/ 产品不读。 */
async function fakeSkill() {
  const root = await mkdtemp(join(tmpdir(), 'skill-'))
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(
    join(root, 'templates/starter.html'),
    '<head><title>{{TITLE}}</title>' +
      '<link href="{{ROOT}}/runtime/tokens.css"></head>' +
      '<p>{{TITLE}}</p><script src="{{ROOT}}/runtime/engine.js"></script>',
  )
  await writeFile(join(root, 'templates/story-starter.html'), '<p>{{TITLE}}</p>')
  return root
}

const target = async () => join(await mkdtemp(join(tmpdir(), 'deck-')), 'new')

describe('listTemplates', () => {
  it('只列空白起始文件 —— examples/ 是 skill 自己的技术参考,不是产品的模板', async () => {
    const list = await listTemplates(await fakeSkill())
    expect(list.map((item) => item.title)).toEqual(['汇报稿', '故事稿'])
    expect(list.map((item) => item.mode)).toEqual(['standard', 'story'])
  })

  it('skill 里少一份起始文件就少一条,不抛', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-'))
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(join(root, 'templates/starter.html'), 'x')
    expect(await listTemplates(root)).toHaveLength(1)
  })

  it('没有 skill 时是空 —— 界面自己去说「找不到 skill」', async () => {
    expect(await listTemplates(undefined)).toEqual([])
  })
})

describe('instantiate', () => {
  it('把 {{ROOT}} 换成从新位置回到 skill 的相对路径', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({ skillPath: skill, templateId: 'template:starter.html', targetDir: dir })
    const html = await readFile(join(dir, 'deck.html'), 'utf8')
    expect(html).not.toContain('{{ROOT}}')
    expect(html).toContain('/runtime/tokens.css')
  })

  it('替掉 {{TITLE}} —— 不替的话新稿子上就写着「{{TITLE}}」', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: dir,
      title: '山野咖啡',
    })
    const html = await readFile(join(dir, 'deck.html'), 'utf8')
    expect(html).toContain('山野咖啡')
    expect(html).not.toContain('{{TITLE}}')
  })

  it('主题接在 tokens.css 后面 —— 顺序反了就被盖回缺省值', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: dir,
      theme: 'editorial-forest',
    })
    const html = await readFile(join(dir, 'deck.html'), 'utf8')
    expect(html.indexOf('themes/editorial-forest.css')).toBeGreaterThan(
      html.indexOf('runtime/tokens.css'),
    )
  })

  it('不配主题就不挂 —— 不猜一个给人', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({ skillPath: skill, templateId: 'template:starter.html', targetDir: dir })
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).not.toContain('runtime/themes/')
  })

  it('从示例新建已经不支持了 —— 明确报错,不静默做别的', async () => {
    const skill = await fakeSkill()
    await expect(
      instantiate({
        skillPath: skill,
        templateId: 'example:story-circle',
        targetDir: await target(),
      }),
    ).rejects.toThrow('只能从空白起始文件新建')
  })

  it('建出 .deck 目录 —— 阶段产物要有地方放', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({ skillPath: skill, templateId: 'template:starter.html', targetDir: dir })
    await expect(readFile(join(dir, '.deck'), 'utf8')).rejects.toThrow(/EISDIR|directory/)
  })

  /**
   * macOS 的 /tmp 是指向 /private/tmp 的软链。两边不 realpath 的话层数会差一级,
   * 重写出来的路径指向一个不存在的地方 —— 而且**入口页照样 200**,只有资源全白。
   * 这个坑在这个仓库里踩过不止一次,所以留一条测试守着。
   */
  it('软链路径下算出来的相对路径仍然指得回 skill', async () => {
    const real = await fakeSkill()
    const link = join(await mkdtemp(join(tmpdir(), 'link-')), 'skill')
    await symlink(real, link)
    const dir = await target()
    await instantiate({ skillPath: link, templateId: 'template:starter.html', targetDir: dir })

    const html = await readFile(join(dir, 'deck.html'), 'utf8')
    const href = html.match(/href="([^"]*runtime\/tokens\.css)"/)?.[1]
    expect(href).toBeDefined()
    const resolved = join(await realpath(dir), href!)
    await expect(
      readFile(join(await realpath(real), 'templates/starter.html'), 'utf8'),
    ).resolves.toBeDefined()
    expect(resolved).toContain(await realpath(real))
  })
})

describe('配色', () => {
  it('配色接在主题后面 —— 顺序反了那 8 个颜色就被主题盖回去了', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: dir,
      theme: 'editorial-forest',
      palette: 'forest',
    })
    const html = await readFile(join(dir, 'deck.html'), 'utf8')
    expect(html.indexOf('palettes/forest.css')).toBeGreaterThan(
      html.indexOf('themes/editorial-forest.css'),
    )
  })

  it('只给主题不给配色也能建 —— 但那是一份没有颜色的稿子', async () => {
    const skill = await fakeSkill()
    const dir = await target()
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: dir,
      theme: 'editorial-forest',
    })
    expect(await readFile(join(dir, 'deck.html'), 'utf8')).not.toContain('palettes/')
  })
})

it('注释里的示例 link 不会吞掉新插入的主题和配色', async () => {
  const skill = await fakeSkill()
  await writeFile(
    join(skill, 'templates/starter.html'),
    '<head><link rel="stylesheet" href="{{ROOT}}/runtime/tokens.css">\n<!-- 示例:\n<link rel="stylesheet" href="example.css">\n-->\n</head>',
  )
  const dir = await target()
  await instantiate({
    skillPath: skill,
    templateId: 'template:starter.html',
    targetDir: dir,
    theme: 'editorial-forest',
    palette: 'forest',
  })
  const active = (await readFile(join(dir, 'deck.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '')
  expect(active).toContain('themes/editorial-forest.css')
  expect(active).toContain('palettes/forest.css')
})

describe('instantiateSample(做同款从样稿起头)', () => {
  async function fakeSample() {
    const skill = await mkdtemp(join(tmpdir(), 'skill-'))
    const dir = join(skill, 'examples/drink')
    await mkdir(join(dir, 'assets'), { recursive: true })
    await mkdir(join(skill, 'examples/_assets'), { recursive: true })
    await writeFile(join(dir, 'assets/a.svg'), '<svg/>')
    await writeFile(join(dir, 'RECIPE.md'), '配方')
    await writeFile(join(dir, 'index.mp4'), 'x')
    await writeFile(
      join(dir, 'index.html'),
      '<head><title>样稿</title><link href="../../runtime/tokens.css"></head>' +
        '<img src="assets/a.svg"><video src="../_assets/clip.mp4"></video>' +
        '<div style="background:url(\'assets/a.svg\')"></div><a href="https://x.dev">x</a>',
    )
    return { skill, dir }
  }

  it('引到样稿外的路径改成从新位置回去,样稿里的素材复制过来', async () => {
    const { skill, dir } = await fakeSample()
    const out = await target()
    const entry = await instantiateSample({
      sampleDir: dir,
      entry: join(dir, 'index.html'),
      targetDir: out,
      title: '我的 <稿>',
    })
    const html = await readFile(entry, 'utf8')
    const realOut = await realpath(out)
    const tokens = html.match(/href="([^"]*tokens\.css)"/)?.[1]
    expect(join(realOut, tokens!)).toBe(join(await realpath(skill), 'runtime/tokens.css'))
    const clip = html.match(/src="([^"]*clip\.mp4)"/)?.[1]
    expect(join(realOut, clip!)).toBe(join(await realpath(skill), 'examples/_assets/clip.mp4'))
    expect(html).toContain('src="assets/a.svg"')
    expect(html).toContain("url('assets/a.svg')")
    expect(html).toContain('href="https://x.dev"')
    expect(html).toContain('<title>我的 &lt;稿&gt;</title>')
    await expect(readFile(join(out, 'assets/a.svg'), 'utf8')).resolves.toBe('<svg/>')
  })

  it('配方、样片这些没被引用的文件不跟过来', async () => {
    const { dir } = await fakeSample()
    const out = await target()
    await instantiateSample({ sampleDir: dir, entry: join(dir, 'index.html'), targetDir: out })
    await expect(stat(join(out, 'RECIPE.md'))).rejects.toThrow()
    await expect(stat(join(out, 'index.mp4'))).rejects.toThrow()
    await expect(stat(join(out, '.deck'))).resolves.toBeDefined()
  })
})
