import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5'

export type PageChange =
  | { action: 'insert'; index: number; title: string }
  | { action: 'delete'; index: number }
  | { action: 'move'; index: number; to: number }

export function elements(node: Tree.Node): Tree.Element[] {
  const children = 'childNodes' in node ? node.childNodes : []
  return children.flatMap((child) => [...('tagName' in child ? [child] : []), ...elements(child)])
}
export const attr = (node: Tree.Element, name: string) =>
  node.attrs.find((item) => item.name === name)?.value

export function sourcePages(
  html: string,
  strict = true,
): {
  tree: Tree.Document
  container: Tree.Element
  pages: Tree.Element[]
} {
  const tree = parse(html, { sourceCodeLocationInfo: true })
  const containers = elements(tree).filter((node) =>
    attr(node, 'class')?.split(/\s+/).includes('slides'),
  )
  if (containers.length !== 1) throw new Error('找不到唯一的页面容器')
  const container = containers[0]!
  const pages = container.childNodes.filter(
    (node): node is Tree.Element => 'tagName' in node && node.tagName === 'section',
  )
  if (strict && pages.some((page) => elements(page).some((node) => node.tagName === 'section')))
    throw new Error('暂不支持修改嵌套页面')
  for (const page of strict ? pages : []) {
    if (!page.sourceCodeLocation?.startTag || !page.sourceCodeLocation.endTag)
      throw new Error('页面标签不完整，请先修复 HTML')
  }
  if (strict && !container.sourceCodeLocation?.endTag) throw new Error('页面容器标签不完整')
  return { tree, container, pages }
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Move source ranges, never serialize the browser's corrected DOM. */
export function editPages(html: string, change: PageChange) {
  const { tree, container, pages } = sourcePages(html)
  const count = pages.length
  if (change.index < 0 || change.index >= count + (change.action === 'insert' ? 1 : 0))
    throw new Error('页号已不存在')
  if (change.action === 'delete' && count <= 1) throw new Error('至少保留一页')
  if (change.action === 'move' && (change.to < 0 || change.to >= count))
    throw new Error('目标页号已不存在')
  const order: (number | null)[] = pages.map((_, index) => index)
  if (change.action === 'insert') order.splice(change.index, 0, null)
  else if (change.action === 'delete') order.splice(change.index, 1)
  else order.splice(change.to, 0, order.splice(change.index, 1)[0]!)
  const slices = pages.map((page) => {
    const location = page.sourceCodeLocation!
    return html.slice(location.startOffset, location.endOffset)
  })
  const ranges: { start: number; end: number; value: string }[] = []
  // Keep comments/whitespace in their original slots; replace only complete sections.
  pages.forEach((page, index) => {
    const location = page.sourceCodeLocation!
    const oldIndex = order[index]
    ranges.push({
      start: location.startOffset,
      end: location.endOffset,
      value:
        oldIndex === undefined
          ? ''
          : oldIndex === null
            ? `<section><h2>${escape(change.action === 'insert' ? change.title : '')}</h2></section>`
            : slices[oldIndex]!,
    })
  })
  if (order.length > count) {
    const oldIndex = order[count]!
    const offset = container.sourceCodeLocation!.endTag!.startOffset
    ranges.push({
      start: offset,
      end: offset,
      value:
        oldIndex === null
          ? `<section><h2>${escape(change.action === 'insert' ? change.title : '')}</h2></section>`
          : slices[oldIndex]!,
    })
  }
  // A transition remains valid only when the original pair is still adjacent.
  const remap = (from: number, to: number) => {
    const nextFrom = order.indexOf(from),
      nextTo = order.indexOf(to)
    return nextFrom >= 0 && nextTo === nextFrom + 1 ? [nextFrom, nextTo] : null
  }
  const comments = (node: Tree.Node): Tree.CommentNode[] =>
    ('childNodes' in node ? node.childNodes : []).flatMap((child) => [
      ...(child.nodeName === '#comment' ? [child as Tree.CommentNode] : []),
      ...comments(child),
    ])
  for (const comment of comments(tree)) {
    const location = comment.sourceCodeLocation
    if (!location || !comment.data.includes('转场计划')) continue
    // Comments inside replaced sections travel with their section; reject ambiguous plans.
    if (
      pages.some(
        (page) =>
          location.startOffset >= page.sourceCodeLocation!.startOffset &&
          location.endOffset <= page.sourceCodeLocation!.endOffset,
      )
    )
      throw new Error('页内包含转场计划，请先移到页面容器外')
    const value =
      '<!--' +
      comment.data.replace(
        /^([ \t]*)(\d+)\s*→\s*(\d+)([^\r\n]*)(\r?\n|$)/gm,
        (line, indent: string, from: string, to: string, rest: string, newline: string) => {
          const pair = remap(Number(from) - 1, Number(to) - 1)
          return pair ? `${indent}${pair[0]! + 1}→${pair[1]! + 1}${rest}${newline}` : ''
        },
      )
    ranges.push({ start: location.startOffset, end: location.endOffset, value: value + '-->' })
  }
  let result = html
  for (const range of ranges.sort((a, b) => b.start - a.start))
    result = result.slice(0, range.start) + range.value + result.slice(range.end)
  return {
    html: result,
    order,
    remap,
    slide: change.action === 'move' ? change.to : Math.min(change.index, order.length - 1),
  }
}

/** Only image references already packaged in the deck; selectors are source IDs/anchors. */
export function replaceImage(
  html: string,
  slide: number,
  selector: string,
  oldSource: string,
  source: string,
) {
  const { tree, pages } = sourcePages(html)
  if (elements(tree).some((node) => node.tagName === 'base' && attr(node, 'href')))
    throw new Error('暂不支持带 base 地址的稿子换图')
  const page = pages[slide]
  if (!page) throw new Error('页号已不存在')
  const nodes = elements(page)
  // Stable selectors avoid guessing how runtime-generated nth-child paths map to source.
  const id = /^#([\w-]+)$/.exec(selector)?.[1]
  const anchor = /^\[data-anchor="([^"\\]+)"\]$/.exec(selector)?.[1]
  if (!id && !anchor) throw new Error('图片需要简单 id 或 data-anchor；暂不支持运行时路径选择器')
  const matches = nodes.filter((node) =>
    id ? attr(node, 'id') === id : attr(node, 'data-anchor') === anchor,
  )
  if (matches.length !== 1 || matches[0]!.tagName !== 'img')
    throw new Error('找不到唯一的源文件图片')
  const image = matches[0]!
  if (attr(image, 'src') !== oldSource) throw new Error('图片地址已变化，请重新选择')
  if (
    attr(image, 'srcset') ||
    attr(image, 'data-src') ||
    attr(image, 'data-srcset') ||
    (image.parentNode && 'tagName' in image.parentNode && image.parentNode.tagName === 'picture')
  )
    throw new Error('暂不支持带 srcset、延迟加载或 picture 的图片')
  const location = image.sourceCodeLocation?.attrs?.src
  if (!location) throw new Error('源文件图片没有 src 属性')
  return (
    html.slice(0, location.startOffset) + `src="${escape(source)}"` + html.slice(location.endOffset)
  )
}
