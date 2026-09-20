import { artifactPath, phaseOrder, type DeckPhase, type Slide } from '@orca-pptcode/contracts'

export { artifactPath, phaseOrder }

/** 手改了某个阶段的产物,它下游的都得重跑。 */
export function downstreamOf(phase: DeckPhase): DeckPhase[] {
  return phaseOrder.slice(phaseOrder.indexOf(phase) + 1)
}

export interface OutlineIssue {
  slide: number
  message: string
}

/**
 * visual-spec 那张表有一列「严禁用」:没有大小关系的东西进图表、不对等的两项并排、
 * 凑不满的格子硬撑 —— 读者看出来的关系都是假的。
 *
 * 这里只做能确定性判定的那部分。判不了的交给视觉自评,不在这里假装能判。
 */
export function validateOutline(slides: Slide[]): OutlineIssue[] {
  const issues: OutlineIssue[] = []
  for (const slide of slides) {
    if (slide.layoutReason.trim().length === 0) {
      issues.push({ slide: slide.index, message: '没写为什么选这个版式 —— 版式是被内容挑中的' })
    }
    if (slide.points.length === 0) {
      issues.push({ slide: slide.index, message: '这一页没有内容' })
    }
    if (slide.subject.trim().length === 0) {
      issues.push({ slide: slide.index, message: '一页一个主角,这页没有主角' })
    }
    // 格子类版式凑不满,读者会以为少了一项。
    if (/grid|格|matrix/i.test(slide.layout) && slide.points.length < 3) {
      issues.push({
        slide: slide.index,
        message: `格子版式只有 ${slide.points.length} 项,凑不满就换一种版式`,
      })
    }
  }
  return issues
}
