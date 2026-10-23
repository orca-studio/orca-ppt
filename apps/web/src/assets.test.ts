import { describe, expect, it } from 'vitest'
import { assetUrl, useAssetOrigin } from './assets.js'

describe('assetUrl', () => {
  useAssetOrigin('ws://127.0.0.1:6722')

  it('逐段编码,分隔符留着', () => {
    expect(assetUrl('/Users/me/稿子 #1/a.png')).toBe(
      'http://127.0.0.1:6722/asset/Users/me/%E7%A8%BF%E5%AD%90%20%231/a.png',
    )
  })

  it('Windows 路径写成 /C:/…', () => {
    expect(assetUrl('C:\\Users\\me\\a.png')).toBe('http://127.0.0.1:6722/asset/C%3A/Users/me/a.png')
  })

  it('macOS 文件名里的反斜杠不当分隔符', () => {
    expect(assetUrl('/Users/me/a\\b.png')).toBe('http://127.0.0.1:6722/asset/Users/me/a%5Cb.png')
  })
})
