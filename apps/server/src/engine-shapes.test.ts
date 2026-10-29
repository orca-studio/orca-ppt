import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 引擎在共享元素页上补的两样（skill 的 runtime/engine.js，transitions.md「共享元素」第 11、12 条）：
 *   - 裁剪形状 clip-path: polygon(…) 跟着位置逐点插值
 *   - 新入场元素的 3D 转角 rotate: y …，不被 GSAP 的上浮淡入压平
 *   - 3D 转角和平面转角一样绕盒子中心转
 * 用录制模式（?capture）逐毫秒 seek，在本机 Chrome 里量。没装 Chrome 就跳过（和 check-deck 一样）。
 */
const skill = fileURLToPath(new URL('../../../skills/orca-ppt/', import.meta.url))
const href = (path: string) => pathToFileURL(join(skill, path)).href

const RECT = 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
const SLANT = 'polygon(100px 0, 100% 0, calc(100% - 100px) 100%, 0 100%)'

describe('共享元素的形状和 3D 转角', () => {
  it('clip-path 逐点插值，新元素的 rotate: y 留得住', async (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-engine-shapes-'))
    const deck = join(dir, 'deck.html')
    writeFileSync(
      deck,
      `<!doctype html><html lang="zh-CN" data-layout="standard"><head><meta charset="utf-8"><title>形状</title>
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reset.css')}">
<link rel="stylesheet" href="${href('node_modules/reveal.js/dist/reveal.css')}">
<link rel="stylesheet" href="${href('runtime/tokens.css')}">
<link rel="stylesheet" href="${href('runtime/themes/editorial-forest.css')}">
</head><body><div class="reveal"><div class="slides">
<section data-auto-animate style="perspective:1400px;">
  <div data-id="a" class="s-surface" style="left:200px; top:200px; width:400px; height:600px; clip-path:${RECT};"></div>
</section>
<section data-auto-animate style="perspective:1400px;">
  <div data-id="a" class="s-surface" style="left:600px; top:200px; width:400px; height:600px; clip-path:${SLANT}; rotate:y 34deg;"></div>
  <div id="b" class="s-accent" data-auto-animate-delay="0.6" style="left:1200px; top:200px; width:400px; height:600px; rotate:y -34deg;"></div>
</section>
</div></div>
<script src="${href('node_modules/reveal.js/dist/reveal.js')}"></script>
<script src="${href('node_modules/gsap/dist/gsap.min.js')}"></script>
<script src="${href('runtime/engine.js')}"></script></body></html>`,
    )
    const probe = join(dir, 'probe.mjs')
    writeFileSync(
      probe,
      `import { chromium } from ${JSON.stringify(href('node_modules/playwright-core/index.mjs'))};
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(${JSON.stringify(pathToFileURL(deck).href + '?capture')});
await page.waitForFunction(() => window.__capture);
const at = (ms) => page.evaluate(async (t) => {
  await window.__capture.seek(t);
  const s = Reveal.getSlide(1);
  const a = s.querySelector('[data-id="a"]');
  return { clip: a.style.clipPath, origin: getComputedStyle(a).transformOrigin, rotate: getComputedStyle(s.querySelector("#b")).rotate };
}, ms);
await page.evaluate(() => window.__capture.go(0));
await page.evaluate(() => window.__capture.go(1));
const mid = await at(450);
const enter = await at(900);
const end = await at(5000);
console.log(JSON.stringify({ mid, enter, end }));
await browser.close();`,
    )
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
    if (result.status !== 0 && /chrome|Executable|browserType\.launch/i.test(result.stderr)) {
      context.skip()
    }
    expect(result.status, result.stderr).toBe(0)
    const { mid, enter, end } = JSON.parse(result.stdout)
    // 中途：既不是长方形也不是平行四边形，是引擎逐点算出来的中间形状
    expect(mid.clip).toMatch(/^polygon\(calc\(/)
    // 放完：落在作者写的形状上（浏览器把 0 读成 0px）
    expect(end.clip).toBe('polygon(100px 0px, 100% 0px, calc(100% - 100px) 100%, 0px 100%)')
    // 上浮淡入的半路和放完，绕 y 轴的转角都还在
    expect(enter.rotate).toBe('y -34deg')
    expect(end.rotate).toBe('y -34deg')
    // 配上对的元素也绕自己的中心转（reveal 默认把支点钉在左上角），开窗的左右两张才对称
    expect(end.origin).toBe('200px 300px')
  }, 60_000)
})
