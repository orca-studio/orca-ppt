import { describe, expect, it } from 'vitest'
import { AgentError, hasAgentCode } from './agent-errors.js'

describe('AgentError', () => {
  it('每一条都是「前缀:原因。下一步:…」—— 前缀给宿主认,下一步给模型读', () => {
    const all = [
      AgentError.noDeckOpen(),
      AgentError.multipleDecks(['/a', '/b']),
      AgentError.deckNotOpen(),
      AgentError.noBuild(),
      AgentError.uiDisconnected(),
      AgentError.uiTimeout(),
      AgentError.noRenderer(),
      AgentError.skillNotFound(),
    ]
    for (const message of all) {
      expect(message).toMatch(/^[A-Z][A-Z_]+:.+。下一步:.+。$/)
      expect(hasAgentCode(message)).toBe(true)
    }
  })

  it('普通的拒绝理由不算带了前缀', () => {
    expect(hasAgentCode('这一页里有好几处一样的文字,认不准是哪一处')).toBe(false)
    expect(hasAgentCode('没有第 6 页')).toBe(false)
  })
})
