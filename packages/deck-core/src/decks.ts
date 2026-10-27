import { sourcePages } from './page-edit.js'
import { fileDigest } from './asset-digest.js'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
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
 * 不该各算一页。解析源码区段,不把脚本或注释里的 `<section` 算进来。
 */
export function countTopLevelSections(html: string): number {
  return sliceSections(html).length
}

/** 每一页在 HTML 里的那一段。 */
export function sliceSections(html: string): string[] {
  try {
    return sourcePages(html, false).pages.flatMap((page) => {
      const location = page.sourceCodeLocation
      return location ? [html.slice(location.startOffset, location.endOffset)] : []
    })
  } catch {
    return []
  }
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

/**
 * 每一页里一段一段的文字,**源文件里的原文**。给 agent 核对用:`edit_text` 要的就是这个,
 * 而不是放映出来的样子 —— CSS 改大小写、自动换行都会让屏幕上的字和源码对不上。
 *
 * 标签之间的每一段算一段(和 `edit_text` 能定位的单位一致);脚本、样式、注释里的不算。
 * 只还原 `edit_text` 自己认的那三种转义,空白原样保留 —— 拿这里的字原样回传一定能定位上。
 */
export function readSlideTexts(html: string): string[][] {
  return sliceSections(html).map((section) => {
    const markup = section
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    const texts: string[] = []
    for (const match of markup.matchAll(/>([^<]+)</g)) {
      const text = match[1]!.trim()
      if (text) texts.push(unescapeHtml(text))
    }
    return texts
  })
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/**
 * 稿子的版本号:成品文件、`.deck/` 里各阶段产物和 `assets/` 里素材的内容哈希。内容一变它就变,
 * 只是被打开、被看、翻了页都不变 —— 宿主拿它判断一次调用到底动没动稿子。
 *
 * 素材也要算:换一张图,观众看到的就变了。按内容算而不是按修改时间,改了又改回去版本号也回得去
 * (「可录制应用」约定靠这个认出内容相同)。
 */
export async function deckRevision(root: string): Promise<string> {
  return (await deckSnapshot(root)).revision
}

/**
 * 版本号连同算它用的成品源码,外加单算的素材摘要。server 比两版差在哪(只差几页就让画布
 * 就地换页)时用:素材变了得整份重载,`.deck/` 里的元数据变了画面上什么都没变。
 */
export async function deckSnapshot(
  root: string,
): Promise<{ revision: string; entry?: { file: string; html: string }; assets: string }> {
  const hash = createHash('sha256')
  const assets = createHash('sha256')
  const entry = await findEntry(root)
  if (entry) hash.update(entry.file).update('\0').update(entry.html)
  let names: string[] = []
  try {
    names = (await readdir(join(root, '.deck'))).filter((n) => n.endsWith('.json')).sort()
  } catch {
    // 手工做出来的稿子没有 .deck/ —— 只按成品算。
  }
  for (const name of names) {
    hash.update('\0').update(name).update('\0')
    try {
      hash.update(await readFile(join(root, '.deck', name)))
    } catch {
      // 读的时候刚好被删了:当它不在。
    }
  }
  for (const file of await listFiles(join(root, 'assets'))) {
    const digest = await fileDigest(file.path)
    for (const target of [hash, assets]) {
      target.update('\0assets/').update(file.relative).update('\0')
      target.update(digest)
    }
  }
  return {
    revision: hash.digest('hex').slice(0, 16),
    ...(entry ? { entry } : {}),
    assets: assets.digest('hex').slice(0, 16),
  }
}

/** 目录下所有文件,按相对路径排好。目录不在就是空的。 */
async function listFiles(
  dir: string,
  prefix = '',
): Promise<Array<{ path: string; relative: string }>> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ path: string; relative: string }> = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(path, relative)))
    else if (entry.isFile()) out.push({ path, relative })
  }
  return out
}

export function readSlideTitles(html: string): Array<string | null> {
  const sections = sliceSections(html)
  // 每页都一样的字是固定的版面元素(环形时间轴圆心的「发展历程」),不是这一页的标题
  const pages = new Map<string, number>()
  for (const section of sections) {
    const seen = new Set(
      TITLE_CLASSES.flatMap((name) => textsByClass(section, name)).map((t) => t.text),
    )
    for (const text of seen) pages.set(text, (pages.get(text) ?? 0) + 1)
  }
  const fixed = (text: string) => sections.length > 2 && (pages.get(text) ?? 0) === sections.length
  return sections.map((section) => titleOf(section, fixed))
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

/**
 * 同一级字号里先挑「这一页自己的」:不带 data-id(带的是跨页共享的锚,比如时间轴上的
 * 年份,当前那一格放大成 `t-h1`,拿来当标题就成了「2022」)、也不是每页都有的固定字。
 * 挑不出来再退回第一个,总比没有标题好。
 */
function titleOf(section: string, fixed: (text: string) => boolean = () => false): string | null {
  // 同一级字号里挑,不往下一级跳:封面的大字带 data-id(要和下一页共享)也照样是标题
  for (const className of TITLE_CLASSES) {
    const texts = textsByClass(section, className).filter((t) => !fixed(t.text))
    const pick = texts.find((t) => !t.shared) ?? texts[0]
    if (pick) return pick.text
  }
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
  return textsByClass(section, className)[0]?.text ?? null
}

function textsByClass(
  section: string,
  className: string,
): Array<{ text: string; shared: boolean }> {
  const found: Array<{ text: string; shared: boolean }> = []
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
    if (text) found.push({ text, shared: /\bdata-id\s*=/.test(match[0]) })
  }
  return found
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
