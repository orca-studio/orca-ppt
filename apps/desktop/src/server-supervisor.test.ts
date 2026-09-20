import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ServerSupervisor } from './server-supervisor.js'

describe('ServerSupervisor', () => {
  it('server 立刻退出时抛错,而不是挂到超时', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sup-'))
    const entry = join(dir, 'exit.cjs')
    await writeFile(entry, 'process.exit(3)')
    await expect(new ServerSupervisor().start(entry)).rejects.toThrow('code 3')
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
    const supervisor = new ServerSupervisor()
    await expect(supervisor.start(entry)).resolves.toBe(7331)
    supervisor.stop()
  })
})
