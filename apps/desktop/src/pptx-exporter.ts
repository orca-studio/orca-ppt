import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

/**
 * 把一份稿子导出成 PPTX。
 *
 * 量页面、截图、拼包都在 skill 的 `scripts/lib/pptx-export.mjs` 里 —— 命令行的
 * `export-pptx.mjs` 用的是同一份,只是浏览器换成了这里的隐藏窗口:不依赖系统 Chrome,
 * 发布版里不一定有。截图走 Chromium 的调试协议(CDP),透明底和 playwright 的
 * `omitBackground` 是同一个做法。
 *
 * 写到哪由 server 定(应用数据目录里的一个临时文件),导出器自己再守一道只写那个目录;
 * 挪到用户选的位置是 server 的事。
 */
export interface PptxJob {
  previewUrl: string
  outPath: string
}

const VIEW = { width: 5760, height: 3240 }

/** 只认我们自己的临时目录:路径是 server 给的,壳也守一道,不往别处写文件。 */
export function isPptxPath(path: string): boolean {
  return /\.pptx$/.test(path) && basename(dirname(path)) === 'pptx-exports'
}

/** 和 server 找 skill 是同一个顺序(apps/server/src/skill.ts),只是壳这边只认前三个位置。 */
function skillDir(): string {
  if (process.env.ORCA_PPT_SKILL) return process.env.ORCA_PPT_SKILL
  if (app.isPackaged) return join(process.resourcesPath, 'skill')
  return fileURLToPath(new URL('../../../skills/orca-ppt', import.meta.url))
}

interface Page {
  evaluate: (fn: (arg: never) => unknown, arg?: unknown) => Promise<unknown>
  screenshot: (input: {
    clip: { x: number; y: number; width: number; height: number }
    transparent?: boolean
  }) => Promise<Buffer>
}
interface ExportCore {
  exportDeck: (page: Page) => Promise<{ pptx: Buffer; report: unknown }>
}

export async function exportPptx(job: PptxJob): Promise<unknown> {
  if (!isPptxPath(job.outPath)) throw new Error('PPTX 只能写进 pptx-exports 临时目录')
  const core = (await import(
    pathToFileURL(join(skillDir(), 'scripts/lib/pptx-export.mjs')).href
  )) as ExportCore

  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    webPreferences: {
      // 离屏渲染不挂在哪块屏幕上,按 sRGB 画。普通隐藏窗口跟着屏幕走(Mac 上是 Display P3),
      // 截出来的图颜色和 PowerPoint 原生形状(按 sRGB 写)对不上
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  const timeout = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy()
  }, 290_000)
  const cdp = window.webContents.debugger
  try {
    cdp.attach('1.3')
    const send = (method: string, params?: object) => cdp.sendCommand(method, params)
    await window.loadURL(`${job.previewUrl}?capture#/0`)
    // 视口比画布大一圈:出画的元素也要截得到。窗口本身不用这么大。
    // 要在页面加载之后设:加载之前设,Electron 主进程直接崩(Electron 43 实测)
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width,
      height: VIEW.height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const page: Page = {
      // 用 CDP 跑而不是 executeJavaScript:后者出错只有一句「Script failed to execute」
      evaluate: async (fn, arg) => {
        const result = (await send('Runtime.evaluate', {
          expression: `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
          awaitPromise: true,
          returnByValue: true,
        })) as {
          result: { value?: unknown }
          exceptionDetails?: { exception?: { description?: string }; text: string }
        }
        if (result.exceptionDetails) {
          const { exception, text } = result.exceptionDetails
          throw new Error(exception?.description ?? text)
        }
        return result.result.value
      },
      screenshot: async ({ clip, transparent }) => {
        if (transparent) {
          await send('Emulation.setDefaultBackgroundColorOverride', {
            color: { r: 0, g: 0, b: 0, a: 0 },
          })
        }
        try {
          const shot = (await send('Page.captureScreenshot', {
            format: 'png',
            clip: { ...clip, scale: 1 },
          })) as { data: string }
          return Buffer.from(shot.data, 'base64')
        } finally {
          if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', {})
        }
      },
    }

    const { pptx, report } = await core.exportDeck(page)
    await writeFile(job.outPath, pptx)
    return report
  } finally {
    clearTimeout(timeout)
    if (!window.isDestroyed()) {
      if (cdp.isAttached()) cdp.detach()
      window.destroy()
    }
  }
}
