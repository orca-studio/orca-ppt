// 官网的三件小事:顶栏滚动后加分隔线、同款样片悬停播放、复制命令。

const nav = document.querySelector('[data-nav]')
const onScroll = () => nav.toggleAttribute('data-scrolled', window.scrollY > 8)
addEventListener('scroll', onScroll, { passive: true })
onScroll()

// 样片:能悬停的设备悬停才播(一屏十段视频同时放既吵又费电),移开回到封面;
// 触屏没有悬停,滚进视口就播。用户开了减少动效就一直停在封面。
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
const hover = matchMedia('(hover: hover) and (pointer: fine)').matches
const load = (video) => {
  if (!video.src && video.dataset.src) video.src = video.dataset.src
}
for (const video of document.querySelectorAll('.card video')) {
  if (reduce) break
  const card = video.closest('.card-media')
  if (hover) {
    card.addEventListener('pointerenter', () => {
      load(video)
      video.play().catch(() => {})
    })
    card.addEventListener('pointerleave', () => {
      video.pause()
      video.currentTime = 0
    })
  } else {
    new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          load(video)
          video.play().catch(() => {})
        } else video.pause()
      },
      { threshold: 0.6 },
    ).observe(video)
  }
}
if (reduce) for (const video of document.querySelectorAll('.hero video')) video.pause()

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
