import type { Anchor, InspectAnchor } from '@orca-ppt/contracts'
import type { PickedAnchor } from './Stage.js'

/**
 * guest 算出来的锚 + 宿主截的图 → 一条能挂进待办队列的锚。
 *
 * guest 的 `viewportBox` 是给宿主截图用的,不进契约 —— agent 要的是 1920×1080 设计
 * 坐标,视口坐标对它没有意义,传过去只会让它对错位置。
 */
export function toAnchor(picked: PickedAnchor, note: string, crop?: string): Anchor {
  const { viewportBox: _viewportBox, ...rest } = picked
  const anchor: InspectAnchor = {
    ...rest,
    note,
    ...(crop ? { crop } : {}),
  }
  return { kind: 'element', ...anchor }
}

/** 裁切图在界面上预览用的地址。只在本机成立,不进协议。 */
export function cropUrl(crop: string | undefined): string | undefined {
  return crop ? `file://${crop}` : undefined
}
