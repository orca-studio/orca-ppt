// 官网的三件小事:顶栏滚动后加分隔线、点同款弹窗放映、复制命令。

const nav = document.querySelector('[data-nav]')
const onScroll = () => nav.toggleAttribute('data-scrolled', window.scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()

// 同款:点卡片(和首屏那份)弹出放映窗口,样稿在 iframe 里,方向键翻页。不悬停自动播 ——
// 一屏二十多张卡,动的只该是人点开的那一份。按着 ⌘ / Ctrl / 中键点,照常新标签页打开。
const player = document.querySelector('.player')
const frame = player.querySelector('iframe')
const closePlayer = () => player.close()
for (const link of document.querySelectorAll('[data-play]')) {
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    player.querySelector('.player-title').textContent = link.dataset.title
    player.querySelector('.player-new').href = link.href
    frame.src = link.href
    player.showModal()
    frame.addEventListener(
      'load',
      () => {
        // 焦点给样稿,方向键直接翻页。焦点在样稿里时 Esc 到不了 dialog,在样稿里也接一下
        // (抢在 reveal 前面:它拿 Esc 开总览)
        frame.contentWindow?.focus()
        frame.contentDocument?.addEventListener(
          'keydown',
          (key) => {
            if (key.key === 'Escape') {
              key.stopImmediatePropagation()
              closePlayer()
            }
          },
          true,
        )
      },
      { once: true },
    )
  })
}
player.querySelector('.player-close').addEventListener('click', closePlayer)
// 点窗口外的暗处关掉
player.addEventListener('click', (event) => {
  if (event.target === player) closePlayer()
})
// 关了就卸掉样稿:不然转场、视频还在后台跑
player.addEventListener('close', () => frame.removeAttribute('src'))

for (const box of document.querySelectorAll('[data-copy]')) {
  const button = box.querySelector('button')
  const text = box.querySelector('code').textContent.trim()
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = '已复制'
    } catch {
      // 剪贴板不让写(非安全上下文等):选中文字,让人自己 Cmd+C
      getSelection().selectAllChildren(box.querySelector('code'))
      button.textContent = '按 ⌘C'
    }
    clearTimeout(button._t)
    button._t = setTimeout(() => (button.textContent = '复制'), 1600)
  })
}
