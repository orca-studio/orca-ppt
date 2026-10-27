/**
 * 不开桌面版时把稿子渲出来:playwright 开系统里的 Chrome。`orca-ppt serve` 和 CLI 共用。
 * 起进程,所以不放在 deck-core 里(那边只吃路径、只返回值)。
 */
export * from './playwright-renderer.js'
