import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeEntities, instantiate, listTemplates, rewriteRoot } from './templates.js'

/** 照 skill 的布局搭一份假的。 */
async function fakeSkill() {
  const root = await mkdtemp(join(tmpdir(), 'skill-'))
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(
    join(root, 'templates/starter.html'),
    '<head><title>{{TITLE}}</title>' +
      '<link href="{{ROOT}}/runtime/tokens.css"></head>' +
      '<p>{{TITLE}}</p><script src="{{ROOT}}/runtime/engine.js"></script>',
  )

  const example = join(root, 'examples', 'forest-timeline')
  await mkdir(join(example, 'photos'), { recursive: true })
  await writeFile(
    join(example, 'index.html'),
    `<title>Four Stops · Editorial Forest · 时间线</title>
     <link href="../../runtime/tokens.css"><img src="photos/a.jpg">`,
  )
  await writeFile(join(example, 'photos/a.jpg'), 'jpg')
  await writeFile(join(example, 'thumb.jpg'), 'thumb')
  await writeFile(join(example, 'index.mp4'), 'video')

  // 内部目录不是示例
  await mkdir(join(root, 'examples', '_assets'), { recursive: true })
  return root
}

describe('listTemplates', () => {
  it('列出空白模板和示例', async () => {
    const list = await listTemplates(await fakeSkill())
    expect(list.map((item) => item.id)).toEqual([
      'template:starter.html',
      'example:forest-timeline',
    ])
  })

  it('示例的标题取 <title> 的第一段 —— 后面挂的是主题名和版式,列表里太长', async () => {
    const list = await listTemplates(await fakeSkill())
    expect(list.find((item) => item.kind === 'example')?.title).toBe('Four Stops')
  })

  it('示例带上 skill 自己生成的 thumb.jpg,不用我们再渲', async () => {
    const list = await listTemplates(await fakeSkill())
    expect(list.find((item) => item.kind === 'example')?.thumbnail).toContain('thumb.jpg')
  })

  it('下划线开头的内部目录不算示例', async () => {
    const list = await listTemplates(await fakeSkill())
    expect(list.some((item) => item.id.includes('_assets'))).toBe(false)
  })

  it('没有 skill 时给空表,不抛', async () => {
    expect(await listTemplates(undefined)).toEqual([])
  })
})

describe('instantiate', () => {
  it('空白模板:{{ROOT}} 换成到 skill 的相对路径', async () => {
    const skillPath = await fakeSkill()
    const targetDir = join(await mkdtemp(join(tmpdir(), 'decks-')), '我的稿子')
    await instantiate({ skillPath, templateId: 'template:starter.html', targetDir })

    const html = await readFile(join(targetDir, 'deck.html'), 'utf8')
    expect(html).not.toContain('{{ROOT}}')

    const href = html.match(/href="([^"]*runtime\/tokens\.css)"/)![1]!
    expect(resolve(targetDir, href)).toBe(join(skillPath, 'runtime/tokens.css'))
  })

  it('示例:复制过去并把 ../../ 重写成新位置到 skill 的路径', async () => {
    const skillPath = await fakeSkill()
    const targetDir = join(await mkdtemp(join(tmpdir(), 'decks-')), '复盘')
    await instantiate({ skillPath, templateId: 'example:forest-timeline', targetDir })

    const html = await readFile(join(targetDir, 'deck.html'), 'utf8')

    // 验的是「解析出来指向哪」,不是字符串长什么样 —— 新路径可能恰好也以 ../../ 开头
    const href = html.match(/href="([^"]*runtime\/tokens\.css)"/)![1]!
    expect(resolve(targetDir, href)).toBe(join(skillPath, 'runtime/tokens.css'))

    // 自带的素材跟着走,稿子内部的相对引用不动
    expect(html).toContain('src="photos/a.jpg"')
    expect(await readFile(join(targetDir, 'photos/a.jpg'), 'utf8')).toBe('jpg')
  })

  it('录制产物和缩略图不跟着复制 —— 那是示例的,不是新稿子的', async () => {
    const skillPath = await fakeSkill()
    const targetDir = join(await mkdtemp(join(tmpdir(), 'decks-')), 'x')
    await instantiate({ skillPath, templateId: 'example:forest-timeline', targetDir })

    await expect(readFile(join(targetDir, 'index.mp4'))).rejects.toThrow()
    await expect(readFile(join(targetDir, 'thumb.jpg'))).rejects.toThrow()
  })

  it('建出来就带 .deck/,阶段产物有地方落', async () => {
    const skillPath = await fakeSkill()
    const targetDir = join(await mkdtemp(join(tmpdir(), 'decks-')), 'y')
    await instantiate({ skillPath, templateId: 'template:starter.html', targetDir })
    await writeFile(join(targetDir, '.deck/probe'), 'x')
  })

  it('不认识的模板 id 如实报错', async () => {
    const skillPath = await fakeSkill()
    await expect(
      instantiate({ skillPath, templateId: '随便写的', targetDir: '/tmp/x' }),
    ).rejects.toThrow('不认识的模板')
  })
})

describe('rewriteRoot', () => {
  it('单双引号都认', () => {
    expect(rewriteRoot(`<a href="../../runtime/a.css"><b src='../../x.js'>`, '../skill')).toBe(
      `<a href="../skill/runtime/a.css"><b src='../skill/x.js'>`,
    )
  })

  it('稿子内部的相对引用不动', () => {
    expect(rewriteRoot('<img src="photos/a.jpg">', '../skill')).toBe('<img src="photos/a.jpg">')
  })
})

describe('decodeEntities', () => {
  it('解开 <title> 里的转义 —— 不然列表里会出现「Studio &amp; Salon」', () => {
    expect(decodeEntities('Studio &amp; Salon')).toBe('Studio & Salon')
    expect(decodeEntities('&lt;标签&gt; &quot;引号&quot;')).toBe('<标签> "引号"')
  })

  it('不认识的实体原样留着,不吞字', () => {
    expect(decodeEntities('a &hearts; b')).toBe('a &hearts; b')
  })
})

describe('instantiate 在软链路径下', () => {
  it('两边都 realpath 之后再算相对路径 —— 差一级的话资源全白,而入口页照样 200', async () => {
    const skillPath = await fakeSkill()
    const real = await mkdtemp(join(tmpdir(), 'real-'))
    const link = join(await mkdtemp(join(tmpdir(), 'link-')), 'decks')
    await symlink(real, link)

    const targetDir = join(link, '稿子')
    await instantiate({ skillPath, templateId: 'template:starter.html', targetDir })

    const html = await readFile(join(targetDir, 'deck.html'), 'utf8')
    const href = html.match(/href="([^"]*runtime\/tokens\.css)"/)![1]!
    // 从**真实**位置解析,才是浏览器实际会走的路
    expect(resolve(await realpath(targetDir), href)).toBe(
      join(await realpath(skillPath), 'runtime/tokens.css'),
    )
  })
})

describe('空白模板配主题', () => {
  it('主题接在 tokens.css 后面 —— 顺序反了就被盖回缺省值', async () => {
    const skill = await fakeSkill()
    const target = join(await mkdtemp(join(tmpdir(), 'deck-')), 'new')
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: target,
      theme: 'editorial-forest',
      title: '山野咖啡',
    })
    const html = await readFile(join(target, 'deck.html'), 'utf8')
    const tokensAt = html.indexOf('runtime/tokens.css')
    const themeAt = html.indexOf('runtime/themes/editorial-forest.css')
    expect(themeAt).toBeGreaterThan(tokensAt)
  })

  it('替掉 {{TITLE}} —— 不替的话新稿子上就写着「{{TITLE}}」', async () => {
    const skill = await fakeSkill()
    const target = join(await mkdtemp(join(tmpdir(), 'deck-')), 'new')
    await instantiate({
      skillPath: skill,
      templateId: 'template:starter.html',
      targetDir: target,
      title: '山野咖啡',
    })
    const html = await readFile(join(target, 'deck.html'), 'utf8')
    expect(html).toContain('山野咖啡')
    expect(html).not.toContain('{{TITLE}}')
  })

  it('不配主题就不挂 —— 不猜一个给人', async () => {
    const skill = await fakeSkill()
    const target = join(await mkdtemp(join(tmpdir(), 'deck-')), 'new')
    await instantiate({ skillPath: skill, templateId: 'template:starter.html', targetDir: target })
    expect(await readFile(join(target, 'deck.html'), 'utf8')).not.toContain('runtime/themes/')
  })
})
