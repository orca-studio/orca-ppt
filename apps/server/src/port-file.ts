import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * server 绑的是随机端口(固定端口会撞车),但 MCP 进程是**另外一个进程**,得知道连哪儿。
 * 所以把端口写进一个众所周知的文件,两边都认它。
 *
 * 不用固定端口的理由:端口被占时要么起不来,要么静默换一个然后 MCP 连到别人家去。
 */
export function portFilePath(env = process.env): string {
  return env.ORCA_PPT_PORT_FILE ?? join(homedir(), '.orca-ppt', 'port')
}

export async function writePortFile(port: number, env = process.env): Promise<void> {
  const path = portFilePath(env)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, String(port), 'utf8')
}

export async function clearPortFile(env = process.env): Promise<void> {
  await rm(portFilePath(env), { force: true })
}

/** 读端口。环境变量优先 —— 同时跑两个实例时用它指定。 */
export async function readPort(env = process.env): Promise<number | undefined> {
  if (env.ORCA_PPT_PORT) {
    const explicit = Number(env.ORCA_PPT_PORT)
    return Number.isInteger(explicit) && explicit > 0 ? explicit : undefined
  }
  try {
    const port = Number((await readFile(portFilePath(env), 'utf8')).trim())
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}
