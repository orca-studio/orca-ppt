/**
 * 看片台:全部页面铺开。
 *
 * 一份稿子读起来顺不顺,很多时候要退后一步看整体 —— 放映一页一页翻看不出节奏。
 * 缩略图本来就渲好了,这里只是换个排法。
 */
export interface LightTableProps {
  count: number
  current: number
  thumbs: Array<string | null>
  titleOf: (index: number) => string
  onPick: (index: number) => void
}

export function LightTable({ count, current, thumbs, titleOf, onPick }: LightTableProps) {
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
            <img src={`file://${thumbs[index]}`} alt="" />
          ) : (
            <span className="lighttable-blank" />
          )}
          <span className="lighttable-caption">
            <span className="lighttable-no">{index + 1}</span>
            {titleOf(index)}
          </span>
        </button>
      ))}
    </div>
  )
}
