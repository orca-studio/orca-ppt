import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { PptxExportReport, RequestResult } from '@orca-ppt/contracts'
import type { z } from 'zod'

/**
 * 导出 PPTX 在 server 这边的两件事:目标路径对不对,壳交回来的报告怎么说给人听。
 * 量页面、拼包在 skill 的导出器里,由壳跑(apps/desktop/src/pptx-exporter.ts)。
 */

/** 壳先写到这里,server 再挪到用户要的位置 —— 壳只往这个目录写。 */
export function pptxExportDir(env = process.env): string {
  return env.ORCA_PPT_PPTX_DIR ?? join(homedir(), '.orca-ppt', 'pptx-exports')
}

/** 目标路径不对就说清哪里不对。返回 undefined 表示可以写。 */
export async function pptxTargetProblem(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return `要绝对路径:${path}`
  if (extname(path).toLowerCase() !== '.pptx') return `要以 .pptx 结尾:${path}`
  const dir = await stat(dirname(path)).catch(() => undefined)
  if (!dir?.isDirectory()) return `目录不存在:${dirname(path)}`
  const existing = await stat(path).catch(() => undefined)
  if (existing && !existing.isFile()) return `这个位置不是文件:${path}`
  return undefined
}

export function summarizePptx(
  path: string,
  report: z.infer<typeof PptxExportReport>,
): RequestResult<'deck.exportPptx'> {
  return {
    path,
    slides: report.slides.length,
    degraded: report.degraded,
    lost: report.slides
      .filter((slide) => slide.lost.length)
      .map((slide) => ({ slide: slide.index, items: slide.lost })),
    rasters: report.slides.reduce((sum, slide) => sum + slide.rasters.length, 0),
    fonts: report.fonts,
  }
}
