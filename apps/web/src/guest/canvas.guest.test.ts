// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import inspectSource from './inspect.guest.js?raw'
import source from './canvas.guest.js?raw'
import { CanvasEvidence } from '@orca-ppt/contracts'

const canvas = () => (window as any).__orcaCanvas
let index: number
beforeEach(() => {
  canvas()?.dispose()
  index = 0
  document.body.innerHTML =
    '<div class="slides"><section><h2 id="title">Title</h2><img src="chart.png" /><p style="display:none">Hidden</p></section><section><h2>Other</h2></section></div>'
  window.Reveal = {
    getIndices: () => ({ h: index }),
    getCurrentSlide: () => document.querySelectorAll('section')[index],
    getScale: () => 0.5,
    getConfig: () => ({ width: 1920, height: 1080 }),
    isReady: () => true,
  }
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    { serverTiming: [{ name: 'orca-revision', description: 'r1' }] },
  ] as any)
  for (const element of document.querySelectorAll('*')) {
    element.getBoundingClientRect = () => ({ x: 100, y: 50, width: 100, height: 20 }) as DOMRect
  }
  // eslint-disable-next-line no-eval
  ;(0, eval)(inspectSource)
  // eslint-disable-next-line no-eval
  ;(0, eval)(source)
})
afterEach(() => {
  canvas()?.dispose()
  vi.restoreAllMocks()
})

describe('live canvas', () => {
  it('returns design coordinates relative to the slide, visibility and resources', () => {
    const evidence = CanvasEvidence.parse(canvas().inspect('elements'))
    expect(evidence.renderedRevision).toBe('r1')
    expect(evidence.elements.find((e) => e.selector === '#title')?.box).toEqual({
      x: 0,
      y: 0,
      w: 200,
      h: 40,
    })
    expect(evidence.elements.find((e) => e.tag === 'img')?.source).toBe('chart.png')
    expect(evidence.elements.find((e) => e.tag === 'p')?.visible).toBe(false)
    expect(evidence.elements.some((e) => e.text === 'Other')).toBe(false)
  })
  it('persists a selection across reads and excludes the overlay from HTML', () => {
    canvas().select({ selector: '#title', slide: 0, expectedRevision: 'r1' })
    expect(canvas().inspect().selection.selector).toBe('#title')
    expect(canvas().inspect().selection.selector).toBe('#title')
    expect(document.querySelector('#__orca-selection')).not.toBeNull()
    expect(canvas().inspect('html').html).not.toContain('__orca-selection')
    expect(canvas().inspect('html').html).not.toContain('Other')
    canvas().select({ selector: null, slide: 0, expectedRevision: 'r1' })
    expect(canvas().inspect().selection).toBeNull()
  })
  it('rejects stale versions, changed slides, ambiguous or hidden targets', () => {
    expect(() =>
      canvas().select({ selector: '#title', slide: 0, expectedRevision: 'old' }),
    ).toThrow('STALE_REVISION')
    expect(() => canvas().select({ selector: '#title', slide: 1, expectedRevision: 'r1' })).toThrow(
      'SLIDE_CHANGED',
    )
    document.querySelector('section')!.insertAdjacentHTML('beforeend', '<h2>Second</h2>')
    expect(() => canvas().select({ selector: 'h2', slide: 0, expectedRevision: 'r1' })).toThrow(
      'ELEMENT_NOT_UNIQUE',
    )
    expect(() => canvas().select({ selector: 'p', slide: 0, expectedRevision: 'r1' })).toThrow(
      'ELEMENT_NOT_VISIBLE',
    )
  })
  it('invalidates selected nodes when the visible slide changes or node is removed', () => {
    canvas().select({ selector: '#title', slide: 0, expectedRevision: 'r1' })
    index = 1
    expect(canvas().inspect().selection).toBeNull()
    index = 0
    canvas().select({ selector: '#title', slide: 0, expectedRevision: 'r1' })
    document.querySelector('#title')!.remove()
    expect(canvas().inspect().selection).toBeNull()
  })
  it('caps HTML and element payloads and indicates truncation', () => {
    document.querySelector('section')!.innerHTML =
      '<p>' + 'x'.repeat(110000) + '</p>' + '<img src="a.png" />'.repeat(501)
    expect(canvas().inspect('html')).toMatchObject({ htmlTruncated: true })
    expect(canvas().inspect('html').html).toHaveLength(100000)
    expect(canvas().inspect('elements').elements).toHaveLength(500)
    expect(canvas().inspect('elements').elementsTruncated).toBe(true)
  })
  it('records script and resource errors without accumulating duplicate listeners', () => {
    // eslint-disable-next-line no-eval
    ;(0, eval)(source)
    window.dispatchEvent(new ErrorEvent('error', { message: 'broken', filename: 'deck.js' }))
    document.querySelector('img')!.dispatchEvent(new Event('error'))
    const errors = canvas().inspect('errors').errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ kind: 'script', message: 'broken', source: 'deck.js' })
    expect(errors[1]).toMatchObject({ kind: 'resource', source: 'chart.png' })
  })
  it('escapes unusual IDs and anchor values so selectors identify exactly one node', () => {
    const title = document.querySelector('h2')!
    title.id = '2:title.with spaces'
    const selector = window.__orcaInspect.selectorFor(title)
    expect(document.querySelector('section')!.querySelector(selector)).toBe(title)
    title.removeAttribute('id')
    title.setAttribute('data-anchor', 'a"b\\c')
    expect(
      document.querySelector('section')!.querySelector(window.__orcaInspect.selectorFor(title)),
    ).toBe(title)
  })
})
