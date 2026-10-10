import type { TransitionNote } from '@orca-ppt/contracts'
import { Button } from './ui/Button.js'

/**
 * 两张缩略图之间的那一道:这次翻页是怎么接上的。
 *
 * 画在这儿而不是单开一栏,因为转场**本来就住在两页之间** —— 列在别处就又要在脑子里
 * 把「3→4」和第 3、4 张图对起来。
 *
 * 一个动作:挂进待办(产生一条**转场锚**)。「第 3 页到第 4 页这个硬切没对上」不用打字
 * 描述位置,正是这个产品的立论。重放不放这儿:右栏「这一次转场」里有,每页挂一个按钮太乱。
 */
export interface TransitionLinkProps {
  note: TransitionNote | undefined
  /** 挂进待办。只读样稿上不给 —— 指出来也没人能改。 */
  onFlag?: (() => void) | undefined
}

export function TransitionLink({ note, onFlag }: TransitionLinkProps) {
  if (!note) return <div className="tlink tlink--none" aria-hidden="true" />

  return (
    <div className="tlink" title={note.relation}>
      <span className="tlink-technique">{note.technique}</span>
      <span className="tlink-actions">
        {onFlag && (
          <Button
            size="xs"
            icon
            onClick={onFlag}
            title="这儿不对 —— 挂进待办"
            aria-label="这儿不对"
          >
            ⚑
          </Button>
        )}
      </span>
    </div>
  )
}
