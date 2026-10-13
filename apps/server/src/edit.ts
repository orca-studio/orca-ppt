import { sourcePages } from './page-edit.js'

/**
 * 就地改一个元素的文字。新文字留空就删掉这个元素。
 *
 * 服务端没有 DOM,而 guest 里的 DOM 也不等于源文件(reveal 会克隆节点、auto-animate 会
 * 改属性)。所以**拿旧文字当定位锚**:在那一页的源码里找那段文字,只在**恰好出现一次**
 * 时替换。0 次说明稿子已经被改过(多半是 agent 刚写过),2 次以上说明认不准是哪一处 ——
 * 两种情况都拒绝,不猜。
 *
 * 只改文字,一个标签一个属性都不动 —— `data-id` / `data-carry` 这些正是转场靠的东西,
 * 碰掉一个转场就哑了,而且要等到放映才发现。
 */

export interface TextEdit {
  slide: number
  oldText: string
  newText: string
}

export type EditResult = { ok: true; html: string } | { ok: false; reason: string }

export function applyTextEdit(html: string, edit: TextEdit): EditResult {
  let location
  try {
    location = sourcePages(html, false).pages[edit.slide]?.sourceCodeLocation
  } catch {
    /* no source page */
  }
  if (!location) return { ok: false, reason: `没有第 ${edit.slide + 1} 页` }

  const section = html.slice(location.startOffset, location.endOffset)
  const oldText = edit.oldText.trim()
  const newText = edit.newText.trim()
  if (!oldText) return { ok: false, reason: '原文是空的,没法定位' }
  if (oldText === newText) return { ok: true, html }
  const done = (edited: string): EditResult => ({
    ok: true,
    // Use the actual source offset: two pages may have identical markup.
    html: html.slice(0, location.startOffset) + edited + html.slice(location.endOffset),
  })

  // 源码里可能是转义过的(`&amp;`),也可能是原样。两种都试,但只能命中一种。
  const candidates = [escapeHtml(oldText), oldText]

  // 先认**整段文字一模一样**的那一处:「北岸软件」不该撞上「北岸软件 · 2021–2025」,
  // 「12」也不该撞上「2021」。整段对得上的恰好一处就用它。
  const whole = textNodes(section).filter((node) => candidates.includes(node.text.trim()))
  if (whole.length > 1) return { ok: false, reason: '这一页里有好几处一样的文字,认不准是哪一处' }
  if (whole.length === 1) {
    const node = whole[0]!
    // 新文字留空 = 删掉这一整个元素(数字行、单位行)。只留一个空标签的话,它还占着位置
    if (!newText) {
      const removed = removeElement(section, node)
      if (removed !== undefined) return done(removed)
    }
    const lead = node.text.slice(0, node.text.length - node.text.trimStart().length)
    const tail = node.text.slice(node.text.trimEnd().length)
    return done(
      section.slice(0, node.start) + lead + escapeHtml(newText) + tail + section.slice(node.end),
    )
  }

  // 整段对不上(要改的是一段字里的一部分):退回子串,同样只在恰好出现一次时改
  const hits = candidates.filter((candidate) => countOccurrences(section, candidate) === 1)
  if (hits.length === 0) {
    const total = candidates.reduce((sum, c) => sum + countOccurrences(section, c), 0)
    return {
      ok: false,
      reason:
        total === 0
          ? '在这一页里找不到那段文字 —— 稿子可能刚被改过'
          : '这一页里有好几处一样的文字,认不准是哪一处',
    }
  }

  const target = hits[0]!
  const at = section.indexOf(target)
  return done(section.slice(0, at) + escapeHtml(newText) + section.slice(at + target.length))
}

/**
 * 改转场计划注释里的一段字。注释在页面之外,`applyTextEdit` 只看页面,够不着它。
 *
 * 同样拿旧文字当锚、恰好一处才换。注释里不转义(那不是标记),但新文字不许带 `--`:
 * 带了注释就提前结束,后面的计划会漏进页面里显示出来。
 */
export function applyPlanEdit(
  html: string,
  edit: { oldText: string; newText: string },
): EditResult {
  const comment = /<!--\s*转场计划[\s\S]*?-->/.exec(html)
  if (!comment) return { ok: false, reason: '这份稿子没有转场计划注释' }
  const oldText = edit.oldText.trim()
  const newText = edit.newText.trim()
  if (!oldText) return { ok: false, reason: '原文是空的,没法定位' }
  if (newText.includes('--')) return { ok: false, reason: '新文字里不能有「--」,它会提前结束注释' }
  if (oldText === newText) return { ok: true, html }
  const body = comment[0]
  const count = countOccurrences(body, oldText)
  if (count === 0) return { ok: false, reason: '转场计划注释里找不到那段文字' }
  if (count > 1) return { ok: false, reason: '转场计划注释里有好几处一样的文字,认不准是哪一处' }
  const at = comment.index + body.indexOf(oldText)
  return { ok: true, html: html.slice(0, at) + newText + html.slice(at + oldText.length) }
}

/** 标签之间的一段文字,带它在 section 里的起止位置。注释、脚本、样式里的不算。 */
function textNodes(section: string): Array<{ text: string; start: number; end: number }> {
  const masked = section.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>/gi, (m) =>
    ' '.repeat(m.length),
  )
  const nodes: Array<{ text: string; start: number; end: number }> = []
  for (const match of masked.matchAll(/>([^<]+)</g)) {
    const start = match.index + 1
    const end = start + match[1]!.length
    if (section.slice(start, end).trim())
      nodes.push({ text: section.slice(start, end), start, end })
  }
  return nodes
}

/**
 * 删掉只装着这段文字的那个元素:`<p …>12</p>`。元素里还有别的标签就不删(返回 undefined,
 * 调用方退回成清空文字),免得连带删掉别的东西。连同它独占的那一行一起删,不留空行。
 */
function removeElement(section: string, node: { start: number; end: number }): string | undefined {
  const open = section.lastIndexOf('<', node.start - 1)
  const tag = /^<([a-zA-Z][\w-]*)\b/.exec(section.slice(open))?.[1]
  if (!tag || open <= 0) return undefined
  const close = `</${tag}>`
  if (!section.startsWith(close, node.end)) return undefined
  let from = open
  let to = node.end + close.length
  const lineStart = section.lastIndexOf('\n', from - 1) + 1
  if (!section.slice(lineStart, from).trim()) {
    const lineEnd = section.indexOf('\n', to)
    if (lineEnd !== -1 && !section.slice(to, lineEnd).trim()) {
      from = lineStart
      to = lineEnd + 1
    }
  }
  return section.slice(0, from) + section.slice(to)
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/** 只转义会改变标记结构的那三个。引号不转 —— 文字在标签之间,不在属性里。 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
