import { useState } from 'react'
import type { RequestResult } from '@orca-ppt/contracts'
import { ThemeButton } from './ThemeButton.js'

type Template = RequestResult<'catalog.templates'>['templates'][number]

/**
 * 没有打开稿子时的首屏:选个起头。
 *
 * 模板来自 skill —— 它已经有一整套能直接放映的成稿,没道理让人从空白开始。
 * 示例的缩略图也是 skill 自己生成的(`thumb.jpg`),不用我们再渲一轮。
 */
export interface GalleryProps {
  templates: Template[]
  busy: boolean
  error: string | undefined
  onCreate: (template: Template, title: string) => void
  onOpen: () => void
}

export function Gallery({ templates, busy, error, onCreate, onOpen }: GalleryProps) {
  const [picked, setPicked] = useState<Template | undefined>()
  const [title, setTitle] = useState('')

  const blanks = templates.filter((item) => item.kind === 'template')
  const examples = templates.filter((item) => item.kind === 'example')

  const create = () => {
    if (!picked) return
    // 没起名就用模板名,不拦着人往下走
    onCreate(picked, title.trim() || picked.title)
  }

  return (
    <div className="gallery">
      <header>
        <h1>新建演示稿</h1>
        <button type="button" onClick={onOpen}>
          打开已有的…
        </button>
        <ThemeButton />
      </header>

      {templates.length === 0 ? (
        <p className="gallery-empty">
          找不到 orca-ppt-skill —— 模板和示例都在它里面。装上之后重开一次。
        </p>
      ) : (
        <div className="gallery-body">
          <Section title="空白" hint="从头写起">
            {blanks.map((item) => (
              <Card key={item.id} item={item} picked={picked?.id === item.id} onPick={setPicked} />
            ))}
          </Section>

          <Section title="示例" hint="能直接放映的成稿,改成自己的">
            {examples.map((item) => (
              <Card key={item.id} item={item} picked={picked?.id === item.id} onPick={setPicked} />
            ))}
          </Section>
        </div>
      )}

      {picked && (
        <footer>
          <input
            value={title}
            placeholder={picked.title}
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

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2>
        {title}
        <em>{hint}</em>
      </h2>
      <div className="gallery-grid">{children}</div>
    </section>
  )
}

function Card({
  item,
  picked,
  onPick,
}: {
  item: Template
  picked: boolean
  onPick: (item: Template) => void
}) {
  return (
    <button type="button" data-picked={picked} onClick={() => onPick(item)}>
      {item.thumbnail ? (
        <img src={`file://${item.thumbnail}`} alt="" />
      ) : (
        <span className="gallery-blank" data-kind={item.kind}>
          {item.kind === 'template' ? '空白' : ''}
        </span>
      )}
      <span className="gallery-title">{item.title}</span>
    </button>
  )
}
