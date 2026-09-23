import type { ButtonHTMLAttributes } from 'react'

/**
 * 界面里唯一的按钮。
 *
 * 以前是 21 处各写各的 `xxx button { … }`:高度 24/26/28、圆角五六种、按下去有的变深有的
 * 没反应。人说不出哪儿不对,但整体读起来就是「散」。现在长相只有三个维度可选:
 *
 *   variant  secondary(柔和填充,默认)· primary(强调色,一屏最多一个)· ghost(不给底)
 *   size     xs 20 · sm 24 · md 28 —— 对应 token 里的 --control-*
 *   icon     正圆,宽 = 高
 *
 * 列表行、缩略图卡、菜单项不是按钮的长相,它们用裸 `<button>`(全局已经重置过)。
 */
export type ButtonVariant = 'secondary' | 'primary' | 'ghost'
export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonLook {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: boolean
}

/** `<select>` 这类没法换成 `<Button>` 的控件,拿这个类名套同一套长相。 */
export function buttonClass({ variant = 'secondary', size = 'md', icon = false }: ButtonLook = {}) {
  return ['btn', `btn--${variant}`, `btn--${size}`, icon && 'btn--icon'].filter(Boolean).join(' ')
}

export interface ButtonProps extends ButtonLook, ButtonHTMLAttributes<HTMLButtonElement> {
  /** 开关类按钮的「开」。secondary 开了变强调色,ghost 开了补上底色。 */
  on?: boolean
}

export function Button({ variant, size, icon, on, className, type, ...rest }: ButtonProps) {
  const look = buttonClass({
    ...(variant && { variant }),
    ...(size && { size }),
    ...(icon && { icon }),
  })
  return (
    <button
      type={type ?? 'button'}
      className={className ? `${look} ${className}` : look}
      data-on={on}
      {...rest}
    />
  )
}
