import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listRecipes, recipeEntry } from '@orca-ppt/deck-core'

/**
 * PPTX 导出（skill 的 scripts/export-pptx.mjs）。三层：
 *   1. 回退表的执行端和 transitions.md「导出 PPTX」那张表一致 —— 改了表忘了改代码，这里报
 *   2. check-pptx 真能抓到坏包：拿一份好包，逐项改坏，每一项都得报错
 *   3. 每个同款样稿都能导出，导出的包过 check-pptx（要本机 Chrome，没装就跳过）
 */
const skill = fileURLToPath(new URL('../../../skills/orca-ppt/', import.meta.url))
const lib = (name: string) => import(pathToFileURL(join(skill, 'scripts/lib', name)).href)
const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: skill, encoding: 'utf8' })

/** 「导出 PPTX」表：手法名 → 档位。一格里可能写了几个手法（「一变多、多合一」） */
function fallbackTable(): Map<string, string> {
  const md = readFileSync(join(skill, 'references/transitions.md'), 'utf8')
  const section = md.slice(
    md.indexOf('## 导出 PPTX'),
    md.indexOf('\n## ', md.indexOf('## 导出 PPTX') + 1),
  )
  const rows = new Map<string, string>()
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    const tier = cells[1]
    const techniques = cells[2]
    if (!tier || !techniques || !['保真', '近似', '降级', '丢失'].includes(tier)) continue
    // 「共享元素 / 形态变换（包括…）」→ 去掉括号里的说明，再按顿号、斜杠拆
    for (const name of techniques.replace(/（[^）]*）/g, '').split(/[、/]/))
      rows.set(name.trim(), tier)
  }
  return rows
}

describe('PPTX 回退表', () => {
  it('执行端的每个手法都在表里，档位一致', async () => {
    const table = fallbackTable()
    const { PAGE_TECHNIQUES, ELEMENT_TECHNIQUES } = await lib('pptx-fallback.mjs')
    const all = [...Object.values(PAGE_TECHNIQUES), ...Object.values(ELEMENT_TECHNIQUES)] as {
      name: string
      tier: string
    }[]
    // 代码里一个名字可能对应表里的几个（「共享元素 / 形态变换」）
    const mismatched = all
      .flatMap((t) => t.name.split(' / ').map((name) => ({ name, tier: t.tier })))
      .filter((t) => table.get(t.name) !== t.tier)
      .map((t) => `${t.name}：代码 ${t.tier}，表里 ${table.get(t.name) ?? '没有'}`)
    expect(mismatched).toEqual([])
  })

  it('表里的每个手法，执行端都认', async () => {
    const { PAGE_TECHNIQUES, ELEMENT_TECHNIQUES } = await lib('pptx-fallback.mjs')
    const known = new Set(
      [...Object.values(PAGE_TECHNIQUES), ...Object.values(ELEMENT_TECHNIQUES)].flatMap((t) =>
        (t as { name: string }).name.split(' / '),
      ),
    )
    // 「丢失」档是网页里有、导不出来的效果（回顾片尾除外，它是手法），执行端用 LOST 报出来
    const table = [...fallbackTable()].filter(
      ([name, tier]) => tier !== '丢失' || name === '回顾片尾',
    )
    expect(table.filter(([name]) => !known.has(name)).map(([name]) => name)).toEqual([])
  })

  it('翻页按表选转场', async () => {
    const { pageTransition } = await lib('pptx-fallback.mjs')
    const base = { st: null, autoAnimate: true, shared: ['a'], duration: 1 }
    expect(pageTransition(base)).toMatchObject({ kind: 'morph', tier: '保真' })
    expect(pageTransition({ ...base, st: 'carry' })).toMatchObject({ kind: 'fade', tier: '降级' })
    expect(pageTransition({ ...base, st: 'mask', direction: 'up' })).toMatchObject({
      kind: 'wipe',
      dir: 'u',
      tier: '近似',
    })
    expect(pageTransition({ ...base, st: 'match-cut' })).toMatchObject({
      kind: 'none',
      tier: '保真',
    })
    // 元素级降级拖低整页档位，但不换转场
    expect(pageTransition({ ...base, text: true })).toMatchObject({ kind: 'morph', tier: '降级' })
    expect(pageTransition({ ...base, autoAnimate: false, shared: [] })).toMatchObject({
      kind: 'none',
    })
    expect(() => pageTransition({ ...base, st: 'no-such' })).toThrow(/没有对应项/)
  })
})

/** 两页的小稿子：q 是共享元素，第二页绕圆心转 */
async function sample() {
  const { buildPptx } = await lib('pptx-write.mjs')
  const run = (text: string) => ({ text, font: 'Inter', size: 32, color: '111111', alpha: 1 })
  const text = (lines: string[]) => ({
    insets: { l: 0, t: 0, r: 0, b: 0 },
    paras: lines.map((l) => ({ align: 'l', lineHeight: 40, runs: [run(l)] })),
  })
  const model = {
    media: new Map([['s2-0.png', Buffer.from('89504e470d0a1a0a', 'hex')]]),
    slides: [
      {
        background: { color: 'ffffff' },
        transition: { kind: 'none' },
        shapes: [
          {
            type: 'sp',
            name: '!!q',
            x: 100,
            y: 100,
            w: 200,
            h: 200,
            rot: 0,
            geom: 'rect',
            fill: { color: 'ff0000' },
          },
          {
            type: 'sp',
            name: 's1 t 2',
            x: 100,
            y: 400,
            w: 600,
            h: 80,
            geom: 'rect',
            text: text(['一行', '两行']),
          },
        ],
      },
      {
        background: { color: 'ffffff' },
        transition: { kind: 'morph', duration: 1 },
        shapes: [
          {
            type: 'sp',
            name: '!!q',
            x: 500,
            y: 100,
            w: 200,
            h: 200,
            rot: 30,
            geom: 'rect',
            fill: { color: 'ff0000' },
          },
          { type: 'pic', name: 's2 img 2', x: 0, y: 0, w: 10, h: 10, media: 's2-0.png' },
        ],
      },
    ],
  }
  const facts = { st: null, autoAnimate: true, shared: ['q'], turn: true, text: false, duration: 1 }
  const report = {
    slides: [
      {
        index: 1,
        facts: null,
        transition: { tier: '保真' },
        identities: ['q'],
        turn: ['q'],
        rasters: [],
        texts: ['一行', '两行'],
      },
      {
        index: 2,
        facts,
        transition: { tier: '保真' },
        identities: ['q'],
        turn: ['q'],
        rasters: [{ name: 'img', reason: '<img>' }],
        texts: [],
      },
    ],
    degraded: [],
  }
  return { pptx: buildPptx(model) as Buffer, report }
}

describe('check-pptx 抓得到坏包', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pptx-check-'))
  const check = (pptx: Buffer, report: unknown) => {
    writeFileSync(join(dir, 'deck.pptx'), pptx)
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report))
    return run('check-pptx.mjs', [join(dir, 'deck.pptx'), join(dir, 'report.json')])
  }
  /** 改包里一页的 XML */
  const tamper = async (pptx: Buffer, part: string, edit: (xml: string) => string) => {
    const { readZip, writeZip } = await lib('zip.mjs')
    const files = readZip(pptx) as Map<string, Buffer>
    const xml = files.get(part)!.toString('utf8')
    const changed = edit(xml)
    expect(changed).not.toBe(xml)
    files.set(part, Buffer.from(changed))
    return writeZip([...files].map(([name, data]) => ({ name, data }))) as Buffer
  }

  it('好包通过', async () => {
    const { pptx, report } = await sample()
    const result = check(pptx, report)
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  const cases: [string, string, (xml: string) => string, RegExp][] = [
    ['文字改了', 'ppt/slides/slide1.xml', (x) => x.replace('两行', '三行'), /文字或分段变了/],
    [
      '两段并成一段',
      'ppt/slides/slide1.xml',
      (x) => x.replace(/<\/a:t><\/a:r>.*?<a:r>.*?<a:t>两行/, '两行'),
      /文字或分段变了/,
    ],
    [
      '文本框会缩字',
      'ppt/slides/slide1.xml',
      (x) => x.replace('<a:noAutofit/>', '<a:normAutofit/>'),
      /缩字/,
    ],
    [
      '共享元素没起名字',
      'ppt/slides/slide1.xml',
      (x) => x.replace('name="!!q"', 'name="q"'),
      /!!q/,
    ],
    [
      '共享元素收成了组',
      'ppt/slides/slide1.xml',
      (x) =>
        x.replace(
          /<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="!!q"\/>.*?<\/p:sp>/,
          (sp) =>
            `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="99" name="!!q"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp.replace('name="!!q"', 'name="!!q~sp"')}</p:grpSp>`,
        ),
      /收成了组/,
    ],
    [
      '共享元素两块同名',
      'ppt/slides/slide1.xml',
      (x) => x.replace('name="!!q"', 'name="!!q~sp"').replace('name="s1 t 2"', 'name="!!q~sp"'),
      /!!q~sp 有 2 个/,
    ],
    ['旋转没写', 'ppt/slides/slide1.xml', (x) => x.replace(' rot="0"', ''), /没写旋转/],
    [
      '平滑变成淡入淡出',
      'ppt/slides/slide2.xml',
      (x) => x.replace(/<p159:morph[^>]*\/>/, '<p:fade/>'),
      /应该是 morph/,
    ],
    [
      '平滑没有回退',
      'ppt/slides/slide2.xml',
      (x) => x.replace(/<mc:Fallback>.*<\/mc:Fallback>/, ''),
      /回退/,
    ],
    [
      '多出一张图片',
      'ppt/slides/slide1.xml',
      (x) =>
        x.replace(
          '<p:sp>',
          '<p:pic><p:nvPicPr><p:cNvPr id="99" name="x"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic><p:sp>',
        ),
      /张图片/,
    ],
    ['形状 id 重复', 'ppt/slides/slide1.xml', (x) => x.replace('id="3"', 'id="2"'), /id 重复/],
    [
      '图片关系断了',
      'ppt/slides/_rels/slide2.xml.rels',
      (x) => x.replace('s2-0.png', 'missing.png'),
      /包里没有/,
    ],
  ]
  for (const [name, part, edit, message] of cases) {
    it(name, async () => {
      const { pptx, report } = await sample()
      const result = check(await tamper(pptx, part, edit), report)
      expect(result.status).toBe(1)
      expect(result.stdout).toMatch(message)
    })
  }

  it('降级没写进清单', async () => {
    const { pptx, report } = await sample()
    const bad = structuredClone(report)
    bad.slides[1]!.facts = { ...bad.slides[1]!.facts!, text: true }
    bad.slides[1]!.transition.tier = '降级'
    const result = check(pptx, bad)
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/降级清单/)
  })
})

/*
 * 每个同款样稿都导一遍、核一遍。要开本机 Chrome；没装就跳过，不算失败（和 check-deck 一样）。
 */
describe('同款样稿导出 PPTX', () => {
  it('每个样稿都能导出，导出的包过 check-pptx', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pptx-recipes-'))
    const failed: string[] = []
    for (const recipe of await listRecipes(skill)) {
      const entry = await recipeEntry(skill, recipe.id)
      if (!entry) continue
      const pptx = join(dir, `${recipe.id}.pptx`)
      const report = join(dir, `${recipe.id}.json`)
      const exported = run('export-pptx.mjs', [
        join(entry.dir, 'index.html'),
        '-o',
        pptx,
        '--json',
        report,
      ])
      if (exported.status !== 0 && /chrome|Executable|browserType\.launch/i.test(exported.stderr)) {
        context.skip()
      }
      if (exported.status !== 0) {
        failed.push(`${recipe.id} 导出失败：${exported.stderr}`)
        continue
      }
      const checked = run('check-pptx.mjs', [pptx, report])
      if (checked.status !== 0) failed.push(checked.stdout)
    }
    expect(failed).toEqual([])
  }, 240_000)
})

describe('竖排文字', () => {
  it('写成 eaVert 文本框，一列一段', async () => {
    const { buildPptx } = await lib('pptx-write.mjs')
    const { readZip } = await lib('zip.mjs')
    const run = (text: string) => ({ text, font: 'Kaiti SC', size: 36, color: '111111', alpha: 1 })
    const pptx = buildPptx({
      media: new Map(),
      slides: [
        {
          background: { color: 'ffffff' },
          transition: { kind: 'none' },
          shapes: [
            {
              type: 'sp',
              name: 's1 t 1',
              x: 100,
              y: 100,
              w: 130,
              h: 400,
              geom: 'rect',
              text: {
                insets: { l: 0, t: 0, r: 0, b: 0 },
                vertical: true,
                paras: ['争渡，争渡，', '惊起一滩鸥鹭。'].map((l) => ({
                  align: 'l',
                  lineHeight: 65,
                  runs: [run(l)],
                })),
              },
            },
          ],
        },
      ],
    }) as Buffer
    const xml = (readZip(pptx) as Map<string, Buffer>).get('ppt/slides/slide1.xml')!.toString()
    expect(xml).toContain('<a:bodyPr vert="eaVert"')
    expect(xml.match(/<a:p>/g)).toHaveLength(2)
  })
})

describe('渐变', () => {
  const build = async (shape: Record<string, unknown>) => {
    const { buildPptx } = await lib('pptx-write.mjs')
    const { readZip } = await lib('zip.mjs')
    const pptx = buildPptx({
      media: new Map(),
      slides: [
        {
          background: { color: '000000' },
          transition: { kind: 'none' },
          shapes: [
            { type: 'sp', name: 's1 g 1', x: 0, y: 0, w: 400, h: 200, geom: 'rect', ...shape },
          ],
        },
      ],
    }) as Buffer
    return (readZip(pptx) as Map<string, Buffer>).get('ppt/slides/slide1.xml')!.toString()
  }
  const stops = [
    { pos: 0, color: 'ff0000', alpha: 1 },
    { pos: 1, color: '0000ff', alpha: 0 },
  ]

  it('线性渐变写成原生渐变填充，角度换成 PowerPoint 的', async () => {
    const xml = await build({ fill: { grad: { type: 'linear', angle: 90, stops } } })
    expect(xml).toContain('<a:gradFill rotWithShape="1">')
    expect(xml).toContain('<a:lin ang="5400000" scaled="0"/>')
  })

  const gsOf = (xml: string) => [...xml.matchAll(/<a:gs pos="(\d+)"><a:srgbClr val="(\w+)">/g)]

  it('两个色标之间按 sRGB 补中间色标', async () => {
    const opaque = [stops[0]!, { ...stops[1]!, alpha: 1 }]
    const gs = gsOf(await build({ fill: { grad: { type: 'linear', angle: 0, stops: opaque } } }))
    expect(gs.length).toBeGreaterThan(2)
    // 红到蓝的正中是 sRGB 的平均
    expect(gs.find((g) => g[1] === '50000')?.[2]).toBe('800080')
    expect(gs.at(-1)![1]).toBe('100000')
  })

  it('全透明的一头取相邻的颜色，不混进透明那头的颜色', async () => {
    const gs = gsOf(await build({ fill: { grad: { type: 'linear', angle: 0, stops } } }))
    expect(gs.map((g) => g[2])).toEqual(gs.map(() => 'ff0000'))
  })

  it('径向渐变按路径写', async () => {
    const xml = await build({
      geom: 'ellipse',
      fill: { grad: { type: 'radial', angle: 0, path: 'shape', stops } },
    })
    expect(xml).toContain('<a:path path="shape">')
  })

  it('渐变字写在字的 rPr 里', async () => {
    const xml = await build({
      text: {
        insets: { l: 0, t: 0, r: 0, b: 0 },
        paras: [
          {
            align: 'l',
            lineHeight: 60,
            runs: [
              {
                text: '渐变',
                font: 'Inter',
                size: 48,
                color: 'ff0000',
                alpha: 1,
                grad: { type: 'linear', angle: 0, stops },
              },
            ],
          },
        ],
      },
    })
    expect(xml).toMatch(/<a:rPr [^>]*><a:gradFill/)
  })
})

describe('分段', () => {
  it('排版折出来的行并回一段、交给 PowerPoint 折，<br> 另起一段', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pptx-paras-'))
    const href = (path: string) => pathToFileURL(join(skill, path)).href
    writeFileSync(
      join(dir, 'deck.html'),
      `<!doctype html><html lang="zh-CN" data-layout="standard"><head><meta charset="utf-8"><title>分段</title>
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reset.css')}">
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reveal.css')}">
<link rel="stylesheet" href="${href('runtime/tokens.css')}">
<link rel="stylesheet" href="${href('runtime/themes/editorial-forest.css')}">
</head><body><div class="reveal"><div class="slides"><section>
<p class="t-body" style="left:100px; top:100px; width:400px;">The quick brown fox jumps over the lazy dog and keeps on running.</p>
<p class="t-body" style="left:100px; top:500px; width:1200px;">第一行<br>第二行</p>
<p class="t-h1" style="left:100px; top:800px; width:1600px;">一行的标题</p>
</section></div></div>
<script src="${href('node_modules/reveal.js/dist/reveal.js')}"></script>
<script src="${href('node_modules/gsap/dist/gsap.min.js')}"></script>
<script src="${href('runtime/engine.js')}"></script></body></html>`,
    )
    const exported = run('export-pptx.mjs', [
      join(dir, 'deck.html'),
      '-o',
      join(dir, 'deck.pptx'),
      '--json',
      join(dir, 'report.json'),
    ])
    if (exported.status !== 0 && /chrome|Executable|browserType\.launch/i.test(exported.stderr)) {
      context.skip()
    }
    expect(exported.status, exported.stderr).toBe(0)
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.slides[0].texts).toEqual([
      'The quick brown fox jumps over the lazy dog and keeps on running.',
      '第一行',
      '第二行',
      '一行的标题',
    ])
    const { readZip } = await lib('zip.mjs')
    const xml = (readZip(readFileSync(join(dir, 'deck.pptx'))) as Map<string, Buffer>)
      .get('ppt/slides/slide1.xml')!
      .toString()
    // 折了行的那段交给 PowerPoint 折；<br> 分开的两段、单行的标题都不折
    expect(xml.match(/wrap="square"/g)).toHaveLength(1)
    expect(xml.match(/wrap="none"/g)).toHaveLength(2)
    const checked = run('check-pptx.mjs', [join(dir, 'deck.pptx'), join(dir, 'report.json')])
    expect(checked.status, checked.stdout).toBe(0)
  }, 60_000)
})

describe('截图存 JPG 还是 PNG', () => {
  /** 拼一张 RGBA 的 PNG：每行一个过滤方式（0 不过滤、2 减上一行），alpha 由 alphas 给 */
  const png = (width: number, rows: number[][], filters: number[]) => {
    const raw: number[] = []
    let prev = new Array(width * 4).fill(0)
    rows.forEach((alphas, y) => {
      const row = alphas.flatMap((a, x) => [x * 40, y * 90, 200, a])
      raw.push(
        filters[y]!,
        ...row.map((v, i) => (filters[y] === 2 ? (v - prev[i]! + 256) % 256 : v)),
      )
      prev = row
    })
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(data.length)
      head.write(type, 4, 'latin1')
      return Buffer.concat([head, data, Buffer.alloc(4)])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(rows.length, 4)
    ihdr.set([8, 6, 0, 0, 0], 8)
    return Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from(raw))),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }

  it('全不透明的才算不透明，哪怕只有一个像素透一点', async () => {
    const { opaque } = await lib('png.mjs')
    expect(
      opaque(
        png(
          3,
          [
            [255, 255, 255],
            [255, 255, 255],
          ],
          [0, 2],
        ),
      ),
    ).toBe(true)
    expect(
      opaque(
        png(
          3,
          [
            [255, 255, 255],
            [255, 254, 255],
          ],
          [0, 2],
        ),
      ),
    ).toBe(false)
    expect(
      opaque(
        png(
          3,
          [
            [0, 255, 255],
            [255, 255, 255],
          ],
          [2, 0],
        ),
      ),
    ).toBe(false)
  })
})

describe('嵌入字体', () => {
  const fontDir = join(skill, 'runtime/fonts/pptx')
  const fonts = JSON.parse(readFileSync(join(fontDir, 'fonts.json'), 'utf8')) as {
    family: string
    weight: number
    style: string
    file: string
    typeface: string
    subfamily: string
  }[]

  it('每个字体文件的名字就是清单里写的：400 / 700 叫家族名，别的字重带字重名', async () => {
    const { fontNames } = await lib('ttf.mjs')
    for (const f of fonts) {
      expect(fontNames(readFileSync(join(fontDir, f.file)))).toEqual({
        family: f.typeface,
        subfamily: f.subfamily,
      })
      if (f.weight === 400 || f.weight === 700) expect(f.typeface).toBe(f.family)
      else expect(f.typeface).toMatch(new RegExp(`^${f.family} `))
    }
  })

  it('EOT 头指向的字体数据就是原来的 .ttf', async () => {
    const { eot } = await lib('ttf.mjs')
    const ttf = readFileSync(join(fontDir, fonts[0]!.file))
    const data = eot(ttf) as Buffer
    expect(data.readUInt32LE(0)).toBe(data.length)
    expect(data.readUInt32LE(4)).toBe(ttf.length)
    expect(data.readUInt16LE(34)).toBe(0x504c) // MagicNumber
    expect(data.subarray(data.length - ttf.length).equals(ttf)).toBe(true)
  })

  it('字体写进 embeddedFontLst，按档对上关系和 fntdata', async () => {
    const { buildPptx } = await lib('pptx-write.mjs')
    const { readZip } = await lib('zip.mjs')
    const files = readZip(
      buildPptx({
        media: new Map(),
        fonts: [{ typeface: 'Inter', regular: Buffer.from('r'), bold: Buffer.from('b') }],
        slides: [{ background: { color: 'ffffff' }, transition: { kind: 'none' }, shapes: [] }],
      }),
    ) as Map<string, Buffer>
    const presentation = files.get('ppt/presentation.xml')!.toString()
    expect(presentation).toContain('embedTrueTypeFonts="1"')
    expect(presentation).toMatch(
      /<p:notesSz [^>]*\/><p:embeddedFontLst><p:embeddedFont><p:font typeface="Inter"\/><p:regular r:id="(rId\d+)"\/><p:bold r:id="(rId\d+)"\/>/,
    )
    const rels = files.get('ppt/_rels/presentation.xml.rels')!.toString()
    for (const [, id] of presentation.matchAll(/<p:(?:regular|bold) r:id="(rId\d+)"/g)) {
      const target = new RegExp(`Id="${id}" Type="[^"]+/font" Target="([^"]+)"`).exec(rels)?.[1]
      expect(files.has(`ppt/${target}`)).toBe(true)
    }
    expect(files.get('[Content_Types].xml')!.toString()).toContain('Extension="fntdata"')
  })

  it('PingFang 换成微软雅黑，西文字体名里的 Han 不算中文字体', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pptx-fonts-'))
    const href = (path: string) => pathToFileURL(join(skill, path)).href
    writeFileSync(
      join(dir, 'deck.html'),
      `<!doctype html><html lang="zh-CN" data-layout="standard"><head><meta charset="utf-8"><title>字体</title>
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reset.css')}">
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reveal.css')}">
<link rel="stylesheet" href="${href('runtime/tokens.css')}">
</head><body><div class="reveal"><div class="slides"><section>
<p class="t-body" style="left:100px; top:100px; font-family:'PingFang SC', sans-serif;">苹方 PingFang</p>
<p class="t-body" style="left:100px; top:400px; font-family:'Hanken Grotesk', 'Helvetica Neue', 'PingFang SC', sans-serif;">混排 Hanken</p>
</section></div></div>
<script src="${href('node_modules/reveal.js/dist/reveal.js')}"></script>
<script src="${href('node_modules/gsap/dist/gsap.min.js')}"></script>
<script src="${href('runtime/engine.js')}"></script></body></html>`,
    )
    const exported = run('export-pptx.mjs', [
      join(dir, 'deck.html'),
      '-o',
      join(dir, 'deck.pptx'),
      '--json',
      join(dir, 'report.json'),
    ])
    if (exported.status !== 0 && /chrome|Executable|browserType\.launch/i.test(exported.stderr)) {
      context.skip()
    }
    expect(exported.status, exported.stderr).toBe(0)
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.substitutedFonts).toEqual([{ from: 'PingFang SC', to: 'Microsoft YaHei' }])
    expect(report.fonts).toEqual(['Microsoft YaHei'])
    const { readZip } = await lib('zip.mjs')
    const xml = (readZip(readFileSync(join(dir, 'deck.pptx'))) as Map<string, Buffer>)
      .get('ppt/slides/slide1.xml')!
      .toString()
    expect(xml).not.toContain('typeface="PingFang')
    expect(xml).toContain('<a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/>')
    expect(xml).toContain('<a:latin typeface="Hanken Grotesk"/><a:ea typeface="Microsoft YaHei"/>')
  }, 60_000)
})
