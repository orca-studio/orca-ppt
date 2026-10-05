import type { HistoryState } from '@orca-ppt/contracts'
import { applyTextEdit } from './edit.js'

/**
 * 一份稿子的共享编辑记录,撤销 / 重做靠它。
 *
 * 每一步记两样:那段字从什么换成了什么,和换之前、换之后的整份成品。撤的时候稿子
 * 若还是换完的样子,就原样还回换之前 —— 一个字节都不差;在那之后被别处改过(agent
 * 直接写了 HTML、人在编辑器里动过),整份还回去会把那些改动一起抹掉,所以退一步,
 * 只把那段字反着换回去;连这也对不上就拒绝,不猜。
 *
 * 页面和图片编辑还要求 HTML 和关联元数据完全匹配,不尝试猜测合并。
 *
 * 只活在 server 进程里:重启就没了。稿子是磁盘上的目录,别的工具随时能动它,
 * 一份存盘的历史对不上它的时候比对得上多。
 */
export interface EditStep {
  slide: number
  oldText: string
  newText: string
  before: string
  after: string
  /** Structured edits require exact source and metadata matches. */
  undoSlide?: number
  label?: string
  files?: Record<string, { before: string | null; after: string | null }>
}

export type HistoryResult =
  { ok: true; html: string; step: EditStep } | { ok: false; reason: string }

/** 够撤一下午的,又不至于让一份大稿子在内存里攒上几百份。 */
const LIMIT = 100

export class EditHistory {
  readonly #done: EditStep[] = []
  readonly #undone: EditStep[] = []

  record(step: EditStep): void {
    this.#done.push(step)
    if (this.#done.length > LIMIT) this.#done.shift()
    // 又改了一处,之前撤掉的就接不上了。
    this.#undone.length = 0
  }

  peek(direction: 'undo' | 'redo'): EditStep | undefined {
    return (direction === 'undo' ? this.#done : this.#undone).at(-1)
  }

  commit(direction: 'undo' | 'redo'): void {
    const from = direction === 'undo' ? this.#done : this.#undone
    const to = direction === 'undo' ? this.#undone : this.#done
    const step = from.pop()
    if (step) to.push(step)
  }

  state(): HistoryState {
    const undo = this.#done.at(-1)
    const redo = this.#undone.at(-1)
    return {
      canUndo: Boolean(undo),
      canRedo: Boolean(redo),
      ...(undo ? { undo: describe(undo, 'undo') } : {}),
      ...(redo ? { redo: describe(redo, 'redo') } : {}),
    }
  }

  /** `current` 是磁盘上此刻的成品。成了才出栈 —— 拒绝的那一步留着,不丢。 */
  undo(current: string, files: Record<string, string | null> = {}, commit = true): HistoryResult {
    const step = this.#done.at(-1)
    if (!step) return { ok: false, reason: '没有可以撤销的改动' }
    if (step.label && !matches(step, current, files, 'after'))
      return { ok: false, reason: '撤不回去:文件已被外部修改，请先检查当前稿子' }
    const result = swap(current, step.after, step.before, step.slide, step.newText, step.oldText)
    if (!result.ok) return { ok: false, reason: `撤不回去:${result.reason}` }
    if (commit) this.commit('undo')
    return { ok: true, html: result.html, step }
  }

  redo(current: string, files: Record<string, string | null> = {}, commit = true): HistoryResult {
    const step = this.#undone.at(-1)
    if (!step) return { ok: false, reason: '没有可以重做的改动' }
    if (step.label && !matches(step, current, files, 'before'))
      return { ok: false, reason: '重做不了:文件已被外部修改，请先检查当前稿子' }
    const result = swap(current, step.before, step.after, step.slide, step.oldText, step.newText)
    if (!result.ok) return { ok: false, reason: `重做不了:${result.reason}` }
    if (commit) this.commit('redo')
    return { ok: true, html: result.html, step }
  }
}

function swap(
  current: string,
  expected: string,
  target: string,
  slide: number,
  from: string,
  to: string,
): { ok: true; html: string } | { ok: false; reason: string } {
  if (current === expected) return { ok: true, html: target }
  return applyTextEdit(current, { slide, oldText: from, newText: to })
}

function describe(step: EditStep, direction: 'undo' | 'redo'): string {
  if (step.label) return step.label
  const [from, to] =
    direction === 'undo' ? [step.newText, step.oldText] : [step.oldText, step.newText]
  return `第 ${step.slide + 1} 页「${clip(from)}」→「${clip(to)}」`
}

function clip(text: string): string {
  return text.length > 16 ? `${text.slice(0, 15)}…` : text
}

function matches(
  step: EditStep,
  html: string,
  files: Record<string, string | null>,
  side: 'before' | 'after',
) {
  return (
    html === step[side] &&
    Object.entries(step.files ?? {}).every(([name, value]) => files[name] === value[side])
  )
}
