import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 读现成的 PPTX（skill 的 scripts/lib/pptx-read.mjs、scripts/extract-pptx.mjs）。
 * 同款导出的包读回来对不对，在 pptx-export.test.ts 的同款测试里核；那些包没有占位符、表格、
 * 图表、备注和组合，这里手写一份 PowerPoint 风格的小包把这些都走一遍。
 */
const skill = fileURLToPath(new URL('../../../skills/orca-ppt/', import.meta.url))
const lib = (name: string) => import(pathToFileURL(join(skill, 'scripts/lib', name)).href)

// 4:3 的页，9144000 EMU 宽：1 画布像素 = 4762.5 EMU
const px = (v: number) => Math.round(v * 4762.5)
const xfrm = (x: number, y: number, w: number, h: number, tag = 'a:xfrm') =>
  `<${tag}><a:off x="${px(x)}" y="${px(y)}"/><a:ext cx="${px(w)}" cy="${px(h)}"/></${tag}>`
const ph = (type: string | null, idx?: number) =>
  `<p:nvPr><p:ph${type ? ` type="${type}"` : ''}${idx === undefined ? '' : ` idx="${idx}"`}/></p:nvPr>`
const sp = (id: number, name: string, nvPr: string, spPr: string, body = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/>${nvPr}</p:nvSpPr>` +
  `<p:spPr>${spPr}</p:spPr>${body && `<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody>`}</p:sp>`
const para = (text: string, pPr = '', rPr = '') =>
  `<a:p>${pPr}<a:r>${rPr || '<a:rPr lang="zh-CN"/>'}<a:t>${text}</a:t></a:r></a:p>`
const tree = (shapes: string) =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr/>${shapes}</p:spTree>`
const rels = (list: [string, string, string][]) =>
  `<Relationships>${list
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`,
    )
    .join('')}</Relationships>`

async function samplePptx(): Promise<Buffer> {
  const { writeZip } = await lib('zip.mjs')
  const tc = (text: string, attrs = '') =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/>${para(text)}</a:txBody></a:tc>`
  const parts: Record<string, string> = {
    '_rels/.rels': rels([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'metadata/core-properties', 'docProps/core.xml'],
    ]),
    'docProps/core.xml': '<cp:coreProperties><dc:title>季度复盘</dc:title></cp:coreProperties>',
    'ppt/presentation.xml':
      '<p:presentation><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
      '<p:sldSz cx="9144000" cy="6858000"/>' +
      '<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
    ]),
    'ppt/theme/theme1.xml':
      '<a:theme><a:themeElements><a:clrScheme name="t">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
      '<a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>' +
      '<a:fontScheme name="t"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
    // 母版：占位符的位置、标题和正文的样式、背景
    'ppt/slideMasters/slideMaster1.xml':
      '<p:sldMaster><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg>' +
      tree(
        sp(2, 'Title', ph('title'), xfrm(100, 100, 1720, 200)) +
          sp(3, 'Body', ph('body', 1), xfrm(100, 360, 1720, 900)),
      ) +
      '</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>' +
      '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
      '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="2800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>' +
      '<a:lvl2pPr><a:buChar char="–"/><a:defRPr sz="2400"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
    // 版式：标题照母版，正文换了位置
    'ppt/slideLayouts/slideLayout1.xml':
      '<p:sldLayout><p:cSld name="Title and Content">' +
      tree(
        sp(2, 'Title', ph('title'), '') + sp(3, 'Content', ph(null, 1), xfrm(100, 400, 1720, 800)),
      ) +
      '</p:cSld></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
      ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
    ]),
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld>' +
      tree(
        sp(2, 'Title 1', ph('title'), '', para('季度复盘')) +
          sp(
            3,
            'Content 2',
            ph(null, 1),
            '',
            para('收入增长') +
              para('华东 +20%', '<a:pPr lvl="1"/>') +
              para(
                '华南 +12%',
                '<a:pPr lvl="1"><a:buNone/></a:pPr>',
                '<a:rPr sz="2000"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>',
              ),
          ) +
          // 空的占位符不算一块
          sp(4, 'Footer', ph('ftr', 11), '') +
          // 组：子坐标系缩一半
          '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
          `<p:grpSpPr><a:xfrm><a:off x="${px(200)}" y="${px(1000)}"/><a:ext cx="${px(400)}" cy="${px(200)}"/>` +
          `<a:chOff x="0" y="0"/><a:chExt cx="${px(800)}" cy="${px(400)}"/></a:xfrm></p:grpSpPr>` +
          sp(6, 'In group', '<p:nvPr/>', xfrm(400, 0, 400, 200), para('组里')) +
          sp(
            7,
            'Dot',
            '<p:nvPr/>',
            xfrm(0, 0, 100, 100) +
              '<a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>',
          ) +
          '</p:grpSp>' +
          '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
          xfrm(100, 1200, 800, 200, 'p:xfrm') +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
          `<a:tr>${tc('地区')}${tc('收入')}</a:tr><a:tr>${tc('华东')}${tc('1.2')}</a:tr>` +
          `<a:tr>${tc('合计', ' gridSpan="2"')}${tc('', ' hMerge="1"')}</a:tr>` +
          '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>' +
          '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
          xfrm(1000, 1200, 800, 200, 'p:xfrm') +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
          '<c:chart r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>' +
          '<p:pic><p:nvPicPr><p:cNvPr id="10" name="Logo" descr="公司标志"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
          `<p:blipFill><a:blip r:embed="rId4"/></p:blipFill><p:spPr>${xfrm(1700, 40, 180, 60)}</p:spPr></p:pic>`,
      ) +
      '</p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ['rId3', 'chart', '../charts/chart1.xml'],
      ['rId4', 'image', '../media/image1.png'],
    ]),
    'ppt/charts/chart1.xml':
      '<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>季度收入</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
      '<c:plotArea><c:barChart><c:barDir val="col"/><c:ser>' +
      '<c:tx><c:strRef><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>收入</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
      '<c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1.2</c:v></c:pt><c:pt idx="1"><c:v>1.5</c:v></c:pt></c:numCache></c:numRef></c:val>' +
      '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
    'ppt/notesSlides/notesSlide1.xml':
      '<p:notes><p:cSld>' +
      tree(sp(2, 'Image', ph('sldImg'), '') + sp(3, 'Notes', ph('body', 1), '', para('先讲增长'))) +
      '</p:cSld></p:notes>',
    // 第二页：藏起来的，背景是自己的
    'ppt/slides/slide2.xml':
      '<p:sld show="0"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg>' +
      tree(sp(2, 'TextBox 1', '<p:nvPr/>', xfrm(100, 100, 400, 100), para('附录'))) +
      '</p:cSld></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
    ]),
  }
  const files = Object.entries(parts).map(([name, xml]) => ({
    name,
    data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml),
  }))
  files.push({ name: 'ppt/media/image1.png', data: Buffer.from('png') })
  return writeZip(files) as Buffer
}

describe('pptx-read', () => {
  it('解开占位符的继承：位置、字号、字重、主题色和主题字体', async () => {
    const { readPptx } = await lib('pptx-read.mjs')
    const deck = readPptx(await samplePptx())
    expect(deck.title).toBe('季度复盘')
    expect(deck.size).toEqual({ w: 1920, h: 1440 })
    const [first] = deck.slides
    expect(first.layout).toBe('Title and Content')
    expect(first.title).toBe('季度复盘')
    // 背景在母版上，写的是 bg1，颜色映射到 lt1
    expect(first.background).toEqual({ color: '#ffffff' })

    const [title, content] = first.blocks
    expect(title).toMatchObject({
      kind: 'text',
      role: 'title',
      box: { x: 100, y: 100, w: 1720, h: 200 },
      paragraphs: [
        { text: '季度复盘', size: 117.3, bold: true, color: '#000000', font: 'Aptos Display' },
      ],
    })
    // 正文的位置在版式上，样式在母版上；第二级换了项目符号，第三段自己关了符号、改了字号和颜色
    expect(content.role).toBe('body')
    expect(content.box).toEqual({ x: 100, y: 400, w: 1720, h: 800 })
    expect(content.paragraphs).toEqual([
      { text: '收入增长', level: 0, bullet: '•', size: 74.7, font: 'Aptos' },
      { text: '华东 +20%', level: 1, bullet: '–', size: 64, font: 'Aptos' },
      { text: '华南 +12%', level: 1, size: 53.3, color: '#ff0000', font: 'Aptos' },
    ])
  })

  it('组、表格、图表、图片、备注和隐藏的页', async () => {
    const { readPptx } = await lib('pptx-read.mjs')
    const deck = readPptx(await samplePptx())
    const [first, second] = deck.slides
    const blocks = first.blocks.slice(2)
    // 空的页脚占位符不算；组里的坐标换回页上
    expect(blocks.map((b: { kind: string }) => b.kind)).toEqual([
      'text',
      'shape',
      'table',
      'chart',
      'image',
    ])
    expect(blocks[0]).toMatchObject({ box: { x: 400, y: 1000, w: 200, h: 100 } })
    expect(blocks[1]).toMatchObject({
      geom: 'ellipse',
      fill: '#4472c4',
      box: { x: 200, y: 1000, w: 50, h: 50 },
    })
    expect(blocks[2].rows).toEqual([
      ['地区', '收入'],
      ['华东', '1.2'],
      ['合计', ''],
    ])
    expect(blocks[3]).toMatchObject({
      type: 'column',
      title: '季度收入',
      categories: ['Q1', 'Q2'],
      series: [{ name: '收入', values: [1.2, 1.5] }],
    })
    expect(blocks[4]).toMatchObject({ media: 'image1.png', descr: '公司标志' })
    expect(deck.media.get('image1.png')?.toString()).toBe('png')
    expect(first.notes).toBe('先讲增长')
    expect(first.hidden).toBe(false)

    expect(second.hidden).toBe(true)
    expect(second.background).toEqual({ color: '#112233' })
    expect(second.title).toBeUndefined()
  })

  it('大纲写成 Markdown', async () => {
    const { readPptx, outlineMarkdown } = await lib('pptx-read.mjs')
    const md = outlineMarkdown(readPptx(await samplePptx())) as string
    expect(md).toContain('## 第 1 页：季度复盘')
    expect(md).toContain(
      '- **标题** 季度复盘  `100,100 1720×200 · 117.3px 粗 #000000 Aptos Display`',
    )
    expect(md).toContain('  - • 收入增长  `74.7px Aptos`')
    expect(md).toContain('    - – 华东 +20%  `64px Aptos`')
    expect(md).toContain('  | 合计 |  |')
    expect(md).toContain('  - 收入：1.2、1.5')
    expect(md).toContain('- 图片 media/image1.png：公司标志')
    expect(md).toContain('- 另有 1 个不带字的形状')
    expect(md).toContain('> 先讲增长')
    expect(md).toContain('## 第 2 页（隐藏）')
  })

  it('extract-pptx 写出大纲和图片，不是 PPTX 就报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-pptx-read-'))
    writeFileSync(join(dir, 'deck.pptx'), await samplePptx())
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['scripts/extract-pptx.mjs', ...args], {
        cwd: skill,
        encoding: 'utf8',
      })
    const ok = run([join(dir, 'deck.pptx'), '--json'])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('2 页')
    expect(ok.stdout).toContain('隐藏的页：2')
    const out = join(dir, 'deck-extract')
    expect(readFileSync(join(out, 'outline.md'), 'utf8')).toContain('# 季度复盘')
    expect(existsSync(join(out, 'media/image1.png'))).toBe(true)
    expect(JSON.parse(readFileSync(join(out, 'outline.json'), 'utf8')).slides).toHaveLength(2)

    writeFileSync(join(dir, 'bad.pptx'), 'not a zip')
    const bad = run([join(dir, 'bad.pptx')])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('不是 zip')
  })
})
