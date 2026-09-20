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
  }
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
  // class 可以不带引号、可以带单引号、也可以和别的类名并存 —— 这些都是合法 HTML,
  // 只认 `class="slides"` 一种写法会在别人写的稿子上静默数出 0 页。
  const slides = findSlidesContainer(html)
  if (slides === -1) return 0

  let count = 0
  let depth = 0
  for (const match of html.slice(slides).matchAll(/<(\/?)section\b/g)) {
    if (match[1]) {
      depth -= 1
      continue
    }
    if (depth === 0) count += 1
    depth += 1
  }
  return count
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
