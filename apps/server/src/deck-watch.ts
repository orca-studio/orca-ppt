import { watch as nodeWatch, type FSWatcher } from 'node:fs'

/** 只用到 close();注入假实现来确定性地测攒批和去重。 */
export type WatchFn = (path: string, onEvent: () => void) => { close(): void }

const defaultWatch: WatchFn = (path, onEvent) =>
  nodeWatch(path, { recursive: true }, () => onEvent()) as FSWatcher

/**
 * deck 目录变了就让画布重载。
 *
 * 监听目录而不是等 agent 说「我改完了」:用户自己在编辑器里改的那一版也该立刻出现在
 * 画布上 —— deck 是磁盘上的目录,不是本产品私有的状态,别的工具改它是正常用法。
 */
export class DeckWatcher {
  readonly #watchers = new Map<string, { close(): void }>()
  readonly #timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly onChange: (deckId: string) => void,
    /**
     * 一次保存常常触发好几个事件,攒一下再报。
     *
     * macOS 的 FSEvents 会把一次写入的事件摊在几十毫秒里,窗口比那个抖动短的话,
     * 一次保存会报成两次 —— 所以这个值不能随便调小。
     */
    private readonly settleMs = 150,
    private readonly watchFn: WatchFn = defaultWatch,
  ) {}

  watch(deckId: string, path: string): void {
    if (this.#watchers.has(deckId)) return
    // 不做路径过滤:macOS 的递归监听会给每一级祖先都报事件,按前缀过滤不住。
    // 真正的办法是别往 deck 目录里写临时东西 —— 锚的裁切图存在应用自己的数据目录里。
    const watcher = this.watchFn(path, () => this.#schedule(deckId))
    this.#watchers.set(deckId, watcher)
  }

  unwatch(deckId: string): void {
    this.#watchers.get(deckId)?.close()
    this.#watchers.delete(deckId)
    const timer = this.#timers.get(deckId)
    if (timer) clearTimeout(timer)
    this.#timers.delete(deckId)
  }

  closeAll(): void {
    for (const deckId of [...this.#watchers.keys()]) this.unwatch(deckId)
  }

  #schedule(deckId: string): void {
    // 已经停掉的就不报了。close() 之后仍可能送来一个在途事件,那时 deck 可能已经关了。
    if (!this.#watchers.has(deckId)) return

    const existing = this.#timers.get(deckId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#timers.delete(deckId)
      this.onChange(deckId)
    }, this.settleMs)
    // 攒事件的定时器不该拖着进程不退出。
    timer.unref?.()
    this.#timers.set(deckId, timer)
  }
}
