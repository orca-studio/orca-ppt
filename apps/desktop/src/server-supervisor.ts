import { spawn } from 'node:child_process'

/**
 * server 是一个独立的长驻进程,不是主进程里的一个模块。关掉或重启 Electron 窗口不会
 * 停掉正在跑的 agent 轮次和录制 job —— 这是这个形状存在的主要理由。
 *
 * 怎么起这个进程由调用方给(`Launch`):桌面壳里用 Electron 的 `utilityProcess.fork()`,
 * 测试里(普通 Node,没有 utilityProcess)用 `spawnNode`。
 *
 * 不再用 `spawn(process.execPath)` + `ELECTRON_RUN_AS_NODE`:那要求发布版一直开着
 * Electron 的 RunAsNode fuse,而开着它,本机任何程序都能借我们签过名的应用当 Node 跑代码,
 * 还沿用用户授予这个应用的系统权限。utilityProcess 不依赖这个 fuse,打包时可以关掉。
 */
export interface ServerProcess {
  /** server 在这里报端口。 */
  stdout: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null) => void): unknown
  kill(): unknown
}

export type Launch = (entry: string, env: Record<string, string>) => ServerProcess

/** 普通 Node 里起 server(测试用)。 */
export const spawnNode: Launch = (entry, env) =>
  spawn(process.execPath, [entry], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })

export class ServerSupervisor {
  #child: ServerProcess | undefined

  constructor(private readonly launch: Launch) {}

  /** server 在 stdout 上报端口。等到那一行再开窗口,避免渲染层连一个还没起来的端口。 */
  async start(entry: string, env: Record<string, string> = {}): Promise<number> {
    const child = this.launch(entry, env)
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
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`server 退出,code ${code}`))
      })
    })
  }

  stop(): void {
    this.#child?.kill()
    this.#child = undefined
  }
}
