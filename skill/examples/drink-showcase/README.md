# Drink showcase · 四栏到全屏

这是一个用五页 HTML slides 做成的产品动画案例。动画由现有 Reveal 共享元素与 `engine.js` 实现，页面里没有手写 GSAP 时间线。

- [交互教程](tutorial.html)：从头播放、下一步、慢放、逐页状态、制作提示词。
- [纯演示稿](index.html)：方向键向前翻页，向后返回静态状态。
- [案例规范](../../references/product-showcase.md)：适用范围、配对规则与局部版式例外。

## 本地打开

在仓库根目录安装好依赖后：

```sh
npx serve . -l 3040
```

访问 `http://localhost:3040/examples/drink-showcase/tutorial.html`。
也可以直接打开 `index.html`，使用方向键放映。

## 五页分别改什么

| 页 | 保留的元素 | 改变的状态 |
| --- | --- | --- |
| 1 | 四栏产品信息 | 橙瓶展示，其他瓶子在画外下方 |
| 2 | 色块、所有产品的稳定标识 | 色块右移变粉；橙瓶上出，粉瓶下入 |
| 3 | 同上 | 色块右移变紫；粉瓶上出，紫瓶下入 |
| 4 | 同上 | 色块右移变青；紫瓶上出，青瓶下入 |
| 5 | 青色块和同一只青瓶 | 色块铺满，瓶子居中放大，详情出现 |

`data-id` 相同且标签相同，表示“这是同一个东西”。例如 `active-panel` 在前四页宽 480，最后一页宽 1920。`bottle-lychee` 从第四栏移到中央，始终引用同一个 SVG。

按需替换 `assets/*.svg`、产品名称与说明、`fruit-soda.css` 产品色值。替换字体与字阶在 `product-showcase.css` 里做。其余汇报稿不会加载这套局部样式。

## 参考与差异

运动参考为用户提供的 6 秒饮料分栏视频（小红书素材 ID：`6a97d33e000000001203c754`）的第 0–180 帧。保留切换顺序、横向色块、上下交接和末尾展开关系。瓶身是本案例自制 SVG 示意图，品牌文字为演示内容；没有分发源视频截图。为教学可读性，彩色面板上的说明使用深字；字体与瓶身不追求像素一致。

## 本次验证

- `check-deck.mjs`：本案例 5 页通过；普通 `editorial-forest` 仍报告 7 条既有文字配色规则问题，未修改该示例。
- `npm run palettes`：新增 `fruit-soda` 通过。仓库其他配色的既有提醒不属于此案例。
- `capture.mjs`：181 帧、30fps、1920×1080，`problems: []`。
- 四次转场为 27–48、66–87、106–127、144–167 帧；逐帧差分分别有 21/21、21/21、21/21、23/23 个有效连续变化（320×180 缩略亮度差均值 > 0.15）。
- 已查看中间帧联系表；逐帧输出未出现只在一两帧跳变的假动画。
- 浏览器已验证正常播放、慢放、返回首屏、下一步、提示词复制与图片加载。

录制命令：

```sh
node scripts/capture.mjs examples/drink-showcase/index.html \
  -o examples/drink-showcase/index.mp4 \
  --json examples/drink-showcase/capture-report.json
```

视频和录制报告是本地验证产物，不提交；网页播放不依赖它们。
