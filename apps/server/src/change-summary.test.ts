import { expect, it } from 'vitest'
import { clipWords, planEditSummary, textEditSummary, textStepSummary } from './change-summary.js'

it('改字引改成的那段字,短到一行字幕放得下', () => {
  expect(textEditSummary(0, '中国航天大事记')).toBe('第 1 页改成「中国航天大事记」')
  expect(textEditSummary(2, '')).toBe('删掉第 3 页的一段字')
})

it('太长在词的边界上收住,不切在半个词上', () => {
  const clipped = clipWords('每翻一页，年份像滚轮一样滚到下一个数。')
  expect(clipped.endsWith('…')).toBe(true)
  expect([...clipped].length).toBeLessThanOrEqual(10)
  expect('每翻一页，年份像滚轮一样滚到下一个数。'.startsWith(clipped.slice(0, -1))).toBe(true)
  // 英文按单词断,不留半个单词
  expect(clipWords('Orca PPT makes slides move', 12)).toBe('Orca PPT…')
  expect(clipWords('短句')).toBe('短句')
})

it('转场计划不引原文:里面的 HTML 属性念不出来', () => {
  expect(
    planEditSummary('写 data-text="year" data-roll', '写 data-text="year" data-roll="4"'),
  ).toBe('更新转场计划')
  expect(planEditSummary('2→3 关系：年份逐位滚到 1978', '2→3 关系：年份逐位滚到 2003')).toBe(
    '更新第 2→3 页的转场计划',
  )
  expect(planEditSummary('4->5 关系：标题原地换', '')).toBe('删掉第 4→5 页的转场计划')
  expect(planEditSummary('写 <p class="x">', '')).toBe('删掉转场计划里的一句')
})

it('撤销重做不引字,字幕一眼看出在干什么', () => {
  expect(textStepSummary('undo', 1)).toBe('撤销第 2 页的改字')
  expect(textStepSummary('redo', 1)).toBe('重做第 2 页的改字')
})

it('所有摘要都在 20 字以内', () => {
  const all = [
    textEditSummary(11, '一段很长很长很长很长很长很长的新标题文字'),
    planEditSummary('', '12→13 关系：一段很长的说明'),
    planEditSummary('12→13 关系', ''),
  ]
  for (const summary of all) expect([...summary].length).toBeLessThanOrEqual(20)
})
