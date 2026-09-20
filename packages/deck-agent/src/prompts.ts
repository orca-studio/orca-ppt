import type { DeckPhase } from '@orca-pptcode/contracts'
import { artifactPath } from './phases.js'

/**
 * 各阶段的提示词。**品味在这里,不在 server**(见 docs/ARCHITECTURE.md 的责任边界表)。
 *
 * 一条贯穿的原则:每个阶段只产出一份产物然后停下。让模型一口气从一句话写到成品,中间
 * 那些判断(版式为什么选它、转场为什么用这个手法)就永远看不见、也改不动 —— 而那些判断
 * 恰恰是稿子好不好的全部。
 */

export interface PhaseContext {
  /** 用户那句话。 */
  request: string
  /** skill 根目录的绝对路径。规范、主题、版式、模板都在里面。 */
  skillPath?: string | undefined
  /** 可选的主题列表,给 theme 阶段挑。 */
  themes?: string[]
}

const COMMON = (context: PhaseContext): string => {
  const skill = context.skillPath
    ? `转场规范、主题、版式模板都在 \`${context.skillPath}\`。先读它的 \`SKILL.md\`。`
    : '找不到 orca-transition-skill —— 先说明这一点,不要凭印象编一套规范出来。'
  return `你在一个演示稿工程目录里工作,当前目录就是这份 deck。\n${skill}`
}

export function phasePrompt(phase: DeckPhase, context: PhaseContext): string {
  const head = COMMON(context)
  const out = artifactPath[phase]

  switch (phase) {
    case 'brief':
      return `${head}

用户说:「${context.request}」

把它变成一份 brief,写进 \`${out}\`:

\`\`\`json
{ "topic": "", "audience": "", "tone": "", "mode": "report | story",
  "slideCount": 0, "assumptions": [] }
\`\`\`

**不要提问。** 缺的细节自己定,把定了什么写进 \`assumptions\`,一条一句话。用户在界面上
看得见、能改。一上来问五个问题的产品没人用第二次。

\`mode\`:页面由文字、数字、面板组成的是 \`report\`;一页一张照片、靠照片里形状呼应串起来
的是 \`story\`。

只写这个文件,写完就停。`

    case 'theme':
      return `${head}

读 \`${artifactPath.brief}\`,给这份稿子定主题,写进 \`${out}\`:

\`\`\`json
{ "name": "主题名", "reason": "为什么是它" }
\`\`\`

${
  context.themes?.length
    ? `现成主题:${context.themes.join('、')}。先看有没有合适的。`
    : '先看 skill 的 `runtime/themes/` 里有没有合适的。'
}
都不合适再按 \`references/themes.md\` 新建一个,\`name\` 写新建的那个文件名。

**不要在稿子里改颜色** —— 颜色只能来自主题文件。

只写这个文件,写完就停。`

    case 'outline':
      return `${head}

读 \`${artifactPath.brief}\` 和 \`${artifactPath.theme}\`,列出每一页,写进 \`${out}\`:

\`\`\`json
{ "slides": [ { "index": 0, "subject": "这一页的主角", "layout": "版式名",
                "points": ["要点"], "layoutReason": "为什么是这个版式" } ] }
\`\`\`

顺序不许反:**先有内容,再挑版式**。按 \`references/visual-spec.md\` 的「先看内容,再选页面
类型」挑,那张表有一列「严禁用」—— 撞上了就换一种,不要把内容硬塞进不合适的形状:

- 没有大小关系的东西不进图表
- 不对等的两项不并排
- 凑不满的格子不硬撑

读者从这些形状里看出来的关系是假的。\`layoutReason\` 要说清这一页的内容为什么适配这个版式,
写「布局清晰」这种话等于没写。

一页一个主角。只写这个文件,写完就停。`

    case 'plan':
      return `${head}

读 \`${artifactPath.outline}\`,写转场计划,写进 \`${out}\`:

\`\`\`json
{ "transitions": [ { "from": 0, "to": 1, "relation": "两页之间是什么关系",
                     "technique": "手法", "anchorSelector": "承接运动的元素" } ] }
\`\`\`

每次翻页一行。顺序不许反:**先写两页的「关系」,再选手法** —— 反过来就会为了炫技选手法,
翻出来观众看不懂在动什么。

手法只能取这些:\`shared-element\`(共享元素)、\`morph\`(形态变换)、\`one-to-many\`(一变多)、
\`handoff\`(元素交接)、\`match-zoom\`(匹配放大)、\`match-cut\`(匹配剪辑,对齐形状的硬切)、
\`mask-cut\`(遮挡剪辑)、\`replace-in-place\`(原地替换)。细节读 \`references/transitions.md\`。

\`match-cut\` 要写 \`anchorSelector\` —— 它是硬切,靠切点前后两帧锚的轮廓完全重合来验。

只写这个文件,写完就停。`

    case 'build':
      return `${head}

读 \`${artifactPath.brief}\`、\`${artifactPath.theme}\`、\`${artifactPath.outline}\`、
\`${artifactPath.plan}\`,按它们写出 \`${out}\`。

按 SKILL.md 的流程走:report 从 \`templates/starter.html\` 开始,story 从
\`templates/story-starter.html\` 开始,把 \`{{ROOT}}\` 换成这份 HTML 到 skill 根目录的相对
路径,在 \`tokens.css\` 之后引入主题文件(先读主题文件开头的注释:哪些颜色可以互变、新增了
哪些类)。

转场计划作为 HTML 注释放进文件开头,格式就是 \`plan.json\` 里那几行。

前面四份产物是**决定**,不是建议:不要在这一步改版式、换手法、加页。真觉得某处不对,
写完之后说出来,让用户回去改那一份产物再重跑。

只写这个文件和它需要的素材。`

    case 'review':
      return `${head}

录制并自检。这一阶段在 M5 接上,现在不要执行。`
  }
}
