// 官网的几件小事:顶栏滚动后加分隔线、下载按钮跟着访客的系统走、点同款弹窗放映、复制命令。

// Windows 访客:顶栏那个按钮换成 Windows 版;两个平台并排的地方,把 Windows 版挪到前面、
// 换成实心按钮。认不出(手机、Linux)就按 Mac 优先,不藏任何一个
const isWindows =
  /^win/i.test(navigator.userAgentData?.platform || navigator.platform || '') ||
  /Windows/.test(navigator.userAgent)
if (isWindows) {
  const win = document.querySelector('[data-download="win"]')
  for (const link of document.querySelectorAll('[data-download="auto"]')) {
    link.href = win.href
    link.textContent = '下载 Windows 版'
  }
  for (const row of document.querySelectorAll('[data-platforms]')) {
    const mac = row.querySelector('[data-download="mac"]')
    const win = row.querySelector('[data-download="win"]')
    row.insertBefore(win, mac)
    if (mac.classList.contains('btn-solid')) {
      mac.classList.replace('btn-solid', 'btn-ghost')
      win.classList.replace('btn-ghost', 'btn-solid')
    }
  }
}

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
    // 新开的样稿从第一页起;按钮状态等它加载好再按实际情况更新
    prev.disabled = true
    next.disabled = false
    player.showModal()
    frame.addEventListener(
      'load',
      () => {
        // 焦点给样稿,方向键直接翻页。焦点在样稿里时 Esc 到不了 dialog,在样稿里也接一下
        // (抢在 reveal 前面:它拿 Esc 开总览)
        frame.contentWindow?.focus()
        watchDeck()
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

// 左右两个圆钮。往后翻走引擎的 __orcaAdvance(转场没放完会先放完,页内分步一步一步推),
// 往回翻直接切(引擎本来就是往回不播转场)。点完把焦点还给样稿,方向键接着能用
const prev = player.querySelector('.player-prev')
const next = player.querySelector('.player-next')
const deck = () => frame.contentWindow
prev.addEventListener('click', () => {
  deck()?.Reveal?.prev()
  deck()?.focus()
})
next.addEventListener('click', () => {
  const win = deck()
  if (win?.__orcaAdvance) win.__orcaAdvance()
  else win?.Reveal?.next()
  win?.focus()
})
// 第一页没有上一页;最后一页的页内分步也放完了,就没有下一页
function syncNav() {
  const reveal = deck()?.Reveal
  if (!reveal?.isReady?.()) return
  const step = deck().__orcaStep?.() ?? { done: 0, clicks: 0 }
  prev.disabled = reveal.isFirstSlide()
  next.disabled = reveal.isLastSlide() && step.done >= step.clicks
}
function watchDeck() {
  const win = deck()
  if (!win?.Reveal) return
  const start = () => {
    win.Reveal.on('slidechanged', syncNav)
    win.document.addEventListener('orca:step', syncNav)
    syncNav()
  }
  if (win.Reveal.isReady()) start()
  else win.Reveal.on('ready', start)
}
// 点窗口外的暗处关掉
player.addEventListener('click', (event) => {
  if (event.target === player) closePlayer()
})
// 关了就卸掉样稿:不然转场、视频还在后台跑
player.addEventListener('close', () => frame.removeAttribute('src'))

for (const box of document.querySelectorAll('[data-copy]')) {
  const button = box.querySelector('button')
  // HTML 格式化会把长句折行,复制时把换行和缩进并回一个空格
  const text = box.querySelector('code').textContent.trim().replace(/\s+/g, ' ')
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = '已复制'
    } catch {
      // 剪贴板不让写(非安全上下文等):选中文字,让人自己复制
      getSelection().selectAllChildren(box.querySelector('code'))
      button.textContent = isWindows ? '按 Ctrl+C' : '按 ⌘C'
    }
    clearTimeout(button._t)
    button._t = setTimeout(() => (button.textContent = '复制'), 1600)
  })
}
