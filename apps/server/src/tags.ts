/**
 * 标签系统 —— **不是分类系统**。
 *
 * 分类系统:一个条目属于且只属于一个类,类是事先定好的一张表。
 * 标签系统:一个条目带若干标签,同一个标签横跨多个条目,条目自然出现在好几处。
 *
 * 三条硬规矩,少一条这套东西就退回成分类:
 *
 * 1. **标签不能自由决定。** 词表是预设的(skill 的 `runtime/tags.json`),条目从里面挑。
 *    自由写的话每个条目都会造出自己的词 ——「刊物感」「读物感」各只属于一个主题,
 *    永远成不了区。那份词表取自 Keynote 的主题侧边栏(基本/高级/商业/教育/创意/动态/
 *    简约/鲜艳/社论/作品集/工艺/纹理):被上百个主题验证过的分法,比我们边写边想出来
 *    的靠谱。加词由维护者决定。
 *
 *    **Keynote 那一列里的「所有主题」「最近使用」「个人」没有收进来** —— 它们和真标签
 *    摆在同一列,但不是标签:一个是兜底视图,另两个是系统算出来的(看使用记录、
 *    看主题是不是用户自己做的)。见第 3 条。
 *
 * 2. **不在词表里的丢掉并报出来。** 默默接受一个错别字,等于又回到了自由发挥。
 *
 * 2b. **每一份模板至少挂一个标签。** 上新一个主题或示例时必须选一个 —— 没标签的
 *     条目只能待在兜底的「全部」里,等于没进这套系统,而且它一个也不会出现在分区里。
 *     和拼错一样,这件事要被报出来(见 `tagIssues`),不能默默放过。
 *
 * 3. **「最近使用」「个人」这类不是标签。** 它们不写在任何文件里,是系统算出来的视图 ——
 *    前者看使用记录,后者看主题是不是用户自己做的。塞进条目的 `tags` 就等于说它是这个
 *    主题的属性,可它今天有明天就没了。所以走单独的字段(见 recent.ts),不混进来。
 */

/**
 * 一个标签。
 *
 * **`id` 和 `label` 分开**:稿子里写的是 id,界面上显示的是 label。分开之后,改一个
 * 显示名不用去动每一份主题和示例;id 是 ASCII,写进 HTML 属性也干净。
 *
 * `icon` 现在都空着 —— 分区是文字标题,图标在那儿是纯装饰。等有了筛选侧栏再补:
 * 那里一列十几个标签,图标才真的帮人扫(Keynote 的侧栏正是如此)。
 */
export interface Tag {
  id: string
  label: string
  icon?: string
}

/** skill 的 `runtime/tags.json` 里那个表。**一个扁平的表**。 */
export type Vocabulary = readonly Tag[]

/**
 * 一个扁平的表,场合(商业)、风格(简约)、质感(纹理)混在一起 —— Keynote 的侧边栏
 * 就是这样。人浏览时问的问题本来就不分轴:有人问「给课堂用的」,有人问「要简约的」,
 * 硬拆成两个轴只是把选择变复杂(我拆过,是多余的)。
 */
export function parseVocabulary(json: unknown): Vocabulary {
  if (!json || typeof json !== 'object') return []
  const tags = (json as Record<string, unknown>).tags
  if (!Array.isArray(tags)) return []
  return tags.flatMap((entry): Tag[] => {
    if (!entry || typeof entry !== 'object') return []
    const { id, label, icon } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id) return []
    return [
      {
        id,
        // 没写 label 就用 id —— 显示一个 ASCII 词,好过显示空白。
        label: typeof label === 'string' && label ? label : id,
        ...(typeof icon === 'string' && icon ? { icon } : {}),
      },
    ]
  })
}

/** id → 这个标签。界面显示 label 时用它。 */
export function labelOf(vocabulary: Vocabulary, id: string): string {
  return vocabulary.find((tag) => tag.id === id)?.label ?? id
}

/**
 * 只留词表里认识的,顺带报出不认识的。
 *
 * 词表是空的(读不到 tags.json)时**原样放行** —— 校验是为了发现错别字,不是为了在
 * skill 缺文件时把所有标签清空。
 */
export function keepKnown(
  values: string[],
  vocabulary: Vocabulary,
): { kept: string[]; unknown: string[] } {
  if (vocabulary.length === 0) return { kept: values, unknown: [] }
  const known = new Set(vocabulary.map((tag) => tag.id))
  return {
    kept: values.filter((value) => known.has(value)),
    unknown: values.filter((value) => !known.has(value)),
  }
}

/**
 * 一行人写的标签。`标签：工作汇报 / 刊物感` → `['工作汇报', '刊物感']`。
 *
 * 分隔符收得宽(`/ 、· , ，` 都认):这行是人手写的,为一个顿号漏掉半行不值得。
 */
export function tagLine(text: string, field: string): string[] {
  const line = text.match(new RegExp(`${field}[:：]\\s*([^\\n]+)`))?.[1]
  return line ? clean(line.split(/[/、·,，]/)) : []
}

/** `<html data-tags="商业">` 里那串。空格分隔,一份稿子可以有好几个。 */
export function tagAttr(html: string, attr = 'data-tags'): string[] {
  const value = html.match(new RegExp(`<html[^>]*\\b${attr}="([^"]*)"`, 'i'))?.[1]
  return value ? clean(value.split(/\s+/)) : []
}

/**
 * 每个标签下有哪些条目。**这就是分区,也是筛选条** —— 有什么标签由条目自己决定,
 * 不用另外维护一张表。
 *
 * `min` 是成区的门槛。**大部分模板只有一个标签**,门槛给 1 就会出来一堆只有一张卡的
 * 区,比平铺还难读。给 2:标签数量不够时人看到的就是一个平铺的全表,等条目多了分区
 * 自己长出来。
 */
export function groupByTag<T extends { tags: string[] }>(
  items: T[],
  min = 2,
): Array<{ tag: string; items: T[] }> {
  const byTag = new Map<string, T[]>()
  for (const item of items) {
    for (const tag of item.tags) {
      const bucket = byTag.get(tag)
      if (bucket) bucket.push(item)
      else byTag.set(tag, [item])
    }
  }
  return [...byTag.entries()]
    .filter(([, members]) => members.length >= min)
    .map(([tag, items]) => ({ tag, items }))
}

/**
 * 标签有毛病的条目,一条一句人话。**不默默放过** —— 词表是靠报告执行的,不是靠文档。
 */
export function tagIssues(
  items: Array<{ name: string; tags: string[]; unknown: string[] }>,
  vocabulary: Vocabulary,
): string[] {
  const issues: string[] = []
  for (const item of items) {
    for (const bad of item.unknown) {
      issues.push(`${item.name}:标签「${bad}」不在词表里`)
    }
    // 每一份模板至少挂一个标签 —— 没标签的等于没进这套系统。
    if (item.tags.length === 0 && item.unknown.length === 0) {
      issues.push(`${item.name}:没有标签,从词表里挑一个(${vocabulary.map((t) => t.id).join('、')})`)
    }
  }
  return issues
}

/** 注释里的 `*`、多余空白都去掉,空的丢掉。 */
function clean(parts: string[]): string[] {
  return parts.map((part) => part.replace(/^\s*\*\s*/, '').trim()).filter(Boolean)
}
