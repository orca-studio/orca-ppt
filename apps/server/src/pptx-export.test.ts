import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
    ['文字改了', 'ppt/slides/slide1.xml', (x) => x.replace('两行', '三行'), /文字或换行变了/],
    [
      '换行合并了',
      'ppt/slides/slide1.xml',
      (x) => x.replace(/<\/a:t><\/a:r>.*?<a:r>.*?<a:t>两行/, '两行'),
      /文字或换行变了/,
    ],
    [
      '文本框会自动换行',
      'ppt/slides/slide1.xml',
      (x) => x.replace('wrap="none"', 'wrap="square"'),
      /自动换行/,
    ],
    [
      '共享元素没起名字',
      'ppt/slides/slide1.xml',
      (x) => x.replace('name="!!q"', 'name="q"'),
      /!!q/,
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
