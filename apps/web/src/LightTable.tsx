/**
 * 看片台:全部页面铺开。
 *
 * 一份稿子读起来顺不顺,很多时候要退后一步看整体 —— 放映一页一页翻看不出节奏。
 * 缩略图本来就渲好了,这里只是换个排法。
 */
import { assetUrl } from './assets.js'
export interface LightTableProps {
  count: number
  current: number
  thumbs: Array<string | null>
  onPick: (index: number) => void
}

export function LightTable({ count, current, thumbs, onPick }: LightTableProps) {
  return (
    <div className="lighttable">
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          data-current={index === current}
          onClick={() => onPick(index)}
        >
          {thumbs[index] ? (
            <img src={assetUrl(thumbs[index])} alt="" />
          ) : (
            <span className="lighttable-blank" />
          )}
          {/* 图够大,标题在图里读得出来 —— 只留页号。 */}
          <span className="lighttable-caption">{index + 1}</span>
        </button>
      ))}
    </div>
  )
}
