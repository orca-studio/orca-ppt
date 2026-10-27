import { Brief, Slide, Transition } from '@orca-ppt/contracts'
import { z } from 'zod'
import { readEditFile, type FileChanges } from './edit-files.js'
import { editPages, type PageChange } from '@orca-ppt/deck-core'

export async function pageMetadata(
  root: string,
  edit: ReturnType<typeof editPages>,
  change: PageChange,
): Promise<FileChanges> {
  const changes: FileChanges = {}
  const save = (name: string, before: string, value: unknown) => {
    changes[name] = { before, after: JSON.stringify(value, null, 2) + '\n' }
  }
  for (const name of ['.deck/brief.json', '.deck/outline.json', '.deck/plan.json']) {
    const before = await readEditFile(root, name)
    if (before === null) continue
    const json = JSON.parse(before) as Record<string, unknown>
    if (name.endsWith('brief.json')) {
      Brief.parse(json)
      save(name, before, { ...json, slideCount: edit.order.length })
    } else if (name.endsWith('outline.json')) {
      const slides = z.array(Slide.passthrough()).parse(json.slides)
      const oldCount =
        edit.order.length + (change.action === 'delete' ? 1 : change.action === 'insert' ? -1 : 0)
      if (slides.length !== oldCount || slides.some((slide, index) => slide.index !== index))
        throw new Error('大纲和成稿页序不一致，请先同步大纲')
      save(name, before, {
        ...json,
        slides: edit.order.map((oldIndex, index) =>
          oldIndex === null
            ? {
                index,
                subject: change.action === 'insert' ? change.title : '',
                layout: '',
                points: [],
                layoutReason: '',
              }
            : { ...slides[oldIndex]!, index },
        ),
      })
    } else {
      const transitions = z.array(Transition.passthrough()).parse(json.transitions)
      save(name, before, {
        ...json,
        transitions: transitions.flatMap((transition) => {
          const pair = edit.remap(transition.from, transition.to)
          return pair ? [{ ...transition, from: pair[0], to: pair[1] }] : []
        }),
      })
    }
  }
  return changes
}
