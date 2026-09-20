import type { RequestResult } from '@orca-ppt/contracts'

export type Template = RequestResult<'catalog.templates'>['templates'][number]

/**
 * 按标签分面 —— **不是分类**。
 *
 * 分类:一个条目属于且只属于一个组,组是事先定好的一张表。
 * 分面:按某个轴上的标签分组,**一个条目会出现在好几组里**,组是由条目自己带的标签
 * 决定的,不用另外维护一张表。
 *
 * 为什么必须是后者:一份汇报稿可以既有 bento 页、又有时间线页,它该在这两处都出现。
 * 塞进互斥的分类就只能挑一个,信息当场丢掉 —— 这个错我们已经犯过一次(把 Bento 当成
 * 和汇报稿并列的第三种模式)。
 */

export interface Facet {
  /** 标签本身,也是这一组的名字。 */
  value: string
  items: Template[]
}

/**
 * 把一批条目按某个轴上的标签铺开。
 *
 * `order` 给出想优先的标签(比如「最近使用」排最前);没列到的按第一次出现的顺序跟在后面。
 * 不排序 —— 顺序是作者和使用决定的,字母序对人没有意义。
 */
export function facetsOf<T extends { tags: Record<string, string[]> }>(
  items: T[],
  axis: string,
  order: string[] = [],
): Array<{ value: string; items: T[] }> {
  const byValue = new Map<string, T[]>()
  for (const item of items) {
    for (const value of item.tags[axis] ?? []) {
      const bucket = byValue.get(value)
      if (bucket) bucket.push(item)
      else byValue.set(value, [item])
    }
  }

  const seen = [...byValue.keys()]
  const ranked = [
    ...order.filter((value) => byValue.has(value)),
    ...seen.filter((value) => !order.includes(value)),
  ]
  return ranked.map((value) => ({ value, items: byValue.get(value) ?? [] }))
}

/** 带这个标签的条目。带不带这个轴上的别的标签都不影响。 */
export function withTag<T extends { tags: Record<string, string[]> }>(
  items: T[],
  axis: string,
  value: string,
): T[] {
  return items.filter((item) => (item.tags[axis] ?? []).includes(value))
}

/**
 * 某个轴上出现过的全部标签。**这就是筛选条的数据** —— 有什么标签由条目自己决定,
 * 不用另外维护一张表。有了新标签,筛选条自己就长出来了。
 */
export function axisValues<T extends { tags: Record<string, string[]> }>(
  items: T[],
  axis: string,
): string[] {
  const seen: string[] = []
  for (const item of items) {
    for (const value of item.tags[axis] ?? []) {
      if (!seen.includes(value)) seen.push(value)
    }
  }
  return seen
}
