/**
 * 标签系统 —— **不是分类系统**。
 *
 * 分类系统:一个条目属于且只属于一个类,类是事先定好的一张表。
 * 标签系统:一个条目带任意多个标签,同一个标签横跨多个条目,条目自然出现在好几处。
 *
 * 为什么必须是后者:「Bento」不是和「汇报稿」并列的第三种模式,它是汇报稿里的一种
 * **页型** —— 一份稿子可以既是汇报稿、又有 bento 页、还有时间线页。塞进互斥的枚举
 * 里就只能挑一个,信息当场丢掉。「高对比」同时属于两个主题也是同理。
 *
 * 标签分两种来源,形状一样,界面一视同仁:
 *
 * - **声明的**:写在文件里(主题头的「场景」「风格」,稿子 `<html>` 上的 data-tags)。
 * - **派生的**:读的时候从文件之外的状态算出来(最近用过、我自己做的)。
 *   分类表长不出「最近使用」这种东西 —— 它不是内容的属性,是使用的属性。
 *
 * 轴是具名的,不是开放的 record:界面对不同的轴处理**不一样**(场景给正文色、风格
 * 淡一档、最近使用排最前),开放的 record 会把这个区别丢掉。
 */

/** 一组按轴分好的标签。轴名由各自的类型定,这里只管通用操作。 */
export type TagSet = Readonly<Record<string, readonly string[]>>

/**
 * 一行人写的标签。`场景：产品发布 / 方案提案` → `['产品发布', '方案提案']`。
 *
 * 分隔符收得宽(`/ 、· , ，` 都认):这行是人手写的,为一个顿号漏掉半行标签不值得。
 */
export function tagLine(text: string, field: string): string[] {
  const line = text.match(new RegExp(`${field}[:：]\\s*([^\\n]+)`))?.[1]
  return line ? clean(line.split(/[/、·,，]/)) : []
}

/** `<html data-tags="bento 时间线">` 里那串。空格分隔,一份稿子可以有好几个。 */
export function tagAttr(html: string, attr = 'data-tags'): string[] {
  const value = html.match(new RegExp(`<html[^>]*\\b${attr}="([^"]*)"`, 'i'))?.[1]
  return value ? clean(value.split(/\s+/)) : []
}

/** 这个条目在这个轴上有没有这个标签。 */
export function hasTag(tags: TagSet, axis: string, value: string): boolean {
  return (tags[axis] ?? []).includes(value)
}

/**
 * 某个轴上出现过的全部标签,按第一次出现的顺序。**这是筛选条的数据** ——
 * 不用另外维护一张表,有什么标签是由条目自己决定的。
 */
export function axisValues(items: Array<{ tags: TagSet }>, axis: string): string[] {
  const seen: string[] = []
  for (const item of items) {
    for (const value of item.tags[axis] ?? []) {
      if (!seen.includes(value)) seen.push(value)
    }
  }
  return seen
}

/** 注释里的 `*`、多余空白都去掉,空的丢掉。 */
function clean(parts: string[]): string[] {
  return parts.map((part) => part.replace(/^\s*\*\s*/, '').trim()).filter(Boolean)
}
