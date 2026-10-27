import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServeState } from './serve.js'

describe('readServeState', () => {
  const env = async (content?: string) => {
    const file = join(await mkdtemp(join(tmpdir(), 'serve-state-')), 'serve.json')
    if (content !== undefined) await writeFile(file, content)
    return { ORCA_PPT_SERVE_STATE: file }
  }

  it('没有状态文件就是没在跑', async () => {
    expect(await readServeState(await env())).toBeUndefined()
  })

  it('进程还在就报它的网址', async () => {
    const state = { pid: process.pid, port: 6722, url: 'http://127.0.0.1:6722/?token=t' }
    expect(await readServeState(await env(JSON.stringify(state)))).toEqual(state)
  })

  it('记着的进程已经不在了,当没在跑 —— 不然 --detach 会报一个死掉的网址', async () => {
    const dead = { pid: 2 ** 22 + 12345, port: 6722, url: 'http://127.0.0.1:6722/?token=t' }
    expect(await readServeState(await env(JSON.stringify(dead)))).toBeUndefined()
  })
})
