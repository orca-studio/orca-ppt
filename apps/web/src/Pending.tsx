import { useState } from 'react'
import type { PendingRequest } from '@orca-ppt/contracts'

/**
 * 当前指着什么。
 *
 * **不是一个「待办队列」** —— 人本来就是在跟 agent 说话,点一下只是**指给它看**,
 * 「挂进队列等它来取」这个环节在用户脑子里不存在,写在界面上只会让人以为还要做点什么。
 *
 * 底下的机制确实是拉不是推(MCP 没有把消息推进对话的原语),但那是管道的事,
 * 不该漏到界面上来。
 */
export function Pending({
  requests,
  crops,
  mcpUrl,
  agentSeen,
  onRemove,
}: {
  requests: PendingRequest[]
  /** 锚的裁切图,按 request id 索引 —— 图只在本机预览用,不进协议。 */
  crops: Map<string, string>
  mcpUrl: string
  /** agent 来取过东西吗。没有才提示怎么连 —— 连上之后那行就是噪音。 */
  agentSeen: boolean
  onRemove: (id: string) => void
}) {
  if (requests.length === 0) {
    return (
      <div className="pending pending-empty">
        <p className="muted">
          在画布上点一处,看清它在 1920×1080 版面里的位置。让 agent 代你改的时候,
          它读得到你指的是哪儿。
        </p>
        {!agentSeen && <Install url={mcpUrl} />}
      </div>
    )
  }

  return (
    <div className="pending">
      <header>选中 {requests.length} 处</header>
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
      {!agentSeen && <Install url={mcpUrl} />}
    </div>
  )
}

/** agent 还没连上时得有地方看到怎么连。一行命令,点一下就复制。 */
function Install({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const command = `claude mcp add --transport http orca-ppt ${url}`

  return (
    <div className="install">
      <span>让 agent 代你操作:</span>
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
