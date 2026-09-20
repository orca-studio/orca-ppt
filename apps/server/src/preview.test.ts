import { describe, expect, it } from 'vitest'
import { contentTypeFor, planPreview, resolveWithinRoots, toUrlPath } from './preview.js'

describe('planPreview', () => {
  it('挂载路径就是入口文件的绝对路径', () => {
    const plan = planPreview(
      '/Users/x/skill/examples/forest',
      '/Users/x/skill/examples/forest/index.html',
    )
    expect(plan.urlPath).toBe('/Users/x/skill/examples/forest/index.html')
    expect(plan.root).toBe('/Users/x/skill/examples/forest')
  })

  /**
   * 这一条是整个做法的理由:URL 层数和磁盘层数一一对应,稿子里的相对引用在浏览器里
   * 解析出来的路径,和它在磁盘上指向的路径完全一致 —— 不管跳两层还是七层。
   */
  it.each([
    [
      '浅引用',
      '../../runtime/tokens.css',
      '/Users/x/skill/examples/forest/index.html',
      '/Users/x/skill/runtime/tokens.css',
    ],
    [
      '深引用(deck 和 skill 隔得远)',
      '../../../../../../../Users/x/skill/node_modules/reveal.js/dist/reveal.js',
      '/tmp/a/b/c/d/e/deck/deck.html',
      '/Users/x/skill/node_modules/reveal.js/dist/reveal.js',
    ],
    ['同目录', 'assets/photo.jpg', '/Users/x/deck/deck.html', '/Users/x/deck/assets/photo.jpg'],
  ])('%s 解析出来和磁盘上一致', (_name, href, entry, expected) => {
    const mount = `/p/TOKEN${planPreview('/ignored', entry).urlPath}`
    const resolved = new URL(href, `http://127.0.0.1:1${mount}`).pathname
    expect(resolved).toBe(`/p/TOKEN${expected}`)
  })
})

describe('toUrlPath', () => {
  it('POSIX 路径原样', () => {
    expect(toUrlPath('/Users/x/deck.html')).toBe('/Users/x/deck.html')
  })
})

describe('resolveWithinRoots', () => {
  const roots = ['/Users/x/deck', '/Users/x/skill']

  it('落在 deck 或 skill 里就认', () => {
    expect(resolveWithinRoots(roots, '/Users/x/deck/assets/a.png')).toBe(
      '/Users/x/deck/assets/a.png',
    )
    expect(resolveWithinRoots(roots, '/Users/x/skill/runtime/tokens.css')).toBe(
      '/Users/x/skill/runtime/tokens.css',
    )
  })

  it('两个目录之外一概不认 —— 这不是一个通用文件服务', () => {
    expect(resolveWithinRoots(roots, '/etc/passwd')).toBeUndefined()
    expect(resolveWithinRoots(roots, '/Users/x/.ssh/id_rsa')).toBeUndefined()
  })

  it('前缀相同但不是子目录的兄弟目录不认', () => {
    expect(resolveWithinRoots(roots, '/Users/x/skill-other/secret')).toBeUndefined()
  })

  it('穿越回来落在里面就认,穿越出去就不认', () => {
    expect(resolveWithinRoots(roots, '/Users/x/skill/a/../runtime/t.css')).toBe(
      '/Users/x/skill/runtime/t.css',
    )
    expect(resolveWithinRoots(roots, '/Users/x/skill/../../../etc/passwd')).toBeUndefined()
  })

  it('查询串不参与路径解析', () => {
    expect(resolveWithinRoots(roots, '/Users/x/deck/a.css?v=2')).toBe('/Users/x/deck/a.css')
  })

  it('相对路径、坏编码、NUL 一律拒绝', () => {
    expect(resolveWithinRoots(roots, 'Users/x/deck/a.js')).toBeUndefined()
    expect(resolveWithinRoots(roots, '/%ZZ')).toBeUndefined()
    expect(resolveWithinRoots(roots, '/Users/x/deck/a\0b')).toBeUndefined()
  })

  it('没有 allow root 时什么都不认', () => {
    expect(resolveWithinRoots([], '/Users/x/deck/a.js')).toBeUndefined()
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
