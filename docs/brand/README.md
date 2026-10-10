# Orca PPT 品牌与宣传素材

定位：和 AI 一起，把想法做成演示稿。连接用户自己的 AI agent，支持构思、制作、放映和带位置的修改意见。

## 主标志：应用图标

深墨绿圆角底板，白色幻灯片叠放，页内短线表示内容排版，亮绿四角星表示 AI 辅助创作。
所有地方都用这一个图标，不另外维护矢量标志或字标。虎鲸只作可选吉祥物，不作主标志。

| 文件                            | 用途                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `orca-app-icon.png`             | 1024 × 1024 源图（四周带透明边）。下面这些都由它派生，改图标只改它，再重新派生  |
| `orca-app-icon-imagegen-v1.png` | imagegen 的原始候选，提示词在 `app-icon-prompt.txt`                             |
| `social-card-1200x630.png`      | 分享卡片：官网的 og:image、README 顶部横幅。排版源文件是 `src/social-card.html` |
| `orca-mascot-avatar.png`        | 可选的 3D 虎鲸吉祥物，提示词在 `mascot-prompt.md`。不用于产品主标志             |

由 `orca-app-icon.png` 派生的文件（裁到底板再缩放）：

| 派生文件                                                                                | 用在哪                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/desktop/assets/icon.png`                                                          | 桌面应用图标（macOS 留白，824 居中加投影） |
| `apps/web/public/brand/orca-icon.png`                                                   | 应用界面的浏览器图标（256）                |
| `site/src/brand/orca-icon.png`、`site/src/favicon.ico`、`site/src/apple-touch-icon.png` | 官网                                       |
| `docs/brand/src/orca-icon.png`                                                          | 分享卡片排版用                             |
| `apps/server/src/mcp-http.ts` 里的内联图标                                              | MCP 连接时给宿主显示的图标（256）          |

## 改分享卡片

1. 改 `src/social-card.html` 的文案或画面（`src/still-*.jpg` 是两份同款样片的封面帧）。
2. 用浏览器按 1200 × 630 截图，覆盖 `social-card-1200x630.png`。
3. 拷一份到 `site/src/brand/`（官网的 og:image 用它）。

## 品牌色

墨黑 `#151918`、绿色 `#16a34a`、浅绿 `#ccebd6`、白色 `#ffffff`。应用图标底板是深墨绿 `#12372b`。

## 文案

- 主标题：和 AI 一起，把想法做成演示稿。
- 说明：连上你的 AI 助手，做出会动的演示稿。看到喜欢的效果，一键做同款。
- 产品生成 HTML 演示稿；不要宣传成已支持导出 PowerPoint `.pptx`、录制视频或内置独立模型。
