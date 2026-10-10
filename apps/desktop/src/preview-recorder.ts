import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, type NativeImage } from 'electron'

/**
 * 把一份同款样稿录成一段 webm 样片,顺手截一张封面。
 *
 * 和缩略图同一条路:隐藏窗口里加载稿子(`?capture`),用稿子自己的录制接口
 * `__capture.go / seek` 逐帧定位再截图 —— 不靠真实时间,所以录出来是确定的,
 * 机器慢也不会录成慢动作。和 skill 的 `capture.mjs` 走的是同一套时序。
 *
 * 编码在另一个空白隐藏窗口里做:WebCodecs 的 `VideoEncoder`(VP9)按帧写时间戳,
 * `webm-muxer` 封装成文件。不依赖系统 Chrome 和 ffmpeg —— 发布版里这两样都不一定有。
 */
export interface PreviewJob {
  previewUrl: string
  outPath: string
  posterPath: string
  coverAt?: number | undefined
  /** 只录这几页(下标,含两头)。从 from 页的静止画面起,不录进入它的转场。 */
  range?: { from: number; to: number } | undefined
}

const FPS = 24
const WIDTH = 960
const HEIGHT = 540
/** 只录一段时,开头那页的静止画面停多久 —— 让人先看清「从哪页开始」,再看转场。 */
const LEAD_IN_US = 600_000
/** 停留帧不逐帧录:一张图挂这么久,中间补一个关键帧,拖进度条时不用从头解。 */
const HOLD_STEP_US = 500_000

/** 只认我们自己的缓存目录:路径是 server 给的,壳也守一道,不往别处写文件。 */
export function isPreviewPath(path: string): boolean {
  return /\.(webm|jpg)$/.test(path) && basename(dirname(dirname(path))) === 'recipe-previews'
}

export async function recordPreview(job: PreviewJob): Promise<void> {
  if (!isPreviewPath(job.outPath) || !isPreviewPath(job.posterPath)) {
    throw new Error('样片只能写进 recipe-previews 缓存目录')
  }

  const deck = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const encoder = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  })
  const timeout = setTimeout(() => {
    for (const window of [deck, encoder]) if (!window.isDestroyed()) window.destroy()
  }, 230_000)

  // 每一步都带上名字:executeJavaScript 抛出来的只有一句「Script failed to execute」
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw new Error(`录制样片失败(${name}):${error instanceof Error ? error.message : error}`)
    }
  }

  try {
    // WebCodecs 只在安全上下文里有:about:blank / data: 都不算,loopback 的 http 算。
    // 随便落在本地服务的一个地址上就行(404 页也是一个文档)。
    await step('打开编码窗口', () =>
      encoder.loadURL(`${new URL(job.previewUrl).origin}/orca-preview-encoder`),
    )
    await step('加载 webm-muxer', async () =>
      encoder.webContents.executeJavaScript(await muxerSource()),
    )
    await step('准备编码器', () => encoder.webContents.executeJavaScript(ENCODER))
    await step('配置编码器', () =>
      encoder.webContents.executeJavaScript(`__enc.start(${WIDTH}, ${HEIGHT}, ${FPS})`),
    )

    await step('打开样稿', () => deck.loadURL(`${job.previewUrl}?capture#/0`))
    const ready = await deck.webContents.executeJavaScript(
      `new Promise(resolve => {
        const t0 = Date.now()
        const tick = () => {
          if (window.__capture?.go && window.Reveal?.isReady?.()) return resolve(true)
          if (Date.now() - t0 > 10000) return resolve(false)
          setTimeout(tick, 50)
        }
        tick()
      })`,
    )
    if (!ready) throw new Error('样稿没有录制接口(不是 orca-ppt-skill 的稿子?)')
    await deck.webContents.executeJavaScript('document.fonts.ready.then(() => true)')

    const snap = async (): Promise<NativeImage> => {
      // seek 之后等两帧再截:和 capture.mjs 一样,不等的话偶尔拍到上一帧
      await deck.webContents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      )
      const image = await deck.webContents.capturePage()
      return image.resize({ width: WIDTH, height: HEIGHT })
    }
    const seek = (ms: number) => deck.webContents.executeJavaScript(`__capture.seek(${ms})`)

    let t = 0 // 微秒
    const covers: Array<{ t: number; jpeg: Buffer }> = []
    const add = async (image: NativeImage, durationUs: number, key: boolean) => {
      const jpeg = image.toJPEG(82)
      // 封面候选每半秒留一张,最后按 coverAt 挑最近的
      if (!covers.length || t - covers.at(-1)!.t >= 500_000) covers.push({ t, jpeg })
      await step(`编码第 ${Math.round(t / 1000)}ms`, () =>
        encoder.webContents.executeJavaScript(
          `__enc.add(${JSON.stringify(jpeg.toString('base64'))}, ${t}, ${durationUs}, ${key})`,
        ),
      )
      t += durationUs
    }

    const frameUs = Math.round(1_000_000 / FPS)
    const count: number = await deck.webContents.executeJavaScript('__capture.count()')
    const first = Math.min(job.range?.from ?? 0, count - 1)
    const lastPage = Math.min(job.range?.to ?? count - 1, count - 1)
    let last: NativeImage | undefined
    if (first > 0) {
      // 从中间起:直接定位到起始页,拨到转场终点(隔页跳时 auto-animate 也会动),停一小会儿
      await step(`定位第 ${first + 1} 页`, async () => {
        await deck.webContents.executeJavaScript(`__capture.go(${first})`)
        await seek(10_000_000)
      })
      last = await snap()
      await add(last, LEAD_IN_US, true)
    }
    for (let i = first > 0 ? first + 1 : 0; i <= lastPage; i++) {
      const page: { transition: number; hold: number; scene?: number; video?: number } = await step(
        `定位第 ${i + 1} 页`,
        () => deck.webContents.executeJavaScript(`__capture.go(${i})`),
      )
      const frames = Math.round((page.transition / 1000) * FPS)
      for (let f = 0; f < frames; f++) {
        await seek((f / FPS) * 1000)
        last = await snap()
        await add(last, frameUs, f === 0)
      }
      const holdFrames = Math.max(1, Math.round((page.hold / 1000) * FPS))
      if (page.scene || page.video) {
        // 停留期间画面还在动(场景动画、视频、回顾片尾):逐帧录
        for (let h = 0; h < holdFrames; h++) {
          await seek(page.transition + (h / FPS) * 1000)
          last = await snap()
          await add(last, frameUs, h === 0)
        }
      } else {
        await seek(page.transition)
        last = await snap()
        let left = holdFrames * frameUs
        while (left > 0) {
          const d = Math.min(left, HOLD_STEP_US)
          await add(last, d, true)
          left -= d
        }
      }
    }
    if (!last) throw new Error('样稿一页都没有')

    const webm: string = await step('封装 webm', () =>
      encoder.webContents.executeJavaScript('__enc.finish()'),
    )
    if (!webm) throw new Error('编码失败')
    const at = (job.coverAt ?? (t / 1_000_000) * 0.75) * 1_000_000
    const cover = covers.reduce((best, item) =>
      Math.abs(item.t - at) < Math.abs(best.t - at) ? item : best,
    )
    // 先写封面再写视频:server 以视频在不在判断「录好了」
    await writeFile(job.posterPath, cover.jpeg)
    await writeFile(job.outPath, Buffer.from(webm, 'base64'))
  } finally {
    clearTimeout(timeout)
    for (const window of [deck, encoder]) if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * webm-muxer 的 UMD 构建(全局 `WebMMuxer`)。发布版是 esbuild 打的单文件,没有
 * node_modules —— 打包时把它拷到 `vendor/`;开发时从 node_modules 解析。
 */
let muxer: string | undefined
async function muxerSource(): Promise<string> {
  if (muxer) return muxer
  const here = dirname(new URL(import.meta.url).pathname)
  const vendored = join(here, '../vendor/webm-muxer.js')
  muxer = await readFile(vendored, 'utf8').catch(() =>
    // 包的 exports 只放出入口,require 条件下入口就是这份 UMD 构建
    readFile(createRequire(import.meta.url).resolve('webm-muxer'), 'utf8'),
  )
  return muxer
}

/** 编码窗口里跑的那段。帧以 base64 JPEG 进来,时间戳和时长由主进程定。 */
const ENCODER = `
window.__enc = {
  start(width, height, fps) {
    this.error = null
    this.muxer = new WebMMuxer.Muxer({
      target: new WebMMuxer.ArrayBufferTarget(),
      video: { codec: 'V_VP9', width, height, frameRate: fps },
    })
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => { this.error = String(e) },
    })
    this.encoder.configure({ codec: 'vp09.00.10.08', width, height, bitrate: 1_200_000, framerate: fps })
    return true
  },
  async add(b64, timestamp, duration, keyFrame) {
    if (this.error) throw new Error(this.error)
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    const frame = new VideoFrame(bitmap, { timestamp, duration })
    this.encoder.encode(frame, { keyFrame })
    frame.close()
    bitmap.close()
    // 别让编码队列无限堆:主进程送得比编码快时在这儿等一下
    while (this.encoder.encodeQueueSize > 8) {
      await new Promise((r) => this.encoder.addEventListener('dequeue', r, { once: true }))
    }
    return true
  },
  async finish() {
    await this.encoder.flush()
    if (this.error) throw new Error(this.error)
    this.muxer.finalize()
    const bytes = new Uint8Array(this.muxer.target.buffer)
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(out)
  },
}
true
`
