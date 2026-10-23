import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 旧版本的同款样片缓存。0.1.12 及以前,首页悬停要播样片,应用第一次打开时在隐藏窗口里把每个同款
 * 现录一段 webm,封面也从里面截。现在封面是同款自带的图(frontmatter 的 `poster`),不再录样片,
 * 这个目录留着只占地方:server 起来时清掉一次。
 */
export function oldPreviewDir(env = process.env): string {
  return env.ORCA_PPT_PREVIEW_DIR ?? join(homedir(), '.orca-ppt', 'recipe-previews')
}

export async function dropOldPreviews(env = process.env): Promise<void> {
  // 删不掉也不影响什么,下次启动再试
  await rm(oldPreviewDir(env), { recursive: true, force: true }).catch(() => {})
}
