import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  contentTypeFor,
  isUnsafeServeRoot,
  maxEscapeDepth,
  planPreview,
  resolveWithinRoot,
} from './preview.js'

/** skill 做出来的稿子长这样 —— 资源在 deck 目录外面两层。 */
const SKILL_DECK = `<!doctype html>
<link rel="stylesheet" href="../../node_modules/reveal.js/dist/reveal.css">
<link rel="stylesheet" href="../../runtime/tokens.css">
<script src="../../node_modules/gsap/dist/gsap.min.js"></script>
<img src="assets/photo.jpg">`

describe('maxEscapeDepth', () => {
  it('数出稿子实际往上跳几层', () => {
    expect(maxEscapeDepth(SKILL_DECK)).toBe(2)
  })

  it('自包含的稿子不逃逸', () => {
    expect(maxEscapeDepth('<img src="assets/a.png"><script src="./e.js"></script>')).toBe(0)
  })

  it('绝对 URL 不算 —— 它们不落在本地文件系统上', () => {
    const html = `<link href="https://fonts.googleapis.com/css2?family=Inter">
      <script src="//cdn.example.com/x.js"></script><img src="/logo.png"><img src="data:image/png;base64,AA">`
    expect(maxEscapeDepth(html)).toBe(0)
  })

  it('认 CSS 的 url() —— 内联样式里的背景图也会逃逸', () => {
    expect(maxEscapeDepth('<div style="background:url(../../_assets/bg.jpg)">')).toBe(2)
  })

  it('只数开头连续的 ..,中间的不算', () => {
    expect(maxEscapeDepth('<img src="../a/../b.png">')).toBe(1)
  })
})

describe('planPreview', () => {
  it('按逃逸层数倒推服务根,而不是改写稿子', () => {
    const deckDir = '/Users/x/work/skill/examples/forest-timeline'
    const plan = planPreview(deckDir, join(deckDir, 'index.html'), SKILL_DECK)
    expect(plan.serveRoot).toBe('/Users/x/work/skill')
    expect(plan.urlPath).toBe('/examples/forest-timeline/index.html')
    expect(plan.escapeDepth).toBe(2)
  })

  it('自包含的稿子就服务 deck 目录本身', () => {
    const plan = planPreview(
      '/Users/x/work/deck',
      '/Users/x/work/deck/deck.html',
      '<img src="a.png">',
    )
    expect(plan.serveRoot).toBe('/Users/x/work/deck')
    expect(plan.urlPath).toBe('/deck.html')
  })

  it('逃逸太深时如实报错', () => {
    expect(() =>
      planPreview(
        '/Users/x/a/b/c/d/e',
        '/Users/x/a/b/c/d/e/deck.html',
        '<img src="../../../../../../x.png">',
      ),
    ).toThrow('超过上限')
  })

  it('服务根会盖到家目录时拒绝,不偷偷降级', () => {
    const deckDir = join(homedir(), 'deck')
    expect(() => planPreview(deckDir, join(deckDir, 'deck.html'), '<img src="../x.png">')).toThrow(
      '范围太大',
    )
  })
})

describe('isUnsafeServeRoot', () => {
  it('家目录和更上层都不行', () => {
    expect(isUnsafeServeRoot(homedir())).toBe(true)
    expect(isUnsafeServeRoot('/')).toBe(true)
  })

  it('正常的工程目录可以', () => {
    expect(isUnsafeServeRoot(join(homedir(), 'ghq', 'x'))).toBe(false)
  })
})

describe('resolveWithinRoot', () => {
  it('正常路径落在根里', () => {
    expect(resolveWithinRoot('/srv/deck', '/runtime/tokens.css')).toBe(
      '/srv/deck/runtime/tokens.css',
    )
  })

  it('往上穿越一律拒绝', () => {
    expect(resolveWithinRoot('/srv/deck', '/../../etc/passwd')).toBeUndefined()
    expect(resolveWithinRoot('/srv/deck', '/a/../../../etc/passwd')).toBeUndefined()
  })

  it('编码过的穿越也拒绝', () => {
    expect(resolveWithinRoot('/srv/deck', '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined()
  })

  it('前缀相同但不是子目录的兄弟目录拒绝', () => {
    expect(resolveWithinRoot('/srv/deck', '/../deck-other/x')).toBeUndefined()
  })

  it('查询串不参与路径解析', () => {
    expect(resolveWithinRoot('/srv/deck', '/a.css?v=2')).toBe('/srv/deck/a.css')
  })

  it('解不开的编码和 NUL 都拒绝', () => {
    expect(resolveWithinRoot('/srv/deck', '/%ZZ')).toBeUndefined()
    expect(resolveWithinRoot('/srv/deck', '/a\0b')).toBeUndefined()
  })
})

describe('contentTypeFor', () => {
  it('认得稿子用到的类型', () => {
    expect(contentTypeFor('/a/reveal.css')).toContain('text/css')
    expect(contentTypeFor('/a/engine.js')).toContain('javascript')
    expect(contentTypeFor('/a/photo.JPG')).toBe('image/jpeg')
    expect(contentTypeFor('/a/clip.mp4')).toBe('video/mp4')
  })

  it('不认得的给二进制流,不瞎猜', () => {
    expect(contentTypeFor('/a/LICENSE')).toBe('application/octet-stream')
  })
})
