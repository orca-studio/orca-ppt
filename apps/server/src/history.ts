import type { HistoryState } from '@orca-ppt/contracts'
import { applyTextEdit } from './edit.js'

/**
 * 一份稿子的改字记录,撤销 / 重做靠它。
 *
 * 每一步记两样:那段字从什么换成了什么,和换之前、换之后的整份成品。撤的时候稿子
 * 若还是换完的样子,就原样还回换之前 —— 一个字节都不差;在那之后被别处改过(agent
 * 直接写了 HTML、人在编辑器里动过),整份还回去会把那些改动一起抹掉,所以退一步,
 * 只把那段字反着换回去;连这也对不上就拒绝,不猜。
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
  undo(current: string): HistoryResult {
    const step = this.#done.at(-1)
    if (!step) return { ok: false, reason: '没有可以撤销的改动' }
    const result = swap(current, step.after, step.before, step.slide, step.newText, step.oldText)
    if (!result.ok) return { ok: false, reason: `撤不回去:${result.reason}` }
    this.#done.pop()
    this.#undone.push(step)
    return { ok: true, html: result.html, step }
  }

  redo(current: string): HistoryResult {
    const step = this.#undone.at(-1)
    if (!step) return { ok: false, reason: '没有可以重做的改动' }
    const result = swap(current, step.before, step.after, step.slide, step.oldText, step.newText)
    if (!result.ok) return { ok: false, reason: `重做不了:${result.reason}` }
    this.#undone.pop()
    this.#done.push(step)
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
  const [from, to] =
    direction === 'undo' ? [step.newText, step.oldText] : [step.oldText, step.newText]
  return `第 ${step.slide + 1} 页「${clip(from)}」→「${clip(to)}」`
}

function clip(text: string): string {
  return text.length > 16 ? `${text.slice(0, 15)}…` : text
}
