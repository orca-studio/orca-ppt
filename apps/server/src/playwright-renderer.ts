import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PptxJob, Renderer, ThumbnailJob } from '@orca-ppt/deck-core'
import { resolveSkillPath } from './skill.js'

/**
 * 不开桌面版时的渲染器:playwright 开系统里装好的 Chrome(没有就试 Edge),不下载浏览器。
 * `orca-ppt serve` 用它,以后 CLI 也用它(见 docs/ARCHITECTURE.md「一个内核,三种形态」)。
 *
 * playwright-core 和导出逻辑都从 skill 里取 —— skill 的 `capture.mjs` / `export-pptx.mjs`
 * 用的就是这一份,版本跟着 skill 走,不在产品里再装一份。
 *
 * 一次只渲一件事:几个任务抢同一个浏览器只会互相拖慢。浏览器第一次用时才开,之后一直留着。
 */

/** 缩略图的画布尺寸,和桌面版的隐藏窗口一样(按内容区 960×540)。 */
const THUMB_VIEW = { width: 960, height: 540 }
/** 可录制应用约定:单张不超过 300KB,PNG 太大就换 JPEG。 */
const MAX_PNG = 300_000

interface Page {
  goto(url: string): Promise<unknown>
  evaluate<T>(fn: string | ((arg: never) => T), arg?: unknown): Promise<T>
  screenshot(options: {
    type?: 'png' | 'jpeg'
    quality?: number
    clip?: { x: number; y: number; width: number; height: number }
    omitBackground?: boolean
  }): Promise<Buffer>
  close(): Promise<void>
}
interface Browser {
  newPage(options: {
    viewport: { width: number; height: number }
    deviceScaleFactor: number
  }): Promise<Page>
  close(): Promise<void>
}
interface Playwright {
  chromium: { launch(options: { channel: string }): Promise<Browser> }
}
interface ExportCore {
  VIEW: { width: number; height: number }
  exportDeck(page: {
    evaluate: (fn: (arg: never) => unknown, arg?: unknown) => Promise<unknown>
    screenshot: (input: {
      clip: { x: number; y: number; width: number; height: number }
      transparent?: boolean
    }) => Promise<Buffer>
  }): Promise<{ pptx: Buffer; report: unknown }>
}

export interface PlaywrightRenderer extends Renderer {
  close(): Promise<void>
}

export function playwrightRenderer(
  skillPath: () => Promise<string | undefined> = () => resolveSkillPath(),
): PlaywrightRenderer {
  let browser: Promise<Browser> | undefined
  let tail: Promise<unknown> = Promise.resolve()
  /** 排队:前一件做完(成败都算)再做下一件。 */
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }

  const skill = async () => {
    const path = await skillPath()
    if (!path) throw new Error('找不到 skill,渲不了稿子')
    return path
  }

  const open = () => {
    browser ??= (async () => {
      const playwright = (await import(
        pathToFileURL(join(await skill(), 'node_modules/playwright-core/index.mjs')).href
      )) as Playwright
      try {
        return await playwright.chromium.launch({ channel: 'chrome' })
      } catch {
        // Windows 上很多机器只有 Edge
        try {
          return await playwright.chromium.launch({ channel: 'msedge' })
        } catch {
          throw new Error('没找到系统里的 Chrome 或 Edge,渲不了缩略图、导不了 PPTX')
        }
      }
    })().catch((error: unknown) => {
      // 这次没开成,下次再试(比如人刚装好 Chrome)
      browser = undefined
      throw error
    })
    return browser
  }

  const thumbnails = async (job: ThumbnailJob): Promise<Array<string | null>> => {
    if (job.slideCount === 0) return []
    const width = job.width ?? 320
    const indices =
      job.slides?.filter((index) => index < job.slideCount) ??
      Array.from({ length: job.slideCount }, (_, index) => index)
    const page = await (
      await open()
    ).newPage({ viewport: THUMB_VIEW, deviceScaleFactor: width / THUMB_VIEW.width })
    try {
      await page.goto(`${job.previewUrl}?capture#/0`)
      const ready = await page.evaluate(`new Promise(resolve => {
        const check = () => {
          if (window.__capture?.go && window.__capture?.seek) return 'capture';
          if (window.Reveal?.isReady?.()) return 'reveal';
          return null;
        };
        const finish = value => { clearInterval(timer); clearTimeout(timeout); resolve(value); };
        const timer = setInterval(() => { const mode = check(); if (mode) finish(mode); }, 50);
        const timeout = setTimeout(() => finish(null), 8000);
      })`)
      if (!ready) throw new Error('稿子未就绪，无法生成缩略图')
      // 缩略图只要稿子内容;放映控件归看的人
      await page.evaluate(
        `window.Reveal?.configure({ controls: false, progress: false, slideNumber: false })`,
      )
      // 普通 Reveal 稿子没有录制接口:只在这个页面里关掉转场
      if (ready === 'reveal') {
        await page.evaluate(
          `Reveal.configure({ transition: 'none', backgroundTransition: 'none', autoAnimate: false, autoSlide: 0 })`,
        )
      }
      await page.evaluate('document.fonts.ready')

      const dir = job.outDir ?? join(tmpdir(), 'orca-ppt-thumbs', randomUUID().slice(0, 8))
      await mkdir(dir, { recursive: true })
      const paths: Array<string | null> = []
      for (const index of indices) {
        try {
          await page.evaluate(`(async () => {
            if (window.__capture?.go && window.__capture?.seek) {
              // 页内动画放完才是这一页完整的样子;老引擎没有 build,就停在转场结束
              const { transition, build } = await window.__capture.go(${index});
              await window.__capture.seek(transition + (build || 0));
            } else {
              Reveal.slide(${index});
              Reveal.getCurrentSlide().querySelectorAll('.fragment').forEach(el => el.classList.add('visible'));
            }
            const images = [...Reveal.getCurrentSlide().querySelectorAll('img')];
            await Promise.race([
              Promise.all(images.map(img => img.decode().catch(() => {}))),
              new Promise(resolve => setTimeout(resolve, 3000)),
            ]);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`)
          const png = await page.screenshot({ type: 'png' })
          const [file, bytes] =
            png.length > MAX_PNG
              ? [join(dir, `${index}.jpg`), await page.screenshot({ type: 'jpeg', quality: 85 })]
              : [join(dir, `${index}.png`), png]
          await writeFile(file, bytes)
          paths.push(file)
        } catch {
          // 某一页渲不出来不该毁掉整条 —— 那一格留空就是了
          paths.push(null)
        }
      }
      return paths
    } finally {
      await page.close().catch(() => {})
    }
  }

  const exportPptx = async (job: PptxJob): Promise<unknown> => {
    const core = (await import(
      pathToFileURL(join(await skill(), 'scripts/lib/pptx-export.mjs')).href
    )) as ExportCore
    const page = await (await open()).newPage({ viewport: core.VIEW, deviceScaleFactor: 1 })
    try {
      await page.goto(`${job.previewUrl}?capture#/0`)
      // 和 skill 的 export-pptx.mjs 一样把 page 交给同一份导出逻辑
      const { pptx, report } = await core.exportDeck({
        evaluate: (fn, arg) => page.evaluate(fn as (arg: never) => unknown, arg),
        screenshot: ({ clip, transparent }) =>
          page.screenshot({ clip, omitBackground: Boolean(transparent) }),
      })
      await writeFile(job.outPath, pptx)
      return report
    } finally {
      await page.close().catch(() => {})
    }
  }

  return {
    thumbnails: (job) => queued(() => thumbnails(job)),
    exportPptx: (job) => queued(() => exportPptx(job)),
    close: async () => {
      const opened = browser
      browser = undefined
      await (await opened?.catch(() => undefined))?.close().catch(() => {})
    },
  }
}
