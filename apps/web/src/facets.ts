/**
 * 按标签铺成一列分区 —— **不是分类**。
 *
 * 分类:一个条目属于且只属于一个组,组是事先定好的一张表。
 * 分区:按标签分组,**一个条目会出现在好几组里**,组由条目自己带的标签决定。
 *
 * 「最近使用」也是一个分区,但它**不是标签** —— 它不写在任何文件里,是系统从使用记录
 * 算出来的。所以它单独传进来,不从 `tags` 里读(塞进 tags 就等于说它是条目的属性,
 * 而它今天有明天就没了)。
 */

export interface Section<T> {
  /** 分区标题。标签区用词表里的 label,派生区用它自己的名字。 */
  title: string
  items: T[]
}

/**
 * `min` 是成区的门槛。**大部分模板只有一个标签**,门槛给 1 就会出来一堆只有一张卡的
 * 区,比平铺还难读。给 2:标签不够多时人看到的就是一个平铺的全表,等条目多了分区自己
 * 长出来。
 */
export function sectionsOf<T extends { tags: string[] }>(
  items: T[],
  options: {
    /** 排在最前的派生分区,比如「最近使用」。空的不显示。 */
    derived?: Array<{ title: string; items: T[] }>
    /** 兜底那一区的名字。它带上全部条目 —— 保证每个条目至少露一次。 */
    fallback: string
    label?: (tag: string) => string
    min?: number
  },
): Array<Section<T>> {
  const { derived = [], fallback, label = (tag) => tag, min = 2 } = options
  if (items.length === 0) return []

  const byTag = new Map<string, T[]>()
  for (const item of items) {
    for (const tag of item.tags) {
      const bucket = byTag.get(tag)
      if (bucket) bucket.push(item)
      else byTag.set(tag, [item])
    }
  }

  return [
    ...derived.filter((section) => section.items.length > 0),
    ...[...byTag.entries()]
      .filter(([, members]) => members.length >= min)
      .map(([tag, members]) => ({ title: label(tag), items: members })),
    { title: fallback, items },
  ]
}
