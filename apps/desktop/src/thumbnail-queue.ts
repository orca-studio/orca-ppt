type Paths = Array<string | null>
type Job = {
  task: () => Promise<Paths>
  resolve: (paths: Paths) => void
  reject: (reason: unknown) => void
}

/** One capture window at a time; only the latest waiting request for each target survives. */
export class ThumbnailQueue {
  private running = false
  private waiting = new Map<string, Job>()

  constructor(private readonly maxWaiting = 4) {}

  run(key: string, task: Job['task']): Promise<Paths> {
    const previous = this.waiting.get(key)
    if (!previous && this.waiting.size >= this.maxWaiting) {
      return Promise.reject(new Error('缩略图任务繁忙，请稍后重试'))
    }
    previous?.resolve([])
    return new Promise((resolve, reject) => {
      this.waiting.set(key, { task, resolve, reject })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const [key, job] of this.waiting) {
        this.waiting.delete(key)
        try {
          job.resolve(await job.task())
        } catch (error) {
          job.reject(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
