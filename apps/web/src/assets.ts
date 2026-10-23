/**
 * 界面要显示的本地图片(缩略图、裁切图、示例自带的那张)走本地 server,不用 `file://`。
 *
 * 理由:dev 下界面是从 `http://localhost:5273` 加载的,而 Chromium **不允许 http 页面
 * 加载 `file://` 子资源** —— 图会全裂。打包版页面本身是 file:// 所以看不出来,这是个
 * 只在 dev 下发作的差异,最容易被当成"图没生成"。
 *
 * server 那头只放行两类:skill 目录里的,和它自己经手过的那几个文件(见 PreviewHost)。
 */
let origin = ''

/** 传输层连上哪个端口,图就从哪个端口取。 */
export function useAssetOrigin(serverUrl: string): void {
  origin = serverUrl.replace(/^ws/, 'http')
}

export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  // Windows 的 `C:\a\b.png` 写成 `/C:/a/b.png`,server 那头再去掉开头的 `/`(preview-host.ts)
  // 只认盘符开头的:macOS 的文件名里可以有 `\`
  const slashed = /^[A-Za-z]:[\\/]/.test(path) ? '/' + path.replace(/\\/g, '/') : path
  // 路径里可能有空格、中文、# —— 逐段编码,分隔符留着。
  const encoded = slashed.split('/').map(encodeURIComponent).join('/')
  return `${origin}/asset${encoded}`
}
