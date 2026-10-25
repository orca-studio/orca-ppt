// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  elementTargetId,
  place,
  resolveControl,
  resolveTargets,
  stageQueryOf,
  type Screen,
} from './ui-targets.js'

/** jsdom 不排版,矩形得自己给。 */
function box(element: Element, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      x: left,
      y: top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }) as DOMRect
}

const screen: Screen = { bounds: { x: 100, y: 50, width: 1200, height: 800, zoom: 2 } }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('studio.orca/ui-targets:界面这一侧', () => {
  it('回执给的元素 targetId 原样当 controlId 能再查回同一处', () => {
    const id = elementTargetId(3, 'section > p:nth-of-type(2)')
    expect(stageQueryOf({ controlId: id })).toEqual({
      slide: 3,
      selector: 'section > p:nth-of-type(2)',
    })
    expect(stageQueryOf({ slide: 1, text: '1970' })).toEqual({ slide: 1, text: '1970' })
    expect(stageQueryOf({ controlId: 'canvas' })).toBeUndefined()
  })

  it('控件按 data-ui-target 认:没有、重名、可见各自答对', () => {
    document.body.innerHTML = `
      <button data-ui-target="history.undo"></button>
      <i data-ui-target="dup"></i><i data-ui-target="dup"></i>`
    box(document.querySelector('[data-ui-target="history.undo"]')!, 10, 20, 30, 40)
    expect(resolveControl({ controlId: 'nope' }).status).toBe('not_found')
    expect(resolveControl({ controlId: 'dup' }).status).toBe('ambiguous')
    expect(resolveControl({ controlId: 'history.undo' })).toMatchObject({
      status: 'visible',
      targetId: 'history.undo',
      rect: { x: 10, y: 20, width: 30, height: 40 },
    })
  })

  it('滚出页胶片的缩略图不算可见,露一半就给露出的那一半', () => {
    document.body.innerHTML = `
      <ol style="overflow: auto">
        <li><button data-ui-target="filmstrip.slide.0"></button></li>
        <li><button data-ui-target="filmstrip.slide.9"></button></li>
      </ol>`
    box(document.querySelector('ol')!, 0, 100, 200, 300)
    box(document.querySelector('[data-ui-target="filmstrip.slide.0"]')!, 10, 380, 100, 60)
    box(document.querySelector('[data-ui-target="filmstrip.slide.9"]')!, 10, 900, 100, 60)
    expect(resolveControl({ controlId: 'filmstrip.slide.9' }).status).toBe('not_visible')
    expect(resolveControl({ controlId: 'filmstrip.slide.0' }).rect).toEqual({
      x: 10,
      y: 380,
      width: 100,
      height: 20,
    })
  })

  it('换成屏幕点要算上窗口位置和缩放;窗口量不到就不编矩形', () => {
    const visible = {
      query: { controlId: 'canvas' },
      status: 'visible' as const,
      rect: { x: 10, y: 20, width: 30, height: 40 },
    }
    expect(place(visible, screen)).toEqual({
      ...visible,
      window: { id: 'workbench', bounds: { x: 100, y: 50, width: 1200, height: 800 } },
      rect: { x: 120, y: 90, width: 60, height: 80 },
    })
    const hidden = place(visible, undefined)
    expect(hidden.status).toBe('not_visible')
    expect(hidden.rect).toBeUndefined()
  })

  it('一批里画布上的和控件混着查,答案按查询的顺序', async () => {
    document.body.innerHTML = '<div data-ui-target="canvas"></div>'
    box(document.querySelector('div')!, 0, 0, 640, 360)
    const result = await resolveTargets(
      [{ slide: 2, text: '1970' }, { controlId: 'canvas' }, { slide: 0, selector: '#x' }],
      async (queries) => {
        expect(queries).toEqual([
          { slide: 2, text: '1970' },
          { slide: 0, selector: '#x' },
        ])
        return [
          { status: 'visible', selector: 'p', rect: { x: 1, y: 2, width: 3, height: 4 } },
          { status: 'not_visible', selector: '#x', reason: 'slide_not_shown' },
        ]
      },
      screen,
    )
    expect(result.coordinateSpace).toBe('screen_points_top_left')
    expect(result.targets.map((t) => t.status)).toEqual(['visible', 'visible', 'not_visible'])
    expect(result.targets[0]!.targetId).toBe(elementTargetId(2, 'p'))
    expect(result.targets[2]).not.toHaveProperty('rect')
    expect(result.targets[2]!.reason).toBe('slide_not_shown')
  })
})
