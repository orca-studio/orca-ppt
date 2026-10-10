import { useEffect, useRef, useState } from 'react'
import type { RequestResult } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'
import { assetUrl } from './assets.js'

export type Theme = RequestResult<'catalog.list'>['themes'][number]
export type Recipe = RequestResult<'catalog.recipes'>['recipes'][number]

/**
 * 没有打开稿子时的首屏:**同款画廊**。看样片,在卡片右上角复制「做同款」的提示词,贴进
 * 自己的 agent —— agent 读 skill 里的配方、照着做,做完在这里打开。
 *
 * 界面不从同款建稿:同款是配方,不是起始文件。通用的设计原则和审美(主题、配色、内容
 * 组织、逐页动效)内化在 skill 里,在 agent 侧用,不在这儿做成选择。
 * 打开已有的稿子走应用菜单。
 */
export interface GalleryProps {
  recipes: Recipe[]
  /** 点卡片:在工作台里打开这个同款的样稿(只读)。 */
  onPresent: (id: string) => void
  error: string | undefined
}

export function Gallery({ recipes, onPresent, error }: GalleryProps) {
  return (
    <div className="gallery">
      {/* 不放标题:首页只有同款卡片,「做同款」卡片上已经写着。这一条只当窗口拖动区 */}
      <header aria-hidden="true" />

      <div className="gallery-body">
        {recipes.length === 0 ? (
          <p className="gallery-empty">
            skill 里还没有同款。同款在 skill 的 <code>recipes/</code>{' '}
            目录下，写好之后重开首页就会出现。
          </p>
        ) : (
          <div className="gallery-grid gallery-grid--recipes">
            {recipes.map((item) => (
              <RecipeCard key={item.id} recipe={item} onPresent={() => onPresent(item.id)} />
            ))}
          </div>
        )}
      </div>

      {error && <p className="gallery-error">{error}</p>}
    </div>
  )
}

/**
 * 样片悬停才播:一屏好几段视频同时放,既吵又费电。触屏没有悬停(点一下会误触发),
 * 用户开了减少动效也不自动播 —— 封面已经说明了这个同款长什么样。
 */
const canPreview = () =>
  matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !matchMedia('(prefers-reduced-motion: reduce)').matches

/** 一张同款卡。 */
function RecipeCard({ recipe, onPresent }: { recipe: Recipe; onPresent: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const el = video.current
    if (!el) return
    if (hover && canPreview()) {
      void el.play().catch(() => {})
      return
    }
    // 移开就回到封面:停在播到一半的那一帧,看着像卡住了。
    // load() 把元素重置到初始状态,poster 重新露出来,下次悬停从头播。
    if (!el.paused || el.currentTime > 0) {
      el.pause()
      el.load()
    }
    // 样片换了(缓存刚录好)也要重新判断:鼠标正停在卡片上时,新换上来的元素该接着播
  }, [hover, recipe.preview])

  return (
    <article
      className="gallery-recipe"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="gallery-media">
        {/* 样片区整块是打开样稿的按钮;「做同款」压在右上角,和它是兄弟不是子元素(按钮里不能套按钮) */}
        <button
          type="button"
          className="gallery-play"
          onClick={onPresent}
          // 不用 title:原生提示跟着鼠标,正好压在悬停预览上
          aria-label={`打开「${recipe.title}」的样稿`}
        >
          {recipe.preview ? (
            <video
              // 样片换了(缓存录好了新的一份)就整个换掉元素,不然还播着旧的
              key={recipe.preview}
              ref={video}
              src={assetUrl(recipe.preview)}
              poster={assetUrl(recipe.poster)}
              muted
              loop
              playsInline
              preload="metadata"
            />
          ) : recipe.poster ? (
            <img src={assetUrl(recipe.poster)} alt="" />
          ) : (
            <span className="gallery-placeholder">还没有样片</span>
          )}
        </button>
        <Button
          variant="primary"
          size="sm"
          className="gallery-copy"
          on={open}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          做同款
        </Button>
        {open && <PromptMenu prompt={recipe.prompt} onClose={() => setOpen(false)} />}
      </div>
      <span className="gallery-title gallery-title--center">{recipe.title}</span>
    </article>
  )
}

/**
 * 「做同款」下面挂的菜单:先看清要复制的是什么,再复制。提示词可能比菜单长,
 * 预览区自己滚动,复制按钮钉在底下不跟着滚走。
 *
 * 从按钮所在的右上角长出来(origin-aware),Esc 和点外面关掉。
 */
function PromptMenu({ prompt, onClose }: { prompt: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const copyButton = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    copyButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
    }
    // 点「做同款」本身由按钮的 onClick 收起,这里只管菜单和按钮之外
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if ((target as HTMLElement).closest?.('.gallery-copy')) return
      close.current()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => void navigator.clipboard.writeText(prompt).then(() => setCopied(true))

  return (
    <div ref={ref} className="gallery-prompt" role="dialog" aria-label="做同款提示词">
      <pre>{prompt}</pre>
      <footer>
        <Button ref={copyButton} variant="primary" size="sm" onClick={copy}>
          {/* 换 key 让新文字重新入场:很短的 blur + 淡入,读起来是一个按钮变了状态,不是两段字硬换 */}
          <span key={copied ? 'copied' : 'idle'} className="gallery-copy-label">
            {copied ? '已复制' : '复制'}
          </span>
        </Button>
      </footer>
    </div>
  )
}
