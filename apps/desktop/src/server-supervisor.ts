import { spawn, type ChildProcess } from 'node:child_process'

/**
 * server 是一个独立的长驻进程,不是主进程里的一个模块。关掉或重启 Electron 窗口不会
 * 停掉正在跑的 agent 轮次和录制 job —— 这是这个形状存在的主要理由。
 */
export class ServerSupervisor {
  #child: ChildProcess | undefined

  /** server 在 stdout 上报端口。等到那一行再开窗口,避免渲染层连一个还没起来的端口。 */
  async start(entry: string): Promise<number> {
    const child = spawn(process.execPath, [entry], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    this.#child = child

    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server 没有在 10 秒内报出端口')), 10_000)
      let buffer = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = buffer.match(/orca-ppt server listening (\d+)/)
        if (!match?.[1]) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`server 退出,code ${code}`)))
    })
  }

  stop(): void {
    this.#child?.kill()
    this.#child = undefined
  }
}
