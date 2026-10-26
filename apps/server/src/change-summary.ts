/**
 * 操作记录里每次改动的一句话(recording_events 的 summary)。录屏宿主直接拿它当字幕:
 * 要短到一行放得下(20 字左右),是人话,能念出来。
 *
 * 不引源码原文 —— 转场计划注释里是 HTML 属性、选择器,截断了既看不懂也念不出来。
 * 页面上的字可以引,但只引改成的那段,太长就在词的边界上收住,不切在半个词上。
 */

/** 引用页面文字时最多几个字。加上「第 NN 页改成「…」」正好 20 字。 */
const QUOTE_MAX = 9

const words = new Intl.Segmenter('zh', { granularity: 'word' })

/** 截到 max 个字以内,只在词的边界上断;断了就补「…」。 */
export function clipWords(text: string, max = QUOTE_MAX): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  if ([...flat].length <= max) return flat
  let kept = ''
  for (const { segment } of words.segment(flat)) {
    if ([...kept].length + [...segment].length > max) break
    kept += segment
  }
  // 第一个词就超长(一串没有分词的英文、数字):只好按字切
  if (!kept) kept = [...flat].slice(0, max).join('')
  return `${kept.replace(/[\s,，、。:：;；]+$/, '')}…`
}

const page = (slide: number) => `第 ${slide + 1} 页`

/** edit_text:引改成的那段字;改成空就是删掉了。 */
export function textEditSummary(slide: number, newText: string): string {
  return newText.trim()
    ? `${page(slide)}改成「${clipWords(newText)}」`
    : `删掉${page(slide)}的一段字`
}

/**
 * edit_plan:转场计划是写给 agent 看的注释,不引原文。认得出说的是哪两页之间
 * (「2→3」这种写法)就说出来,认不出就只说更新了转场计划。
 */
export function planEditSummary(oldText: string, newText: string): string {
  const pair = (newText.trim() ? newText : oldText).match(/(\d+)\s*(?:→|->)\s*(\d+)/)
  const where = pair ? `第 ${pair[1]}→${pair[2]} 页的` : ''
  if (!newText.trim()) return pair ? `删掉${where}转场计划` : '删掉转场计划里的一句'
  return `更新${where}转场计划`
}

/** 撤销、重做一处改字。现在是什么字不引:字幕上「撤销」两个字已经说清了在干什么。 */
export function textStepSummary(direction: 'undo' | 'redo', slide: number): string {
  return `${direction === 'undo' ? '撤销' : '重做'}${page(slide)}的改字`
}
