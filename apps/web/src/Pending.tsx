import { useState } from 'react'
import type { PendingRequest } from '@orca-pptcode/contracts'

/**
 * 待办队列。人在界面上取的锚、点的「跑」,都挂在这儿等 agent 来拉。
 *
 * MCP 没有可靠的「把消息推进用户对话」的原语,所以方向是反的 —— 与其假装能推,
 * 不如把「去跟 agent 说一声」明写在界面上。
 */
export function Pending({
  requests,
  crops,
  mcpUrl,
  onRemove,
}: {
  requests: PendingRequest[]
  /** 锚的裁切图,按 request id 索引 —— 图只在本机预览用,不进协议。 */
  crops: Map<string, string>
  mcpUrl: string
  onRemove: (id: string) => void
}) {
  if (requests.length === 0) {
    return (
      <div className="pending pending-empty">
        <p>在画布上点一处,或者点某个阶段的「跑」。</p>
        <p className="muted">挂在这儿等你的 agent 来取 —— 跟它说一声「看我刚点的那处」。</p>
        <Install url={mcpUrl} />
      </div>
    )
  }

  return (
    <div className="pending">
      <header>
        已挂 {requests.length} 件 · 跟 agent 说一声
        <code>take_requests</code>
      </header>
      <ul>
        {requests.map((request) => (
          <li key={request.id}>
            {request.kind === 'anchor' && crops.get(request.id) && (
              <img src={crops.get(request.id)} alt="" />
            )}
            <span>{describe(request)}</span>
            <button type="button" onClick={() => onRemove(request.id)} aria-label="去掉">
              ×
            </button>
          </li>
        ))}
      </ul>
      <Install url={mcpUrl} />
    </div>
  )
}

/** agent 还没连上时得有地方看到怎么连。一行命令,点一下就复制。 */
function Install({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const command = `claude mcp add --transport http orca-pptcode ${url}`

  return (
    <div className="install">
      <span>agent 还没连上?</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? '已复制' : '复制连接命令'}
      </button>
      <code>{url}</code>
    </div>
  )
}

const PHASE_LABEL: Record<string, string> = {
  brief: '定题',
  theme: '选主题',
  outline: '列页面',
  plan: '写转场',
  build: '出稿',
  review: '自检',
}

function describe(request: PendingRequest): string {
  if (request.kind === 'phase') return `跑「${PHASE_LABEL[request.phase] ?? request.phase}」`
  const anchor = request.anchor
  if (anchor.kind === 'transition') return `第 ${anchor.from + 1} → ${anchor.to + 1} 页的转场`
  return `第 ${anchor.slide + 1} 页 · ${anchor.text || anchor.selector}`
}
