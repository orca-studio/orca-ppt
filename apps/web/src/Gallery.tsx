import { useMemo, useState } from 'react'
import type { RequestResult } from '@orca-ppt/contracts'
import { assetUrl } from './assets.js'
import { sectionsOf } from './facets.js'

export type Theme = RequestResult<'catalog.list'>['themes'][number]
export type Template = RequestResult<'catalog.templates'>['templates'][number]

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
  /** 最近用过的主题(文件名),最近的在前。**不是标签** —— 系统算出来的一个视图。 */
  recent: string[]
  /** 标签 id → 显示名。词表在 skill 里,界面只负责显示 label。 */
  tagLabel: (id: string) => string
  templates: Template[]
  busy: boolean
  error: string | undefined
  /** 从空白起始文件 + 一个主题新建。 */
  onCreate: (template: Template, title: string, theme: string) => void
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

export function Gallery({
  themes,
  recent,
  tagLabel,
  templates,
  busy,
  error,
  onCreate,
  onOpen,
}: GalleryProps) {
  const [mode, setMode] = useState('standard')
  const [theme, setTheme] = useState<string | undefined>()
  const [title, setTitle] = useState('')

  // **没样张的主题不显示** —— 一张白卡片,人看不出自己在挑什么。新主题做好样张自然出现。
  const shown = useMemo(() => themes.filter((item) => item.sample), [themes])

  const themeSections = useMemo(
    () =>
      sectionsOf(shown, {
        // 「最近使用」排最前,而且**不从 tags 里读** —— 它不是标签。
        derived: [
          {
            title: '最近使用',
            items: recent
              .map((name) => shown.find((item) => item.name === name))
              .filter((item): item is Theme => item !== undefined),
          },
        ],
        fallback: '全部主题',
        label: tagLabel,
      }),
    [shown, recent, tagLabel],
  )

  const blank = templates.find((item) => item.mode === mode)
  const picked = theme ? blank : undefined
  const pickedName = themes.find((item) => item.name === theme)?.title ?? ''

  const create = () => {
    if (!picked) return
    // 没起名就用选中的那个名字,不拦着人往下走
    if (!theme) return
    onCreate(picked, title.trim() || pickedName, theme)
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

        {themeSections.map((section) => (
          <section key={section.title} className="gallery-themes">
            <h2>{section.title}</h2>
            <div className="gallery-grid gallery-grid--themes">
              {section.items.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  data-picked={theme === item.name}
                  onClick={() => setTheme(item.name)}
                >
                  <img src={assetUrl(item.sample)} alt="" />
                  <span className="gallery-title">{item.title}</span>
                  {item.summary && <span className="gallery-scene">{item.summary}</span>}
                  {item.tags.length > 0 && (
                    <span className="gallery-style">{item.tags.map(tagLabel).join(' · ')}</span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}
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
