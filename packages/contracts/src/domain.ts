import { z } from 'zod'

/**
 * deck 是本产品的领域对象,存成磁盘上的真实工程目录而不是数据库里的 blob。
 * 目录布局见 docs/ARCHITECTURE.md 的「Deck 是一等领域对象」。
 */

/** 汇报稿靠文字、数字、面板;故事稿一页一张照片,靠照片里形状的呼应串起来。 */
export const DeckMode = z.enum(['report', 'story'])
export type DeckMode = z.infer<typeof DeckMode>

export const Brief = z.object({
  topic: z.string(),
  audience: z.string(),
  tone: z.string(),
  mode: DeckMode,
  slideCount: z.number().int().positive(),
  /** Brief 阶段不提问。缺的细节自己定,把假设写在这里让用户看得见、能改。 */
  assumptions: z.array(z.string()),
})
export type Brief = z.infer<typeof Brief>

export const Slide = z.object({
  index: z.number().int().nonnegative(),
  /** 一页一个主角。 */
  subject: z.string(),
  /** 版式名,来自 skill 的 templates/layouts。 */
  layout: z.string(),
  points: z.array(z.string()),
  /**
   * 为什么是这个版式。visual-spec 那张表有一列「严禁用」,这个字段让那条规则可被检查,
   * 而不是只写在文档里没人执行。
   */
  layoutReason: z.string(),
})
export type Slide = z.infer<typeof Slide>

/** 转场手法。名字对齐 skills/orca-ppt/references/transitions.md。 */
export const Technique = z.enum([
  'shared-element',
  'morph',
  'one-to-many',
  'handoff',
  'match-zoom',
  'match-cut',
  'mask-cut',
  'replace-in-place',
])
export type Technique = z.infer<typeof Technique>

export const Transition = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  /** 先写两页的关系,再选手法 —— 顺序反过来就会为了炫技选手法。 */
  relation: z.string(),
  technique: Technique,
  /** 承接运动的那个元素的选择器。match-cut 靠它验轮廓重合。 */
  anchorSelector: z.string().optional(),
})
export type Transition = z.infer<typeof Transition>

/**
 * 稿子里记着的一次转场,给时间轴显示用。
 *
 * 和 `Transition` 的区别:那个是 plan 阶段**定**下来的,手法取自枚举;这个是给人看的 ——
 * 手法按稿子里写的原话。skill 做出来的稿子把计划写在 HTML 注释里,里面的手法是自然语言
 * (「整页推近」「推近式匹配剪辑」「遮挡 + 形态变换」),八项枚举装不下,硬塞会失真。
 */
export const TransitionNote = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  /** 两页之间是什么关系。时间轴上最该被看见的就是这句 —— 画面只告诉你发生了什么。 */
  relation: z.string(),
  technique: z.string(),
  /** 承接运动的元素,原样照抄。 */
  anchor: z.string().optional(),
})
export type TransitionNote = z.infer<typeof TransitionNote>

/**
 * 检视锚 —— 本产品的核心数据结构。用户在放映画布上点中一个元素时生成,
 * 随消息一起进 thread,让 agent 拿到坐标而不是形容词。
 */
export const InspectAnchor = z.object({
  slide: z.number().int().nonnegative(),
  /**
   * CSS 选择器,**相对 `slide` 那一页**(reveal 里 `.slides` 的第 slide 个 section)。
   *
   * 不从 html 起头:页号已经单独带着了,全路径只会得到一条又长又脆的选择器,对定位毫无
   * 帮助。元素有 id 或 data-anchor 时直接用那个。
   */
  selector: z.string(),
  /** 1920×1080 坐标系。 */
  box: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  /**
   * 带上下文的裁切图的绝对路径。
   *
   * 存在应用自己的数据目录,**不进 deck 目录** —— 它是这条对话的临时证据,不是稿子的
   * 内容;写进 deck 还会让文件监听把它当成稿子变了,取一次锚就刷一次画布。
   * `.deck/review/` 留给 M5 那些该跟着稿子走的逐帧证据。
   *
   * 引擎没有 imageInput、或者根本没截到时,这一项缺席,锚降级成纯文字描述。
   */
  crop: z.string().optional(),
  /** 元素当前文本,便于 agent 定位。 */
  text: z.string().optional(),
  note: z.string(),
})
export type InspectAnchor = z.infer<typeof InspectAnchor>

/** 转场锚:意见挂在两页之间而不是某个元素上。 */
export const TransitionAnchor = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  note: z.string(),
})
export type TransitionAnchor = z.infer<typeof TransitionAnchor>

export const Anchor = z.union([
  z.object({ kind: z.literal('element') }).and(InspectAnchor),
  z.object({ kind: z.literal('transition') }).and(TransitionAnchor),
])
export type Anchor = z.infer<typeof Anchor>

export const DeckPhase = z.enum(['brief', 'theme', 'outline', 'plan', 'build', 'review'])
export type DeckPhase = z.infer<typeof DeckPhase>

/** 阶段顺序。每个阶段落一个产物,可检视、可重放、可手改。 */
export const phaseOrder: DeckPhase[] = ['brief', 'theme', 'outline', 'plan', 'build', 'review']

/** 产物落在 deck 目录下的哪儿。三方共用,不许各写一份。 */
export const artifactPath: Record<DeckPhase, string> = {
  brief: '.deck/brief.json',
  theme: '.deck/theme.json',
  outline: '.deck/outline.json',
  plan: '.deck/plan.json',
  build: 'deck.html',
  review: '.deck/review',
}

export const DeckSummary = z.object({
  id: z.string(),
  title: z.string(),
  /** deck 目录的绝对路径。 */
  path: z.string(),
  phase: DeckPhase,
  updatedAt: z.number(),
})
export type DeckSummary = z.infer<typeof DeckSummary>

/**
 * 首页「我的」里的一份稿子:默认目录下的,加上在别处新建、打开过的。
 * 只列在磁盘上还在的;同款样稿和案例(只读)不算。
 */
export const RecentDeck = z.object({
  /** deck 目录的绝对路径,传给 deck.open。 */
  path: z.string(),
  title: z.string(),
  /** 稿子文件最后一次改动的时间(毫秒)。还没出成品时是目录的时间。 */
  updatedAt: z.number(),
  slideCount: z.number().int().nonnegative(),
  /** 封面:这份稿子最近一次渲的页胶片里的第一张。没在应用里打开过就没有。 */
  cover: z.string().optional(),
})
export type RecentDeck = z.infer<typeof RecentDeck>

/** Thread → Turn → Item。Item 类型借自 Codex,见 docs/PROVIDERS.md。 */
export const ItemKind = z.enum([
  'message',
  'reasoning',
  'command',
  'file_change',
  'tool_call',
  'plan',
  'error',
])
export type ItemKind = z.infer<typeof ItemKind>

export const ItemLifecycle = z.enum(['started', 'delta', 'completed'])
export type ItemLifecycle = z.infer<typeof ItemLifecycle>

export const Item = z.object({
  id: z.string(),
  turnId: z.string(),
  kind: ItemKind,
  lifecycle: ItemLifecycle,
  text: z.string().optional(),
})
export type Item = z.infer<typeof Item>
