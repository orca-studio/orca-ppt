# Orca PPT 的 skill

> 2026-10-10 起，这个 skill 是 [Orca PPT](../../README.md) 的一部分，住在仓库的 `skills/orca-ppt/` 目录里，
> 跟着应用一起发版。agent 通过 Orca PPT 的 MCP 工具 `read_skill` 读它；不装应用的话，
> 把这个目录链进 agent 的 skills 目录也能用（见下面「怎么用」）。
> 原来的 `zhenwusw/orca-ppt-skill` 仓库就是现在这个仓库，旧地址会自动跳转过来。

一个给 AI Agent（Claude Code 等）用的 skill：生成**翻页时看得见连续运动**的 HTML 演示稿。
页与页之间按内容关系选手法——共享元素、形态变换、一变多、元素交接、匹配剪辑、遮挡剪辑……
成品是单个 HTML，浏览器直接放映。

## 全部示例在这里

### **[ppt.orca-studio.ai](https://ppt.orca-studio.ai)**

点开就能翻页，不用装任何东西。

## 示例

<table>
<tr>
<td width="33%"><a href="https://ppt.orca-studio.ai/examples/emerald-editorial/"><img src="https://ppt.orca-studio.ai/examples/emerald-editorial/thumb.jpg" alt="emerald-editorial"></a></td>
<td width="33%"><a href="https://ppt.orca-studio.ai/examples/editorial-tri-tone/"><img src="https://ppt.orca-studio.ai/examples/editorial-tri-tone/thumb.jpg" alt="editorial-tri-tone"></a></td>
<td width="33%"><a href="https://ppt.orca-studio.ai/examples/story-circle/"><img src="https://ppt.orca-studio.ai/examples/story-circle/thumb.jpg" alt="story-circle"></a></td>
</tr>
<tr>
<td><b>emerald-editorial</b><br>一变多 · 整页推近 · 形态变换 · 遮挡剪辑</td>
<td><b>editorial-tri-tone</b><br>共享元素 · 放大进元素内部 · 文字级匹配 · 原地替换</td>
<td><b>story-circle</b><br>推近式匹配剪辑 · 遮挡 · 形态变换</td>
</tr>
<tr>
<td><a href="https://ppt.orca-studio.ai/examples/spec-wall/"><img src="https://ppt.orca-studio.ai/examples/spec-wall/thumb.jpg" alt="spec-wall"></a></td>
<td><a href="https://ppt.orca-studio.ai/examples/forest-timeline/"><img src="https://ppt.orca-studio.ai/examples/forest-timeline/thumb.jpg" alt="forest-timeline"></a></td>
<td><a href="https://ppt.orca-studio.ai/examples/soft-editorial/"><img src="https://ppt.orca-studio.ai/examples/soft-editorial/thumb.jpg" alt="soft-editorial"></a></td>
</tr>
<tr>
<td><b>spec-wall</b><br>整页视频 · 匹配剪辑 · 形态变换 · 镂空聚焦</td>
<td><b>forest-timeline</b><br>形态变换 · 元素交接 · 横向时间线 · 横向条形图</td>
<td><b>soft-editorial</b><br>形态变换 · 多合一</td>
</tr>
</table>

照片由 AI 生成。

## 怎么用

装上 Orca PPT 桌面应用，把它的 MCP 接进你的 agent（见仓库根目录的 README），
然后直接说「做一份 PPT」「要苹果发布会那样的切换」，或者在首页挑一个同款点「做同款」。

不装应用、只想让 agent 用这套规范：

```bash
ln -s "$PWD/skills/orca-ppt" ~/.claude/skills/orca-ppt   # 在仓库根目录执行
(cd skills/orca-ppt && npm ci)
```

要做场景**内部**的 MG 动画（格子依次亮起、卡片弹出、数字滚动），
另配 [orca-motion-skill](https://github.com/zhenwusw/orca-motion-skill)。

## 产品分栏动画教学

[Drink showcase](examples/drink-showcase/index.html)：六页 HTML slides 复刻四栏产品切换与全屏展开。
[打开分步教程](examples/drink-showcase/tutorial.html)，可正常播放、慢放、查看各页状态并复制提示词。
配套 [制作说明](examples/drink-showcase/README.md) 和 [技能参考规范](references/product-showcase.md)。

## License

[MIT](LICENSE)
