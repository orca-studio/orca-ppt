import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { InspectAnchor } from '@orca-ppt/contracts'
import autoplayScript from './guest/autoplay.guest.js?raw'
import inspectScript from './guest/inspect.guest.js?raw'

/**
 * 放映画布。deck 跑在一个 Electron `<webview>` guest 里,不是 iframe ——
 * guest 能被主进程当独立对象管理,所以能注入检视脚本、拿元素几何、做裁切截图。
 * 检视正是本产品的核心交互,这个选择是为它做的(见 docs/ARCHITECTURE.md)。
 */

/** Electron 的 webview 标签。只列我们真正调的那几个。 */
interface WebviewElement extends HTMLElement {
  src: string
  executeJavaScript(code: string): Promise<unknown>
  reload(): void
  getWebContentsId(): number
}

/** guest 里算出来的锚,比契约多一个视口坐标 —— 宿主按它截图。 */
export interface PickedAnchor extends Omit<InspectAnchor, 'note'> {
  viewportBox: { x: number; y: number; w: number; h: number }
}

export interface StageHandle {
  /** 进入取锚状态。用户点下给出锚,Esc 取消给出 null。 */
  pick(): Promise<PickedAnchor | null>
  cancelPick(): void
  /** 自动播放:按每页的 data-hold 依次往后翻。 */
  autoplay(on: boolean): void
  /** guest 那边还在播吗。它会自己停(放完、或者人在画布里动手),得问它才知道。 */
  autoplayRunning(): Promise<boolean>
  /** 稿子变了,重载并回到原来那一页。 */
  reload(slide: number): void
  goto(slide: number): void
  /** guest 的 webContents id —— 主进程按它找到 guest 去截图。 */
  guestId(): number | undefined
}

export interface StageProps {
  previewUrl: string
  slideCount: number
  /** 重新挂载时回到这一页 —— 从看片台切回来不该跳回第一页。 */
  initialSlide: number
  onSlideChange: (index: number) => void
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { previewUrl, slideCount, initialSlide, onSlideChange },
  handle,
) {
  const ref = useRef<WebviewElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const restoreTo = useRef<number | undefined>(undefined)

  useEffect(() => {
    const view = ref.current
    if (!view) return

    const onLoad = () => {
      // 每次加载都要重新注入 —— 重载之后 guest 里什么都不剩。
      void view.executeJavaScript(`${inspectScript};${autoplayScript}`).then(() => {
        const slide = restoreTo.current ?? initialSlide
        restoreTo.current = undefined
        if (slide) void view.executeJavaScript(`Reveal.slide(${slide})`)
      })
      setReady(true)
      setError(undefined)
    }
    // 画布尺寸变化不用我们管:guest 收得到 resize,reveal 自己重算缩放比。
    // 试过加 ResizeObserver 主动调 Reveal.layout(),量下来是多余的,已经去掉。
    const onFail = (event: Event) => {
      const detail = event as Event & { errorDescription?: string }
      setError(detail.errorDescription || '加载失败')
    }
    view.addEventListener('dom-ready', onLoad)
    view.addEventListener('did-fail-load', onFail)
    return () => {
      view.removeEventListener('dom-ready', onLoad)
      view.removeEventListener('did-fail-load', onFail)
    }
    // initialSlide 只在挂载那次用得上,变了不该重装监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(
    handle,
    (): StageHandle => ({
      pick: async () => {
        const result = await ref.current?.executeJavaScript('window.__orcaInspect.arm()')
        return (result as PickedAnchor | null) ?? null
      },
      cancelPick: () => {
        void ref.current?.executeJavaScript('window.__orcaInspect.disarm()').catch(() => {})
      },
      autoplay: (on: boolean) => {
        void ref.current
          ?.executeJavaScript(`window.__orcaAutoplay?.${on ? 'start' : 'stop'}()`)
          .catch(() => {})
      },
      autoplayRunning: async () => {
        const running = await ref.current
          ?.executeJavaScript('!!window.__orcaAutoplay?.running()')
          .catch(() => false)
        return Boolean(running)
      },
      reload: (slide: number) => {
        restoreTo.current = slide
        ref.current?.reload()
      },
      goto: (slide: number) => {
        void ref.current?.executeJavaScript(`Reveal.slide(${slide})`).catch(() => {})
      },
      guestId: () => {
        try {
          return ref.current?.getWebContentsId()
        } catch {
          // guest 还没附着
          return undefined
        }
      },
    }),
    [],
  )

  /**
   * 翻页走 Reveal 自己的 API,而不是往 guest 里灌键盘事件。
   *
   * 理由:焦点可能在对话框或大纲上,这时候方向键根本进不了 guest;而且只有往后翻
   * 才播转场(往回翻是直接切),调 API 才能保证这个语义和用户在浏览器里按方向键一致。
   */
  useEffect(() => {
    if (!ready) return

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // 用户正在输入框里打字,方向键归输入框。
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      const call =
        event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' '
          ? 'Reveal.next()'
          : event.key === 'ArrowLeft' || event.key === 'PageUp'
            ? 'Reveal.prev()'
            : undefined
      if (!call) return

      event.preventDefault()
      // 人自己翻页就别再自动播了 —— 跟他抢翻页是最烦的。
      void ref.current
        ?.executeJavaScript(`window.__orcaAutoplay?.stop(); ${call}; Reveal.getIndices().h`)
        .then((index) => onSlideChange(Number(index)))
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ready, onSlideChange])

  return (
    <div className="stage">
      <div className="stage-canvas">
        <div className="stage-frame stage-frame--live">
          <webview
            ref={ref as unknown as React.Ref<HTMLWebViewElement>}
            src={previewUrl}
            // 独立持久 partition:deck 的存储和应用本身完全隔开。
            partition="persist:deck-preview"
          />
          {error && <div className="stage-error">{error}</div>}
        </div>
      </div>
      <div className="stage-meta">{slideCount} 页 · 方向键翻页</div>
    </div>
  )
})
