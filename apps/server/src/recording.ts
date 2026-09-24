import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RecordingEvent } from '@orca-ppt/contracts'

/**
 * 操作记录:稿子每被改一次记一条。「可录制应用」约定 v1 的应用这一侧
 * (jevbot-mac docs/recordable-app-contract.md)—— 回放的主体在宿主那边,
 * 这里只负责把宿主看不到的事报出来:人在界面上改了什么、文件在外面被改了。
 *
 * **存在应用自己的数据目录,不写进稿子目录。** 这是本机的操作记录,不是稿子的内容;
 * 写进稿子目录还会被文件监听当成「稿子变了」。
 *
 * 一行一条 JSON,只追加。游标是补零的序号,重启后从文件里最后一条接着编 ——
 * 发出去的游标重启后必须还能用。
 */
export function recordingFilePath(env = process.env): string {
  return env.ORCA_PPT_RECORDING_FILE ?? join(homedir(), '.orca-ppt', 'recording.jsonl')
}

/** 约定要求:至少保留 7 天或 10,000 条,以留得更多的为准。 */
export const KEEP_DAYS = 7
export const KEEP_COUNT = 10_000
const ID_WIDTH = 9

export type NewEvent = Omit<RecordingEvent, 'id' | 'at'>

export interface EventPage {
  events: RecordingEvent[]
  cursor: string
  more: boolean
  gap: boolean
}

export class RecordingLog {
  #events: RecordingEvent[] = []
  #seq = 0
  /** 已经清掉的最大序号。游标比它还旧,中间就有一段丢了。 */
  #prunedUpTo = 0
  /** 写盘排队:追加要按顺序落,清理重写要等前面的写完。 */
  #writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file = recordingFilePath(),
    private readonly now = () => new Date(),
    private readonly keep = { days: KEEP_DAYS, count: KEEP_COUNT },
  ) {}

  /** 从文件里读回来。文件坏了的那几行跳过 —— 丢几条记录不该让应用起不来。 */
  async load(): Promise<void> {
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        this.#events.push(RecordingEvent.parse(JSON.parse(line)))
      } catch {
        // 写到一半断电之类:跳过
      }
    }
    const first = this.#events[0]
    const last = this.#events.at(-1)
    this.#seq = last ? Number(last.id) : 0
    this.#prunedUpTo = first ? Number(first.id) - 1 : 0
    if (this.#prune()) this.#rewrite()
  }

  append(event: NewEvent): RecordingEvent {
    this.#seq += 1
    const full = RecordingEvent.parse({
      ...event,
      id: String(this.#seq).padStart(ID_WIDTH, '0'),
      at: isoWithZone(this.now()),
    })
    this.#events.push(full)
    const line = `${JSON.stringify(full)}\n`
    this.#queue(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, line, 'utf8')
    })
    if (this.#prune()) this.#rewrite()
    return full
  }

  /** 游标之后的事件。游标就是事件 id,按字符串比较(补零保证了和数值顺序一致)。 */
  since(after: string | undefined, limit = 200): EventPage {
    const start = after === undefined ? 0 : this.#events.findIndex((event) => event.id > after)
    const from = start === -1 ? this.#events.length : start
    const events = this.#events.slice(from, from + limit)
    return {
      events,
      cursor: events.at(-1)?.id ?? after ?? '',
      more: from + limit < this.#events.length,
      gap: after !== undefined && Number(after) < this.#prunedUpTo,
    }
  }

  /** 这份稿子最近一条事件。 */
  lastFor(documentId: string): RecordingEvent | undefined {
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      if (this.#events[i]!.document.id === documentId) return this.#events[i]
    }
    return undefined
  }

  /** 等所有写盘落完。测试和退出时用。 */
  flush(): Promise<void> {
    return this.#writing
  }

  /** 超出保留范围的删掉。只删「既超过 7 天、又不在最近 10,000 条里」的。 */
  #prune(): boolean {
    const cutoff = this.now().getTime() - this.keep.days * 86_400_000
    let dropped = 0
    while (
      this.#events.length - dropped > this.keep.count &&
      Date.parse(this.#events[dropped]!.at) < cutoff
    ) {
      dropped += 1
    }
    if (!dropped) return false
    this.#prunedUpTo = Number(this.#events[dropped - 1]!.id)
    this.#events = this.#events.slice(dropped)
    return true
  }

  #rewrite(): void {
    const text = this.#events.map((event) => `${JSON.stringify(event)}\n`).join('')
    this.#queue(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, text, 'utf8')
    })
  }

  #queue(task: () => Promise<void>): void {
    this.#writing = this.#writing.then(task).catch((error: unknown) => {
      // 记不下来不该让改稿子失败 —— 打出来,别吞掉
      process.stderr.write(
        `[recording] ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }
}

/** `2026-09-24T09:22:24.512+08:00`:本地时间、毫秒、带时区。 */
export function isoWithZone(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  )
}
