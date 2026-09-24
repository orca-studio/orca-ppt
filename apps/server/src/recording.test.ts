import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecordingLog, isoWithZone, type NewEvent } from './recording.js'

const doc = { id: '/decks/q3', label: 'q3' }
const edit = (summary: string, revision = 'r1'): NewEvent => ({
  actor: 'user',
  summary,
  document: doc,
  revision,
})

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'orca-rec-')), 'recording.jsonl')
}

describe('RecordingLog', () => {
  it('游标是补零序号,按字符串比较就是先后顺序', async () => {
    const log = new RecordingLog(await file())
    const a = log.append(edit('一'))
    const b = log.append(edit('二'))
    expect(a.id).toBe('000000001')
    expect(b.id > a.id).toBe(true)
  })

  it('从游标之后接着取;没有新事件时原样还回游标', async () => {
    const log = new RecordingLog(await file())
    log.append(edit('一'))
    const second = log.append(edit('二'))
    log.append(edit('三'))

    const page = log.since(second.id)
    expect(page.events.map((e) => e.summary)).toEqual(['三'])
    expect(log.since(page.cursor)).toMatchObject({ events: [], cursor: page.cursor, more: false })
  })

  it('一次取不完就 more,宿主拿新游标接着取', async () => {
    const log = new RecordingLog(await file())
    for (let i = 0; i < 5; i += 1) log.append(edit(String(i)))
    const first = log.since(undefined, 2)
    expect(first).toMatchObject({ more: true, cursor: '000000002' })
    expect(log.since(first.cursor, 10).events).toHaveLength(3)
  })

  it('重启后游标接着编,重启前发出的游标还能用 —— 约定要求', async () => {
    const path = await file()
    const before = new RecordingLog(path)
    before.append(edit('一'))
    const cursor = before.append(edit('二')).id
    await before.flush()

    const after = new RecordingLog(path)
    await after.load()
    expect(after.append(edit('三')).id).toBe('000000003')
    expect(after.since(cursor).events.map((e) => e.summary)).toEqual(['三'])
  })

  it('超出保留范围的清掉;游标比清掉的还旧就报 gap', async () => {
    let now = new Date('2026-09-01T00:00:00Z')
    const log = new RecordingLog(await file(), () => now, { days: 7, count: 2 })
    const old = log.append(edit('一'))
    log.append(edit('二'))
    now = new Date('2026-09-20T00:00:00Z')
    log.append(edit('三'))
    log.append(edit('四'))

    const page = log.since(old.id)
    expect(page.gap).toBe(true)
    expect(page.events.map((e) => e.summary)).toEqual(['三', '四'])
  })

  it('没过 7 天的不清,哪怕超过了条数 —— 以留得更多的为准', async () => {
    const log = new RecordingLog(await file(), () => new Date(), { days: 7, count: 2 })
    for (let i = 0; i < 5; i += 1) log.append(edit(String(i)))
    expect(log.since(undefined, 100).events).toHaveLength(5)
  })

  it('文件里写坏的行跳过,应用照样起得来', async () => {
    const path = await file()
    const log = new RecordingLog(path)
    log.append(edit('好的'))
    await log.flush()
    await writeFile(path, (await readFile(path, 'utf8')) + '{半截\n')

    const reloaded = new RecordingLog(path)
    await reloaded.load()
    expect(reloaded.since(undefined).events.map((e) => e.summary)).toEqual(['好的'])
  })

  it('lastFor 找这份稿子最近的一条', async () => {
    const log = new RecordingLog(await file())
    log.append(edit('一', 'a'))
    log.append({ ...edit('别的稿子', 'x'), document: { id: '/decks/other', label: 'other' } })
    expect(log.lastFor(doc.id)?.revision).toBe('a')
  })
})

describe('isoWithZone', () => {
  it('毫秒、带时区', () => {
    expect(isoWithZone(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/)
  })
})
