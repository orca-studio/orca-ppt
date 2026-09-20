import type { PendingRequest } from '@orca-ppt/contracts'

/**
 * 刚指了哪儿。
 *
 * **不是一个「待办队列」** —— 人本来就是在跟 agent 说话,点一下只是**指给它看**,
 * 「挂进队列等它来取」这个环节在用户脑子里不存在,写在界面上只会让人以为还要做点什么。
 *
 * 那为什么还留着:点一下之后**必须有回应**。完全没有反馈的按钮,人分不清是点中了
 * 还是没点中。所以这里只摆最后指的那一处,一行,没有增删,也没有「N 条待处理」。
 */
export function Pending({
  requests,
  crops,
}: {
  requests: PendingRequest[]
  /** 锚的裁切图,按 request id 索引 —— 图只在本机预览用,不进协议。 */
  crops: Map<string, string>
}) {
  const latest = requests[requests.length - 1]
  if (!latest) return null

  return (
    <div className="pending">
      {latest.kind === 'anchor' && crops.get(latest.id) && (
        <img src={crops.get(latest.id)} alt="" />
      )}
      <span>
        已指给 agent · {describe(latest)}
        {requests.length > 1 && <em>还有 {requests.length - 1} 处</em>}
      </span>
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
  if (request.kind === 'phase') return `「${PHASE_LABEL[request.phase] ?? request.phase}」`
  const anchor = request.anchor
  if (anchor.kind === 'transition') return `第 ${anchor.from + 1} → ${anchor.to + 1} 页的转场`
  return `第 ${anchor.slide + 1} 页 · ${anchor.text || anchor.selector}`
}
