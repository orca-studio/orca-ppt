import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearPortFile, readPort, writePortFile } from './port-file.js'

async function env() {
  const dir = await mkdtemp(join(tmpdir(), 'port-'))
  return { ORCA_PPTCODE_PORT_FILE: join(dir, 'nested', 'port') }
}

describe('端口文件', () => {
  it('写了就读得回来,父目录自己建', async () => {
    const e = await env()
    await writePortFile(7331, e)
    expect(await readFile(e.ORCA_PPTCODE_PORT_FILE, 'utf8')).toBe('7331')
    expect(await readPort(e)).toBe(7331)
  })

  it('没有文件就是没有,不抛', async () => {
    expect(await readPort(await env())).toBeUndefined()
  })

  it('环境变量优先 —— 同时跑两个实例时用它指定', async () => {
    const e = await env()
    await writePortFile(7331, e)
    expect(await readPort({ ...e, ORCA_PPTCODE_PORT: '7999' })).toBe(7999)
  })

  it('文件里是垃圾就当没有,不返回 NaN', async () => {
    const e = await env()
    await writePortFile(7331, e)
    await writeFile(e.ORCA_PPTCODE_PORT_FILE, '不是数字')
    expect(await readPort(e)).toBeUndefined()
  })

  it('清掉之后读不到', async () => {
    const e = await env()
    await writePortFile(7331, e)
    await clearPortFile(e)
    expect(await readPort(e)).toBeUndefined()
  })

  it('清一个不存在的不抛', async () => {
    await expect(clearPortFile(await env())).resolves.toBeUndefined()
  })
})
