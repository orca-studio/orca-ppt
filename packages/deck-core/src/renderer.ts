/**
 * 开一个浏览器把稿子渲出来的活:缩略图、导 PPTX。
 *
 * 谁来渲由运行形态决定:桌面版是 Electron 主进程的隐藏窗口,CLI 和 `orca-ppt serve` 是
 * playwright + 系统 Chrome。server 和 CLI 只认这个接口,不管背后是哪个浏览器
 * (见 docs/ARCHITECTURE.md「一个内核,三种形态」)。
 *
 * 「人此刻在画布上看到的那一页」不归这里 —— 那个只有界面答得了,`capture_slide` 照旧走界面。
 */
export interface ThumbnailJob {
  /** 稿子的预览地址(server 挂在 `/p/<token>/…` 下的那个)。 */
  previewUrl: string
  slideCount: number
  /** 只渲这几页(录制要的缩略图只要被改的那一页)。不给就是全部。 */
  slides?: number[]
  /** 输出宽度。不给就是页胶片用的 320。 */
  width?: number
  /** 写到哪个目录(缩略图缓存里的一格)。不给就由渲染方自己找个临时目录。 */
  outDir?: string
}

export interface PptxJob {
  previewUrl: string
  /** 写到哪。由调用方给,渲染方只认它自己的临时目录。 */
  outPath: string
}

export interface Renderer {
  /** 每页一张图的路径,顺序和要的页一致;某一页渲不出来那一格是 null。 */
  thumbnails(job: ThumbnailJob): Promise<Array<string | null>>
  /** 导好写到 `outPath`,返回导出报告。报告的形状由调用方按契约校验。 */
  exportPptx(job: PptxJob): Promise<unknown>
}

/**
 * 跨进程调 Renderer 的消息。桌面版的 server 跑在 utilityProcess 里,经 parentPort 找主进程渲,
 * 两头都按这个形状收发。
 */
export type RenderRequest =
  | { id: string; method: 'thumbnails'; job: ThumbnailJob }
  | { id: string; method: 'exportPptx'; job: PptxJob }

export interface RenderReply {
  id: string
  value?: unknown
  error?: string
}
