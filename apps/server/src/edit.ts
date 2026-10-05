import { sourcePages } from './page-edit.js'

/**
 * 就地改一个元素的文字。
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

  // 源码里可能是转义过的(`&amp;`),也可能是原样。两种都试,但只能命中一种。
  const candidates = [escapeHtml(oldText), oldText]
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
  const edited = section.slice(0, at) + escapeHtml(newText) + section.slice(at + target.length)

  // Use the actual source offset: two pages may have identical markup.
  return {
    ok: true,
    html: html.slice(0, location.startOffset) + edited + html.slice(location.endOffset),
  }
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
