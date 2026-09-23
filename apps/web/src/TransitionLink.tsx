import type { TransitionNote } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'

/**
 * 两张缩略图之间的那一道:这次翻页是怎么接上的。
 *
 * 画在这儿而不是单开一栏,因为转场**本来就住在两页之间** —— 列在别处就又要在脑子里
 * 把「3→4」和第 3、4 张图对起来。
 *
 * 两个动作:重放(画布跳回上一页再翻过来)、挂进待办(产生一条**转场锚**)。
 * 在这之前界面上没有任何入口能产生转场锚 —— 契约里早就有了,但「第 3 页到第 4 页这个
 * 硬切没对上」只能打字描述,而不用打字描述位置正是这个产品的立论。
 */
export interface TransitionLinkProps {
  note: TransitionNote | undefined
  onReplay: () => void
  onFlag: () => void
}

export function TransitionLink({ note, onReplay, onFlag }: TransitionLinkProps) {
  if (!note) return <div className="tlink tlink--none" aria-hidden="true" />

  return (
    <div className="tlink" title={note.relation}>
      <span className="tlink-technique">{note.technique}</span>
      <span className="tlink-actions">
        <Button size="xs" icon onClick={onReplay} title="重放这次翻页" aria-label="重放这次翻页">
          ▶
        </Button>
        <Button size="xs" icon onClick={onFlag} title="这儿不对 —— 挂进待办" aria-label="这儿不对">
          ⚑
        </Button>
      </span>
    </div>
  )
}
