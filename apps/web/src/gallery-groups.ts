import type { RequestResult } from '@orca-ppt/contracts'

export type Template = RequestResult<'catalog.templates'>['templates'][number]

/**
 * 选择器怎么分组。
 *
 * **人挑模板时先问的是「这是哪一类稿子」,不是「它叫什么」** —— 一长条平铺的示例回答
 * 不了这个问题。所以按版式族分:每组里先摆空白起始文件(从头写起),再摆现成的成稿。
 *
 * 分组逻辑单独放在这儿,不埋在组件里 —— 这样能单独测,而且顺序、命名、空组怎么处理
 * 这些决定摆在一处,改的时候看得见全部。
 */

export interface Group {
  key: string
  title: string
  hint: string
  items: Template[]
}

/** 顺序是有意的:汇报稿最常用,Bento 是汇报稿里的一种页型,排在它后面。 */
const FAMILIES: Array<{ key: string; title: string; hint: string }> = [
  { key: 'standard', title: '汇报稿', hint: '工作汇报、产品介绍、数据复盘' },
  { key: 'story', title: '故事稿', hint: '一页一张照片,讲演变' },
  { key: 'bento', title: 'Bento', hint: '一页放下多块信息' },
]

export function groupTemplates(templates: Template[]): Group[] {
  const groups = FAMILIES.map((family) => ({ ...family, items: [] as Template[] }))
  const other: Template[] = []

  for (const item of templates) {
    const group = groups.find((candidate) => candidate.key === item.layout)
    if (group) group.items.push(item)
    else other.push(item)
  }

  // 每组里空白排前面:「从头写起」是这一类的起点,现成的成稿是变体。
  for (const group of groups) {
    group.items.sort((a, b) => rank(a) - rank(b))
  }

  const result: Group[] = groups.filter((group) => group.items.length > 0)
  // 读不出版式标记的不丢掉,也不硬塞进某一类 —— 归错一类比不归类更糟。
  if (other.length > 0) {
    result.push({ key: 'other', title: '其他', hint: '没标版式的', items: other })
  }
  return result
}

const rank = (item: Template) => (item.kind === 'template' ? 0 : 1)
