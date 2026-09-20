import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { InspectAnchor } from '@orca-ppt/contracts'
import autoplayScript from './guest/autoplay.guest.js?raw'
import editScript from './guest/edit.guest.js?raw'
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
  /** 往后翻一页 —— 只有往后翻才播转场。 */
  next(): void
  /** guest 的 webContents id —— 主进程按它找到 guest 去截图。 */
  guestId(): number | undefined
  /**
   * 把某段文字所在的元素点亮一下。改完的**下一次加载完成后**才点 ——
   * 写盘会触发重载,这会儿点亮的是马上就要被换掉的那个 DOM。
   */
  spotlight(text: string): void
  /** 等画布加载完。重载途中截图会截到空白,得等它。 */
  whenReady(timeoutMs?: number): Promise<boolean>
  /** 这一页的情况:停留时长、参与转场的元素。只有画布答得出来。 */
  slideInfo(): Promise<SlideInfo | null>
}

/** 攒着的点亮过期时间。隔太久再闪一下,人根本对不上是哪次改动。 */
const SPOTLIGHT_TTL_MS = 8_000

/** 这一页在画布上的情况。右栏「页」那一档显示它。 */
export interface SlideInfo {
  index: number
  /** 停留多久(秒)。没写 `data-hold` 时是 null —— 如实报,不编一个默认值。 */
  hold: string | null
  /** 转场时长(秒)。没写时是 null。 */
  duration: string | null
  carries: Array<{ id: string; kind: string; text: string }>
}

/** guest 里改完的一处文字。服务端靠 `oldText` 在源码里定位,不靠选择器。 */
export interface TextEdit {
  slide: number
  oldText: string
  newText: string
}

export interface StageProps {
  previewUrl: string
  slideCount: number
  /** 自动播放是**放映方式**,归这儿 —— 工具栏放的是全局动作。 */
  autoplay: boolean
  onToggleAutoplay: () => void
  /** 重新挂载时回到这一页 —— 从看片台切回来不该跳回第一页。 */
  initialSlide: number
  onSlideChange: (index: number) => void
  /**
   * 人双击改完了一处文字。返回被拒的理由(没被拒就返回 undefined)——
   * 拒绝的理由要摆回他刚才双击的地方,不能默默吞掉。
   */
  onTextEdit: (edit: TextEdit) => Promise<string | undefined>
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { previewUrl, slideCount, initialSlide, autoplay, onToggleAutoplay, onSlideChange, onTextEdit },
  handle,
) {
  const ref = useRef<WebviewElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const restoreTo = useRef<number | undefined>(undefined)
  /** 等着点亮的那段文字 —— 攒到下一次加载完成。 */
  const pendingSpotlight = useRef<{ text: string; at: number } | undefined>(undefined)
  /**
   * 画布加载好了没有。**初值是「没好」** —— 初次挂载时 dom-ready 还没来过,
   * 给 false 的话刚打开稿子时问什么都答不上来(右栏会一直显示「画布还没加载」)。
   */
  const loading = useRef(true)
  const waiters = useRef<Array<() => void>>([])
  // 常驻回调,不进 effect 依赖 —— 注入和守候都只该在加载时发生一次。
  const onTextEditRef = useRef(onTextEdit)
  onTextEditRef.current = onTextEdit

  useEffect(() => {
    const view = ref.current
    if (!view) return

    /**
     * 守候就地编辑。一次只等一处:拿到就写盘,写完再等下一处 —— 两处改动挤在一起的话,
     * 服务端按旧文字定位就分不清先后了。
     *
     * 这一轮会在下一次加载时被 guest 那边的重复注入解掉(arm 的 Promise 解成 null)。
     */
    const watchEdits = () => {
      void view
        .executeJavaScript('window.__orcaEdit.arm()')
        .then(async (result) => {
          const edit = result as TextEdit | null
          if (!edit) return
          const reason = await onTextEditRef.current(edit)
          if (reason) {
            void view
              .executeJavaScript(`window.__orcaEdit.notify(${JSON.stringify(reason)})`)
              .catch(() => {})
          }
        })
        .then(watchEdits)
        // guest 没了就别再守了,不然重载时会空转。
        .catch(() => {})
    }

    const onStartLoading = () => {
      loading.current = true
    }

    const onLoad = () => {
      // 每次加载都要重新注入 —— 重载之后 guest 里什么都不剩。
      void view.executeJavaScript(`${inspectScript};${autoplayScript};${editScript}`).then(() => {
        const slide = restoreTo.current ?? initialSlide
        restoreTo.current = undefined
        if (slide) void view.executeJavaScript(`Reveal.slide(${slide})`)
        watchEdits()

        // 攒着的那处点亮,现在才有意义 —— DOM 是新的了。太旧的就算了,
        // 隔了半天再闪一下,人根本对不上是哪次改动。
        const wanted = pendingSpotlight.current
        pendingSpotlight.current = undefined
        if (wanted && Date.now() - wanted.at < SPOTLIGHT_TTL_MS) {
          void view
            .executeJavaScript(`window.__orcaEdit.spotlight(${JSON.stringify(wanted.text)})`)
            .catch(() => {})
        }
      })
      loading.current = false
      for (const resume of waiters.current.splice(0)) resume()
      setReady(true)
      setError(undefined)
    }
    // 画布尺寸变化不用我们管:guest 收得到 resize,reveal 自己重算缩放比。
    // 试过加 ResizeObserver 主动调 Reveal.layout(),量下来是多余的,已经去掉。
    const onFail = (event: Event) => {
      const detail = event as Event & { errorDescription?: string }
      setError(detail.errorDescription || '加载失败')
    }
    view.addEventListener('did-start-loading', onStartLoading)
    view.addEventListener('dom-ready', onLoad)
    view.addEventListener('did-fail-load', onFail)
    return () => {
      view.removeEventListener('did-start-loading', onStartLoading)
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
      next: () => {
        void ref.current
          ?.executeJavaScript('window.__orcaAutoplay?.stop(); Reveal.next()')
          .catch(() => {})
      },
      guestId: () => {
        try {
          return ref.current?.getWebContentsId()
        } catch {
          // guest 还没附着
          return undefined
        }
      },
      slideInfo: async () => {
        const result = await ref.current
          ?.executeJavaScript('window.__orcaInspect.slideInfo()')
          .catch(() => null)
        return (result as SlideInfo | null) ?? null
      },
      spotlight: (text: string) => {
        // 一律攒到下一次加载完成:改文字必然引发重载,现在点亮的是马上要被换掉的 DOM。
        pendingSpotlight.current = { text, at: Date.now() }
      },
      whenReady: (timeoutMs = 4_000) =>
        new Promise<boolean>((resolve) => {
          if (!loading.current) return resolve(true)
          const timer = setTimeout(() => {
            // 超时也照样往下走:截一张可能不完美的,好过让 agent 干等。
            waiters.current = waiters.current.filter((entry) => entry !== resume)
            resolve(false)
          }, timeoutMs)
          const resume = () => {
            clearTimeout(timer)
            resolve(true)
          }
          waiters.current.push(resume)
        }),
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
      <div className="stage-meta">
        <span>{slideCount} 页 · 方向键翻页 · 双击改字</span>
        <button type="button" data-on={autoplay} onClick={onToggleAutoplay}>
          {autoplay ? '自动播放中' : '自动播放'}
        </button>
      </div>
    </div>
  )
})
