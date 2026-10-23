# 官网 ppt.orca-studio.ai

产品介绍页 + 所有同款的封面和在线样稿（点卡片弹窗放映）+ 下载入口。

```bash
node site/build.mjs           # 构建到 site/dist(要 ffmpeg,把样稿里的大 PNG 转 JPEG)
npx serve site/dist           # 本地看
```

- 页面在 `src/`;同款卡片、首屏由 `build.mjs` 从 `skills/orca-ppt/recipes/*/RECIPE.md` 生成,
  封面用同款自带的 `poster`,加同款不用改官网。不录样片:点卡片弹出放映窗口,放的就是样稿本身。
- 下载按钮指向 `releases/latest/download/OrcaPPT-mac-arm64.dmg`,发布工作流每次都会传这个固定名字。
- main 上 `site/` 或同款样稿有改动时,`.github/workflows/site.yml` 自动部署到 Cloudflare。
- `src/_headers` 是 Cloudflare 的响应头配置:`llms.txt` 要带 `charset=utf-8`,不然浏览器里中文是乱码。
- 交流群是企业微信群,二维码不过期。图只有一份:`src/contact/wecom-group-qrcode.jpg`,
  官网和根目录 `README.md` 都引它。联系方式沿用 Jevbot 的(X、微信、交流群)。
