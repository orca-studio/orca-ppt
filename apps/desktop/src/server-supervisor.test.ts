import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ServerSupervisor, spawnNode } from './server-supervisor.js'

describe('ServerSupervisor', () => {
  it('server 立刻退出时抛错,而不是挂到超时', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sup-'))
    const entry = join(dir, 'exit.cjs')
    await writeFile(entry, 'process.exit(3)')
    await expect(new ServerSupervisor(spawnNode).start(entry)).rejects.toThrow('code 3')
  })

  it('认得 stdout 上那行端口,并且只认那个格式', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sup-'))
    const entry = join(dir, 'ok.cjs')
    // 分两次写,顺便验证跨 chunk 的那一行也能拼出来。
    await writeFile(
      entry,
      "process.stdout.write('noise\\norca-ppt server ');" +
        "setTimeout(() => process.stdout.write('listening 7331\\n'), 10);" +
        'setTimeout(() => {}, 1000)',
    )
    const supervisor = new ServerSupervisor(spawnNode)
    await expect(supervisor.start(entry)).resolves.toBe(7331)
    supervisor.stop()
  })

  it('已经在跑就沿用,不另起一个;stop 之后再 start 才重新起', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sup-'))
    const entry = join(dir, 'ok.cjs')
    await writeFile(
      entry,
      "process.stdout.write('orca-ppt server listening ' + process.pid + '\\n');" +
        'setTimeout(() => {}, 5000)',
    )
    const supervisor = new ServerSupervisor(spawnNode)
    const first = await supervisor.start(entry)
    // macOS 上关了窗口再开:连回同一个 server
    await expect(supervisor.start(entry)).resolves.toBe(first)
    supervisor.stop()
    await expect(supervisor.start(entry)).resolves.not.toBe(first)
    supervisor.stop()
  })

  it('server 自己退出了,下次 start 重新起', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sup-'))
    const entry = join(dir, 'brief.cjs')
    await writeFile(
      entry,
      "process.stdout.write('orca-ppt server listening ' + process.pid + '\\n');" +
        'setTimeout(() => process.exit(0), 50)',
    )
    const supervisor = new ServerSupervisor(spawnNode)
    const first = await supervisor.start(entry)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(supervisor.start(entry)).resolves.not.toBe(first)
    supervisor.stop()
  })
})
