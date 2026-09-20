import { useMemo, useState } from 'react'
import type { RequestResult } from '@orca-ppt/contracts'
import { assetUrl } from './assets.js'
import { facetsOf, withTag, type Template } from './facets.js'

export type Theme = RequestResult<'catalog.list'>['themes'][number]

/**
 * 没有打开稿子时的首屏:选个起头。
 *
 * **先选主题,不是先选示例。** 主题就是场景 —— 用这个产品的人都带着自己的场合来:
 * 年度复盘、对外路演、内部分享。所以主题卡上写的是「它适合什么场合」,不只是长什么样。
 *
 * 五张主题样张的**内容完全一样**,只有设计不同(skill 的 scripts/theme-samples.mjs
 * 生成)。内容各不相同的话人只能一份份浏览,没法把几个摆在一起比。
 *
 * 示例收在下面:它们是「别人怎么用的」,是参考,不是起点 —— 从一份别人的成稿开始改,
 * 改到后来常常还是别人的稿子。
 */
export interface GalleryProps {
  themes: Theme[]
  templates: Template[]
  busy: boolean
  error: string | undefined
  /** 从空白起始文件 + 一个主题新建。 */
  onCreate: (template: Template, title: string, theme?: string) => void
  onOpen: () => void
}

/**
 * 模式。这个轴恰好互斥(两个起始文件),所以做成一个下拉 —— 互斥不等于它是分类:
 * 它只是这个轴上恰好只有一个值。页型(Bento、时间线)是叠加的,走另一条路。
 */
const MODES: Array<{ key: string; title: string; hint: string }> = [
  { key: 'standard', title: '汇报稿', hint: '工作汇报、产品介绍、数据复盘' },
  { key: 'story', title: '故事稿', hint: '一页一张照片,讲演变' },
]

/** 主题里想提到最前的标签。「最近使用」是派生的 —— 下次挑哪个,最强的预测是上次挑了哪个。 */
const THEME_ORDER = ['最近使用']

export function Gallery({ themes, templates, busy, error, onCreate, onOpen }: GalleryProps) {
  const [mode, setMode] = useState('standard')
  const [theme, setTheme] = useState<string | undefined>()
  const [example, setExample] = useState<Template | undefined>()
  const [title, setTitle] = useState('')
  const [browsing, setBrowsing] = useState(false)

  // **没样张的主题不显示** —— 一张白卡片,人看不出自己在挑什么。新主题做好样张自然出现。
  const shown = useMemo(() => themes.filter((item) => item.sample), [themes])

  /**
   * 主题按「最近使用」提到最前,其余按原顺序 —— 这一个派生标签就够了。五个主题不需要
   * 筛选条:五个东西摆成一排就够,套一层分类是虚胖。
   */
  const ordered = useMemo(() => {
    const recent = withTag(shown, 'use', '最近使用')
    return [...recent, ...shown.filter((item) => !recent.includes(item))]
  }, [shown])

  // 示例按**页型**铺开:一份稿子有几种页型就出现几次。这是分面,不是分类。
  const examples = useMemo(() => templates.filter((item) => item.kind === 'example'), [templates])
  const pageFacets = useMemo(() => facetsOf(examples, 'page'), [examples])
  const untagged = useMemo(() => examples.filter((item) => item.tags.page.length === 0), [examples])

  const blank = templates.find((item) => item.kind === 'template' && item.tags.mode.includes(mode))
  const picked = example ?? (theme ? blank : undefined)
  const pickedName = example?.title ?? themes.find((t) => t.name === theme)?.title ?? ''

  const create = () => {
    if (!picked) return
    // 没起名就用选中的那个名字,不拦着人往下走
    onCreate(picked, title.trim() || pickedName, example ? undefined : theme)
  }

  if (themes.length === 0 && templates.length === 0) {
    return (
      <div className="gallery">
        <header>
          <h1>新建演示稿</h1>
          <button type="button" onClick={onOpen}>
            打开已有的…
          </button>
        </header>
        <p className="gallery-empty">
          找不到 orca-ppt-skill —— 主题和示例都在它里面。装上之后重开一次。
        </p>
      </div>
    )
  }

  return (
    <div className="gallery">
      <header>
        <h1>选取主题</h1>
        <div className="gallery-head-right">
          {/* 版式是第二个、很小的选择:它决定稿子的结构,不决定长什么样。 */}
          <select
            className="gallery-layout"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            aria-label="模式"
          >
            {MODES.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={onOpen}>
            打开已有的…
          </button>
        </div>
      </header>

      <div className="gallery-body">
        <p className="gallery-note">{MODES.find((item) => item.key === mode)?.hint}</p>

        <div className="gallery-grid gallery-grid--themes">
          {ordered.map((item) => (
            <button
              key={item.name}
              type="button"
              data-picked={theme === item.name && !example}
              onClick={() => {
                setTheme(item.name)
                setExample(undefined)
              }}
            >
              <img src={assetUrl(item.sample)} alt="" />
              <span className="gallery-title">{item.title}</span>
              {/*
                场景在前、风格在后,两组分开摆。它们是标签不是一句话 —— 主题多起来
                之后同一个标签会横跨好几个主题(「高对比」「衬线」现在就是),那时候
                这排字直接变成筛选条,不用回头改数据。
              */}
              {/* 派生标签摆在最前,和声明的标签一视同仁 —— 它们是同一套东西。 */}
              {item.tags.use.length > 0 && (
                <span className="gallery-use">{item.tags.use.join(' · ')}</span>
              )}
              {item.tags.scene.length > 0 && (
                <span className="gallery-scene">{item.tags.scene.join(' · ')}</span>
              )}
              {item.tags.style.length > 0 && (
                <span className="gallery-style">{item.tags.style.join(' · ')}</span>
              )}
            </button>
          ))}
        </div>

        {examples.length > 0 && (
          <details className="gallery-examples" open={browsing}>
            <summary onClick={() => setBrowsing((on) => !on)}>
              示例
              <em>看看别人怎么用的</em>
            </summary>
            {/*
              按页型铺开,一份稿子有几种页型就出现几次 —— 这是**分面**不是分类。
              没标页型的收在最后一组,不丢也不硬塞进某一类。
            */}
            {[
              ...pageFacets,
              ...(untagged.length > 0 ? [{ value: '其他', items: untagged }] : []),
            ].map((facet) => (
              <section key={facet.value}>
                <h2>{facet.value}</h2>
                <div className="gallery-grid">
                  {facet.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-picked={example?.id === item.id}
                      onClick={() => {
                        setExample(item)
                        setTheme(undefined)
                      }}
                    >
                      <img src={assetUrl(item.thumbnail)} alt="" />
                      <span className="gallery-title">{item.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </details>
        )}
      </div>

      {picked && (
        <footer>
          <input
            value={title}
            placeholder={pickedName}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && create()}
          />
          <button type="button" className="gallery-create" disabled={busy} onClick={create}>
            {busy ? '建着…' : '创建'}
          </button>
        </footer>
      )}

      {error && <p className="gallery-error">{error}</p>}
    </div>
  )
}
