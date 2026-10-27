// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import source from './bridge.guest.js?raw'

/** 直接 eval 真正要注入的那份脚本,不写平行实现。 */
declare global {
  interface Window {
    __orcaHost: {
      call(action: string, args?: unknown[]): Promise<{ value?: unknown; error?: string }>
    }
  }
}

beforeEach(() => {
  // 注入时没有 currentScript.src:只装动作表,不挂 postMessage(桌面版 webview 就是这样)
  window.eval(source)
})

describe('动作表', () => {
  it('不认识的动作直接拒绝 —— 只收固定的几个,不收任意代码', async () => {
    expect(await window.__orcaHost.call('eval', ['1 + 1'])).toEqual({ error: '不认识的动作:eval' })
    expect(await window.__orcaHost.call('constructor')).toMatchObject({ error: expect.any(String) })
  })

  it('动作出错带回原因,不抛', async () => {
    ;(window as any).Reveal = undefined
    const reply = await window.__orcaHost.call('slideTo', [2])
    expect(reply.error).toMatch(/TypeError/)
  })

  it('照常调到 Reveal', async () => {
    let at = 0
    ;(window as any).Reveal = {
      slide: (index: number) => {
        at = index
      },
      getIndices: () => ({ h: at }),
    }
    expect(await window.__orcaHost.call('slideTo', [3])).toEqual({ value: 3 })
  })
})
