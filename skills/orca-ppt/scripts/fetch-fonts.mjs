// 把主题用到的网络字体抓成本地文件。
//
//   node scripts/fetch-fonts.mjs
//
// 为什么不直接 @import Google Fonts:
//   1. 断网或被墙时 @import 会阻塞渲染,首屏白一段;
//   2. 字体晚到一帧,capture 录下来的就不是最终的样子;
//   3. 最要紧的是**中文**。这些都是西文字体,遇到中文必须落到退路字体,字宽随之全变,
//      而 .t-display / .t-h1 是 nowrap + 固定字号,版面估算全建立在固定字形上,一变就溢出。
//      本地 @font-face 带 unicode-range,把拉丁交给西文字体、中文交给 PingFang,
//      混排时两边都拿到确定的字形,版面不会跳。
//
// 产物是 runtime/fonts/(woff2 + fonts.css),进仓库 —— 用的时候不该再依赖公网。
// 字体都是 OFL,可以随包分发,许可抄在 runtime/fonts/LICENSE 里。
//
// 另外取一份给导出 PPTX 嵌进文件用的:runtime/fonts/pptx/(静态字重的 .ttf + fonts.json)。
// PowerPoint 只认 TrueType、按字体名找字;网页用的是可变字体的 woff2,字体名还带着光学尺寸
// (「Newsreader 16pt」),对不上。Google 的旧版接口(css?family=…&subset=latin,不带现代 UA)
// 回的正是每个字重一个、只含拉丁字形的静态 .ttf,字体名就是家族名。

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fontNames, pptxName, renameFont } from './lib/ttf.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'runtime', 'fonts')
const PPTX_OUT = join(OUT, 'pptx')

/**
 * 主题里现在用到的全部字体,取各主题的并集。
 * 改主题字体时,这里跟着加一行,再跑一次这个脚本。
 *
 * 字重要**把 400 也带上**:没套 .t-* 类的零散文字会落到基础字重,少一档浏览器就自己
 * 合成一个假的,笔画粗细和真字重对不上。(原来直接 @import Google Fonts 时就漏了
 * Inter 400、Cormorant Garamond 400、Bodoni Moda 400。)
 */
const FAMILIES = [
  'Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700',
  'Instrument+Serif:ital@0;1',
  'JetBrains+Mono:wght@400;500',
  'Inter:wght@400;500;600;700',
  'Cormorant+Garamond:wght@400;500;600',
  'Work+Sans:wght@400;500;600',
  'Bodoni+Moda:opsz,wght@6..96,400;6..96,700;6..96,800;6..96,900',
  'Manrope:wght@500;700;800',
  'Source+Serif+4:opsz,wght@8..60,400;8..60,500',
  // Cobalt Grid(同款 cobalt-grid):衬线标题 + 人文无衬线正文 + 等宽小字
  'Newsreader:opsz,wght@6..72,400;6..72,500',
  'Hanken+Grotesk:wght@400;600',
  'DM+Mono:wght@400;500',
  // Neo-Grid Bold、Pin & Paper(同款 neo-grid / pin-and-paper):粗体无衬线标题
  'Space+Grotesk:wght@400;500;700',
  // Pin & Paper:手写批注
  // Sakura Chroma(同款 sakura-chroma):窄体粗标题 + 无衬线正文
  // Split(同款 black-white-split):压缩超粗的数字和序号
  'Anton',
]

/**
 * 只留这两个子集。中文不走这些字体(它们根本没有中文字形),交给退路里的 PingFang;
 * 西里尔、希腊、越南语我们的稿子用不到,拖进来只是白占体积。
 */
const SUBSETS = new Set(['latin', 'latin-ext'])

// 不带现代浏览器 UA 的话,Google 会回 ttf —— 体积大好几倍。
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`)
  return response.text()
}

/** 把 Google 回的 css 拆成一个个 @font-face,带上它前面那行 `/* latin *\/` 注释。 */
function parseFaces(css) {
  const faces = []
  const pattern = /\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g
  let match
  while ((match = pattern.exec(css)) !== null) {
    faces.push({ subset: match[1], block: match[2] })
  }
  return faces
}

function field(block, name) {
  const match = block.match(new RegExp(name + ':\\s*([^;]+);'))
  return match ? match[1].trim() : undefined
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  const blocks = []
  let downloaded = 0
  let reused = 0

  for (const spec of FAMILIES) {
    const url = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`
    const css = await fetchText(url)
    const faces = parseFaces(css).filter((face) => SUBSETS.has(face.subset))
    if (faces.length === 0) throw new Error(`${spec} 一个 latin 子集都没取到,查询串写错了?`)

    for (const face of faces) {
      const family = field(face.block, 'font-family')
      const style = field(face.block, 'font-style') ?? 'normal'
      const weight = field(face.block, 'font-weight') ?? '400'
      const range = field(face.block, 'unicode-range')
      const source = face.block.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1]
      if (!source) throw new Error(`${family} 没拿到 woff2 —— UA 没生效?`)

      // 文件名要能看懂,也要唯一:同一家族的正体/斜体、不同字重会落到不同文件。
      const name = `${slug(family)}-${style}-${slug(weight)}-${face.subset}.woff2`
      const file = join(OUT, name)
      if (existsSync(file)) {
        reused += 1
      } else {
        const response = await fetch(source, { headers: { 'User-Agent': UA } })
        if (!response.ok) throw new Error(`下载失败 ${source}`)
        writeFileSync(file, Buffer.from(await response.arrayBuffer()))
        downloaded += 1
      }

      blocks.push(
        [
          '@font-face {',
          `  font-family: ${family};`,
          `  font-style: ${style};`,
          `  font-weight: ${weight};`,
          // swap:字体还没到就先用退路字体画出来,不留空白。本地文件几乎不会慢到看得见,
          // 但万一(比如稿子被搬到别处、字体文件丢了)也不该整页白着。
          '  font-display: swap;',
          `  src: url("./${name}") format("woff2");`,
          ...(range ? [`  unicode-range: ${range};`] : []),
          '}',
        ].join('\n'),
      )
    }
  }

  const header = [
    '/*',
    ' * 本地字体。**这个文件是生成的** —— 改它没用,改 scripts/fetch-fonts.mjs 再跑:',
    ' *',
    ' *   node scripts/fetch-fonts.mjs',
    ' *',
    ' * 主题 @import 它,而不是 @import Google Fonts:断网也能放映,录制首帧也确定。',
    ' * 每个 @font-face 都带 unicode-range,只认拉丁字形 —— 中文会落到主题 --font 退路链',
    ' * 末尾的 PingFang,两边都拿到确定的字形,中英混排时版面不会跳。',
    ' */',
    '',
  ].join('\n')

  writeFileSync(join(OUT, 'fonts.css'), header + blocks.join('\n\n') + '\n')
  console.log(`字体 ${downloaded} 个新下载、${reused} 个已有,${blocks.length} 条 @font-face`)
  console.log(`→ ${join(OUT, 'fonts.css')}`)
}

/** css2 的查询串(`Inter:wght@400;500`、`Instrument+Serif:ital@0;1`)→ 旧版接口的(`Inter:400,500`) */
function legacySpec(spec) {
  const [name, axes] = spec.split(':')
  if (!axes) return `${name}:400`
  const [keys, values] = axes.split('@')
  const names = keys.split(',')
  const faces = values.split(';').map((tuple) => {
    const parts = Object.fromEntries(tuple.split(',').map((v, i) => [names[i], v]))
    return `${parts.wght ?? 400}${parts.ital === '1' ? 'italic' : ''}`
  })
  return `${name}:${[...new Set(faces)].join(',')}`
}

/** 导出 PPTX 嵌字体用的静态 .ttf。fonts.json:CSS 里的家族名 + 字重 + 正斜 → 文件和 PowerPoint 里的字体名 */
async function fetchPptxFonts() {
  mkdirSync(PPTX_OUT, { recursive: true })
  const entries = []
  let downloaded = 0
  for (const spec of FAMILIES) {
    // 不带 UA:回 truetype
    const url = `https://fonts.googleapis.com/css?family=${legacySpec(spec)}&subset=latin`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`)
    const css = await response.text()
    for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      const family = field(block, 'font-family').replace(/['"]/g, '')
      const style = field(block, 'font-style') ?? 'normal'
      const weight = Number(field(block, 'font-weight') ?? 400)
      const source = block.match(/url\((https:\/\/[^)]+\.ttf)\)/)?.[1]
      if (!source) throw new Error(`${family} 没拿到 ttf`)
      const file = `${slug(family)}-${style}-${weight}.ttf`
      if (!existsSync(join(PPTX_OUT, file))) {
        const font = await fetch(source)
        if (!font.ok) throw new Error(`下载失败 ${source}`)
        // Google 给的静态字体里名字常带着光学尺寸和默认字重(「Newsreader 16pt 16pt」「Space Grotesk Light」),
        // 在 PowerPoint 的字体菜单里看着像别的字体:改成家族名 + 字重名
        const named = renameFont(Buffer.from(await font.arrayBuffer()), pptxName(family, weight, style === 'italic'))
        writeFileSync(join(PPTX_OUT, file), named)
        downloaded += 1
      }
      const names = fontNames(readFileSync(join(PPTX_OUT, file)))
      entries.push({ family, weight, style, file, typeface: names.family, subfamily: names.subfamily })
    }
  }
  writeFileSync(join(PPTX_OUT, 'fonts.json'), JSON.stringify(entries, null, 2) + '\n')
  console.log(`PPTX 嵌入字体 ${downloaded} 个新下载,共 ${entries.length} 个 → ${PPTX_OUT}`)
}

await main()
await fetchPptxFonts()
