import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeckPhase, PendingRequest, RequestResult } from '@orca-pptcode/contracts'
import { cropUrl, toAnchor } from './anchors.js'
import { Pending } from './Pending.js'
import { PhaseRail } from './PhaseRail.js'
import { Stage, type StageHandle } from './Stage.js'
import { Transport, type TransportState } from './transport.js'

type OpenedDeck = RequestResult<'deck.open'>

export function App({ serverUrl }: { serverUrl: string }) {
  const transport = useRef<Transport>(undefined)
  const stage = useRef<StageHandle>(null)
  const slideRef = useRef(0)
  const deckRef = useRef<OpenedDeck | undefined>(undefined)

  const [state, setState] = useState<TransportState>('closed')
  const [deck, setDeck] = useState<OpenedDeck | undefined>()
  const [slide, setSlide] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [crops, setCrops] = useState<Map<string, string>>(new Map())
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState('')

  const openWith = useCallback(async (via: Transport, path: string) => {
    if (!path) return
    setError(undefined)
    try {
      const opened = await via.request('deck.open', { path })
      setDeck(opened)
      deckRef.current = opened
      setSlide(0)
      slideRef.current = 0
      setRequests((await via.request('requests.list', { deckId: opened.deck.id })).requests)
    } catch (cause) {
      setDeck(undefined)
      deckRef.current = undefined
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    const next = new Transport(serverUrl)
    transport.current = next
    next.onStateChange = setState
    next.connect()

    next.subscribe('requests.changed', (data) => setRequests(data.requests))

    next.subscribe('phase.changed', (data) => {
      setDeck((current) => {
        if (!current || current.deck.id !== data.deckId) return current
        const phases = current.phases.map((row) =>
          row.phase === data.phase
            ? { phase: data.phase, status: data.status, issues: data.issues }
            : row,
        )
        const merged = { ...current, phases }
        deckRef.current = merged
        return merged
      })
    })

    // 稿子在磁盘上变了 —— 不管是 agent 改的还是用户自己在编辑器里改的,画布都跟着走。
    next.subscribe('deck.changed', (data) => {
      setDeck((current) => {
        if (!current || current.deck.id !== data.deckId) return current
        const merged = {
          ...current,
          slides: data.slides,
          slideCount: data.slideCount,
          previewUrl: data.previewUrl,
        }
        deckRef.current = merged
        return merged
      })
      // previewUrl 没变就只是内容变了,重载即可;变了说明成品刚出现,Stage 会自己挂上。
      if (data.previewUrl === deckRef.current?.previewUrl) stage.current?.reload(slideRef.current)
    })

    // agent 要自己看一眼做出来的东西 —— 只有壳截得了图。
    next.subscribe('capture.request', (data) => {
      void (async () => {
        try {
          const path = await window.orca?.captureCanvas?.({ guestId: stage.current?.guestId() })
          await next.request('capture.result', {
            requestId: data.requestId,
            ...(path ? { path } : { error: '画布还没加载出来' }),
          })
        } catch (cause) {
          await next.request('capture.result', {
            requestId: data.requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    })

    // agent 说「你看第 4 页」,画布跟着跳。
    next.subscribe('deck.slide', (data) => {
      setSlide(data.index)
      slideRef.current = data.index
      stage.current?.goto(data.index)
    })

    const initial = window.orca?.initialDeck
    if (initial) void openWith(next, initial)
  }, [serverUrl, openWith])

  const open = useCallback(
    (path: string) => (transport.current ? openWith(transport.current, path) : undefined),
    [openWith],
  )

  /** 在画布上点一处,连同裁切图挂进待办队列。 */
  const pick = useCallback(async () => {
    const active = transport.current
    const current = deckRef.current
    if (!stage.current || !active || !current) return

    setPicking(true)
    try {
      const picked = await stage.current.pick()
      if (!picked) return

      // 界面不碰文件系统 —— 截图和落盘都在壳里,这儿只拿回一个路径。
      const crop = await window.orca?.captureAnchor?.({
        guestId: stage.current.guestId(),
        box: picked.viewportBox,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      })
      const added = await active.request('requests.add', {
        deckId: current.deck.id,
        kind: 'anchor',
        anchor: toAnchor(picked, note, crop),
      })
      const url = cropUrl(crop)
      if (url) setCrops((existing) => new Map(existing).set(added.id, url))
      setNote('')
    } finally {
      setPicking(false)
    }
  }, [note])

  /** 点「跑」不直接驱动谁 —— 挂进待办队列,等 agent 来拉。 */
  const requestPhase = useCallback((phase: DeckPhase) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    void active.request('requests.add', { deckId: current.deck.id, kind: 'phase', phase })
  }, [])

  const removeRequest = useCallback((id: string) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    void active.request('requests.remove', { deckId: current.deck.id, id })
  }, [])

  const goto = useCallback((index: number) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    // 走协议而不是直接驱动画布:跳页是一个协议方法,agent 也能调它。
    void active.request('deck.showSlide', { deckId: current.deck.id, index })
  }, [])

  const openArtifact = useCallback(async (phase: DeckPhase) => {
    const active = transport.current
    const current = deckRef.current
    if (!active || !current) return
    const { path } = await active.request('artifact.path', { deckId: current.deck.id, phase })
    void window.orca?.openFile?.(path)
  }, [])

  const onSlideChange = useCallback((index: number) => {
    setSlide(index)
    slideRef.current = index
  }, [])

  return (
    <div className="shell">
      <section className="pane">
        <header className="pane-head">大纲</header>
        <div className="pane-body">
          {deck && (
            <PhaseRail
              rows={deck.phases}
              onRun={requestPhase}
              onOpenArtifact={(phase) => void openArtifact(phase)}
            />
          )}
          {deck ? (
            <ol className="filmstrip">
              {Array.from({ length: deck.slideCount }, (_, index) => (
                <li key={index}>
                  <button type="button" data-current={index === slide} onClick={() => goto(index)}>
                    <span className="filmstrip-no">{index + 1}</span>
                    {deck.slides[index]?.subject ?? '—'}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <DeckPicker onPick={() => void pickDeck(open)} onPath={open} error={error} />
          )}
        </div>
      </section>

      <section className="pane">
        <header className="pane-head">{deck ? deck.deck.title : '放映'}</header>
        {deck?.previewUrl ? (
          <Stage
            ref={stage}
            previewUrl={deck.previewUrl}
            slideCount={deck.slideCount}
            onSlideChange={onSlideChange}
          />
        ) : (
          <div className="stage">
            <div className="stage-frame">
              {deck
                ? '成品还没出来 —— 把阶段跑到「出稿」,它会在这里放映。'
                : '打开一个 deck 目录,它会在这里放映。'}
            </div>
          </div>
        )}
        <footer className="status">
          <span className="dot" data-off={state !== 'open'}>
            ●
          </span>
          <span>{state}</span>
          {deck && (
            <span>
              第 {slide + 1} / {deck.slideCount} 页
            </span>
          )}
        </footer>
      </section>

      <section className="pane">
        <header className="pane-head">待办</header>
        {deck ? (
          <div className="queue">
            <div className="queue-pick">
              <input
                value={note}
                placeholder="想说什么(可以空着)"
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="pick"
                data-picking={picking}
                onClick={() => {
                  if (!picking) return void pick()
                  stage.current?.cancelPick()
                  setPicking(false)
                }}
                disabled={!deck.previewUrl}
              >
                {picking ? '点画布上的元素,Esc 取消' : '在画布上点一处'}
              </button>
            </div>
            <Pending
              requests={requests}
              crops={crops}
              mcpUrl={serverUrl.replace(/^ws:/, 'http:') + '/mcp'}
              onRemove={removeRequest}
            />
          </div>
        ) : (
          <div className="pane-body">先打开一份 deck。</div>
        )}
      </section>
    </div>
  )
}

async function pickDeck(open: (path: string) => unknown): Promise<void> {
  // 界面不碰文件系统 —— 壳弹目录选择器,只把路径交回来。
  const path = await window.orca?.pickDeck?.()
  if (path) open(path)
}

function DeckPicker({
  onPick,
  onPath,
  error,
}: {
  onPick: () => void
  onPath: (path: string) => void
  error?: string | undefined
}) {
  const [path, setPath] = useState('')
  const canPick = Boolean(window.orca?.pickDeck)

  return (
    <div className="picker">
      {canPick ? (
        <button type="button" className="picker-button" onClick={onPick}>
          打开 deck 目录…
        </button>
      ) : (
        // 浏览器里跑 `pnpm dev` 时没有壳,直接贴路径。
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onPath(path)
          }}
        >
          <input
            value={path}
            placeholder="deck 目录的绝对路径"
            onChange={(event) => setPath(event.target.value)}
          />
        </form>
      )}
      <p className="muted">
        认 <code>deck.html</code> 和 <code>index.html</code>,skill 做出来的稿子直接能开。
      </p>
      {error && <p className="picker-error">{error}</p>}
    </div>
  )
}
