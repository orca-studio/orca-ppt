import { useEffect, useRef, useState } from 'react'
import type { PushData, RequestResult } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'
import { assetUrl } from './assets.js'

export type Theme = RequestResult<'catalog.list'>['themes'][number]
export type Recipe = RequestResult<'catalog.recipes'>['recipes'][number]
/** agent 在首页指着的同款:打开还是收起「做同款」。seq 每来一次请求加一。 */
export type RecipeFocus = PushData<'recipe.focus'> & { seq: number }

/**
 * 没有打开稿子时的首屏:**同款画廊**。看封面,点开样稿看它动起来,在卡片右上角复制
 * 「做同款」的提示词,贴进自己的 agent —— agent 读 skill 里的配方、照着做,做完在这里打开。
 * 案例(一整份完整的稿子)也排在这里,点开看,没有「做同款」。
 *
 * 封面是同款自带的图(frontmatter 的 `poster`),不在这里现录样片:以前悬停播样片,
 * 第一次打开要等二十多段样片在后台录完,首页一直是「正在生成」。
 *
 * 界面不从同款建稿:同款是配方,不是起始文件。通用的设计原则和审美(主题、配色、内容
 * 组织、逐页动效)内化在 skill 里,在 agent 侧用,不在这儿做成选择。
 * 打开已有的稿子走应用菜单。
 */
export interface GalleryProps {
  /** undefined:还在加载,什么都不画(否则 Cmd+R 会先闪一下空状态)。 */
  recipes: Recipe[] | undefined
  /** 点卡片:在工作台里打开这个同款的样稿(只读)。 */
  onPresent: (id: string) => void
  /** agent 指着的同款(show_recipe_prompt),和人点「做同款」效果一样。 */
  focus?: RecipeFocus | undefined
  /**
   * agent 正指着的那张卡(id):摆成和鼠标悬停一样 —— 「做同款」露出来。
   * 不然 Jevbot 的光标和高亮框指着一块空地,看的人不知道点的是什么。
   */
  pointed?: string | undefined
  /** 人自己的鼠标从那张卡上移开了:agent 指的那一下就算看完了。 */
  onUnpoint?: () => void
  error: string | undefined
}

export function Gallery({ recipes, onPresent, focus, pointed, onUnpoint, error }: GalleryProps) {
  return (
    <div className="gallery">
      {/* 不放标题:首页只有同款卡片,「做同款」卡片上已经写着。这一条只当窗口拖动区 */}
      <header aria-hidden="true" />

      <div className="gallery-body">
        {recipes === undefined ? null : recipes.length === 0 ? (
          <p className="gallery-empty">
            skill 里还没有同款。同款在 skill 的 <code>recipes/</code>{' '}
            目录下，写好之后重开首页就会出现。
          </p>
        ) : (
          <div className="gallery-grid gallery-grid--recipes">
            {recipes.map((item) => (
              <RecipeCard
                key={item.id}
                recipe={item}
                onPresent={() => onPresent(item.id)}
                // 指着别的卡也算一次「收起」:同一时间只指一张
                focus={
                  focus && { show: focus.id === item.id ? focus.show : 'none', seq: focus.seq }
                }
                pointed={pointed === item.id}
                onUnpoint={() => onUnpoint?.()}
              />
            ))}
          </div>
        )}
      </div>

      {error && <p className="gallery-error">{error}</p>}
    </div>
  )
}

/** 一张同款卡。案例也用它:少了「做同款」。 */
function RecipeCard({
  recipe,
  onPresent,
  focus,
  pointed,
  onUnpoint,
}: {
  recipe: Recipe
  onPresent: () => void
  focus: Pick<RecipeFocus, 'show' | 'seq'> | undefined
  /** agent 指着这张卡:和悬停一样。和真悬停分开记,人的鼠标不在这儿也成立。 */
  pointed: boolean
  onUnpoint: () => void
}) {
  const card = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)

  // agent 指过来:每来一次请求(seq)照做一次,人中途按 Esc 收起后再请求也能再打开
  useEffect(() => {
    if (!focus) return
    setOpen(focus.show === 'prompt')
    if (focus.show !== 'none')
      card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focus?.seq, focus?.show])

  const example = recipe.kind === 'example'

  return (
    <article
      ref={card}
      // 光标定位(visual_target)按 id 找这张卡
      data-recipe={recipe.id}
      data-pointed={pointed || undefined}
      className="gallery-recipe"
      onMouseLeave={() => {
        // 人自己摸过这张卡,agent 指的那一下就算看完了
        if (pointed) onUnpoint()
      }}
    >
      <div className="gallery-media">
        {/* 封面整块是打开样稿的按钮;「做同款」压在右上角,和它是兄弟不是子元素(按钮里不能套按钮) */}
        <button
          type="button"
          className="gallery-play"
          onClick={onPresent}
          // 不用 title:原生提示跟着鼠标,挡在封面上
          aria-label={`打开「${recipe.title}」的${example ? '案例' : '样稿'}`}
        >
          {recipe.poster ? (
            <img src={assetUrl(recipe.poster)} alt="" />
          ) : (
            // frontmatter 没写 poster(或者图不在):同款照样能点开看
            <span className="gallery-placeholder">没有封面，点开直接看</span>
          )}
        </button>
        {recipe.prompt && (
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
        )}
        {open && recipe.prompt && (
          <PromptMenu prompt={recipe.prompt} onClose={() => setOpen(false)} />
        )}
      </div>
      <span className="gallery-title gallery-title--center">
        {recipe.title}
        {/* 没有「做同款」的卡片要说清为什么:它是一整份稿子,不是手法 */}
        {example && <span className="gallery-kind">案例</span>}
      </span>
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
