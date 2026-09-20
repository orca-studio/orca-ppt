import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Slide, Transition } from '@orca-ppt/contracts'
import type { DeckSummary } from '@orca-ppt/contracts'
import { z } from 'zod'

/**
 * deck 是磁盘上的真实工程目录,不是数据库里的 blob。用户随时能把目录拿走,用别的
 * agent、别的编辑器继续干 —— 任何让 deck 只能在本产品里打开的设计都直接否掉。
 *
 * <deck>/
 *   deck.html            成品(skill 做出来的叫 index.html,两个都认)
 *   .deck/brief.json     阶段产物
 *   .deck/outline.json
 *   .deck/plan.json
 *   assets/
 */

const Outline = z.object({ slides: z.array(Slide) })
const Plan = z.object({ transitions: z.array(Transition) })

/** 我们自己建的 deck 叫 deck.html;skill 的 examples/ 里叫 index.html。两个都得认。 */
const ENTRY_NAMES = ['deck.html', 'index.html'] as const

export interface OpenedDeck {
  deck: DeckSummary
  slides: Slide[]
  transitions: Transition[]
  /** 成品还没出来时缺席 —— 这时候没有东西可放映。 */
  entryFile?: string
  html?: string
  /** 稿子里真实的页数。没有 outline.json 时,放映和翻页要靠它。 */
  slideCount: number
  /** 每一页的标题,从稿子里读出来的。没有 outline.json 时页胶片靠它。 */
  slideTitles: Array<string | null>
  /** 每一页声明的页面类型(`<section data-page>`)。没标的是 null —— 不猜。 */
  pageTypes: Array<string | null>
}

export async function openDeck(path: string): Promise<OpenedDeck> {
  // realpath,不只是 resolve。服务根是从 deck 路径 dirname 出来的,而预览服务要拿
  // 真实路径和它比对越界 —— 路径里有软链(macOS 的 /var → /private/var 就是)时,
  // 两边不是同一个字符串,稿子自己的资源会被判成越界。
  const root = await realpath(resolve(path))
  const entry = await stat(root)
  if (!entry.isDirectory()) throw new Error(`不是一个 deck 目录:${root}`)

  // 成品还没出来是正常状态 —— brief / theme / outline / plan 这几个阶段都还没写稿子。
  // 这时候 deck 目录照样要能打开,不然就成了「要先有稿子才能开始做稿子」。
  const found = await findEntry(root)

  const slides = (await readArtifact(join(root, '.deck/outline.json'), Outline))?.slides ?? []
  const transitions = (await readArtifact(join(root, '.deck/plan.json'), Plan))?.transitions ?? []

  return {
    deck: {
      id: root,
      title: basename(root),
      path: root,
      // 手工跑 skill 做出来的目录只有 index.html,没有 .deck/ —— 它照样该能打开放映,
      // 所以这里按实际存在的产物倒推阶段,而不是要求目录是本产品创建的。
      phase: transitions.length > 0 ? 'build' : slides.length > 0 ? 'plan' : 'brief',
      updatedAt: entry.mtimeMs,
    },
    slides,
    transitions,
    ...(found ? { entryFile: found.file, html: found.html } : {}),
    slideCount: found ? countTopLevelSections(found.html) : 0,
    slideTitles: found ? readSlideTitles(found.html) : [],
    pageTypes: found ? readPageTypes(found.html) : [],
  }
}

/** 这份 deck 的成品叫什么。skill 做出来的叫 index.html,我们自己建的叫 deck.html。 */
export async function findEntryName(root: string): Promise<string | undefined> {
  for (const name of ENTRY_NAMES) {
    try {
      await stat(join(root, name))
      return name
    } catch {
      // 下一个候选
    }
  }
  return undefined
}

async function findEntry(root: string): Promise<{ file: string; html: string } | undefined> {
  for (const name of ENTRY_NAMES) {
    const file = join(root, name)
    try {
      return { file, html: await readFile(file, 'utf8') }
    } catch {
      // 下一个候选
    }
  }
  return undefined
}

/**
 * reveal.js 里,`.slides` 的直接子 `<section>` 是一页;嵌套的 `<section>` 是纵向子页,
 * 不该各算一页。所以要数嵌套深度,不能直接数 `<section` 的个数。
 */
export function countTopLevelSections(html: string): number {
  return sliceSections(html).length
}

/** 每一页在 HTML 里的那一段。 */
export function sliceSections(html: string): string[] {
  // class 可以不带引号、可以带单引号、也可以和别的类名并存 —— 这些都是合法 HTML,
  // 只认 `class="slides"` 一种写法会在别人写的稿子上静默数出 0 页。
  const slides = findSlidesContainer(html)
  if (slides === -1) return []

  const rest = html.slice(slides)
  const starts: number[] = []
  let depth = 0
  for (const match of rest.matchAll(/<(\/?)section\b/g)) {
    if (match[1]) {
      depth -= 1
      continue
    }
    if (depth === 0) starts.push(match.index)
    depth += 1
  }
  return starts.map((start, i) => rest.slice(start, starts[i + 1] ?? rest.length))
}

/**
 * 每一页的标题,直接从稿子里读。
 *
 * 为什么不等 outline.json:skill 做出来的稿子根本没有那个文件,而页胶片上一排
 * 「1 —」「2 —」等于什么都没说。页数我们本来就是从 HTML 数出来的,标题同理,
 * 纯确定性的,不用麻烦模型。
 *
 * 优先级:`t-h1` 在 `t-display` 前面 —— 有些页用 `t-display` 放的是章节号(「01」),
 * 标题在 `t-h1` 上;只有封面这类没有 `t-h1` 的页才轮到 `t-display`。
 */
const TITLE_CLASSES = ['t-h1', 't-display', 't-h2'] as const

export function readSlideTitles(html: string): Array<string | null> {
  return sliceSections(html).map((section) => titleOf(section))
}

/**
 * 每一页声明的页面类型(`<section data-page="data">`)。没标的给 null。
 *
 * **不猜**:认不准的页在 skill 那边就是留空的,这儿再推一个出来只会把「没标」和
 * 「标错」混成一团 —— 而标错会同时误导校验、agent 和转场规划。
 */
export function readPageTypes(html: string): Array<string | null> {
  return sliceSections(html).map(
    (section) => section.match(/<section\b[^>]*\bdata-page="([a-z0-9-]+)"/i)?.[1] ?? null,
  )
}

function titleOf(section: string): string | null {
  for (const className of TITLE_CLASSES) {
    const text = firstTextByClass(section, className)
    if (text) return text
  }
  for (const tag of ['h1', 'h2']) {
    const match = section.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    const text = match?.[1] && plainText(match[1])
    if (text) return text
  }
  return null
}

function firstTextByClass(section: string, className: string): string | null {
  // 类名要整词匹配:t-h1 不能撞上 t-h10,也要能从 "t-h1 t-on-surface" 里认出来。
  const opening = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*class\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*>`,
    'gi',
  )
  for (const match of section.matchAll(opening)) {
    const classes = (match[2] ?? match[3] ?? match[4] ?? '').split(/\s+/)
    if (!classes.includes(className)) continue

    const tag = match[1]
    const from = match.index + match[0].length
    const close = section.indexOf(`</${tag}`, from)
    const text = plainText(section.slice(from, close === -1 ? undefined : close))
    if (text) return text
  }
  return null
}

/** 去标签、合并空白、截断 —— 页胶片一行放不下长句。 */
function plainText(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** `class` 里含 `slides` 这个类的那个元素在哪。 */
function findSlidesContainer(html: string): number {
  for (const match of html.matchAll(/class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (value.split(/\s+/).includes('slides')) return match.index
  }
  return -1
}

/** 产物缺席是正常情况(阶段还没跑到),不是错误。格式不对才是错误。 */
async function readArtifact<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  return schema.parse(JSON.parse(raw))
}
