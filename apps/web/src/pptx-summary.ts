import type { RequestResult } from '@orca-ppt/contracts'

type Exported = RequestResult<'deck.exportPptx'>

const KIND: Record<Exported['degraded'][number]['kind'], string> = {
  morph: '平滑',
  fade: '淡入淡出',
  wipe: '擦除',
  none: '无转场',
}

/** 页号连成段:2、3、4、6 → 第 2–4、6 页 */
function pages(list: number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b)
  const runs: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (sorted[j + 1] === sorted[j]! + 1) j++
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`)
    i = j
  }
  return `第 ${runs.join('、')} 页`
}

/**
 * 导完之后说给人听的话:哪几次翻页和网页不一样、哪些效果导不出来、要装哪些字体。
 * 都是 PowerPoint 里看得出来的差别,不说就像是导坏了。
 */
export function pptxSummary(result: Exported): { message: string; detail: string } {
  const parts: string[] = []
  if (result.degraded.length) {
    parts.push(
      '这几次翻页在 PowerPoint 里和网页不一样:\n' +
        result.degraded
          .map((d) => `第 ${d.from}→${d.to} 页  ${d.technique}  → ${KIND[d.kind]}`)
          .join('\n'),
    )
  } else {
    parts.push('每次翻页都和网页一样。')
  }

  // 同一种效果常常好几页都有,按效果归在一起
  const lost = new Map<string, number[]>()
  for (const { slide, items } of result.lost)
    for (const item of items) lost.set(item, [...(lost.get(item) ?? []), slide])
  if (lost.size) {
    parts.push(
      '导不出来的效果:\n' +
        [...lost].map(([item, slides]) => `${pages(slides)}  ${item}`).join('\n'),
    )
  }

  if (result.fonts.length) {
    parts.push(`字体没有嵌进文件,打开它的电脑要装:${result.fonts.join('、')}`)
  }
  return { message: `已导出 PPTX(${result.slides} 页)`, detail: parts.join('\n\n') }
}
