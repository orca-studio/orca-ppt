/** 固定品牌色的独立图形；白色底板让深浅主题保持同样的识别度。 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}brand/orca-mark.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  )
}
