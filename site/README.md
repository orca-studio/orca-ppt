# 官网 ppt.orca-studio.ai

产品介绍页 + 所有同款的样片和在线样稿 + 下载入口。

```bash
node site/build.mjs           # 用 site/.cache 里录好的样片构建到 site/dist
node site/build.mjs --media   # 缺的样片现录(要本机 Chrome 和 ffmpeg)
npx serve site/dist           # 本地看
```

- 页面在 `src/`;同款卡片、首屏视频由 `build.mjs` 从 `skills/orca-ppt/recipes/*/RECIPE.md` 生成,
  加同款不用改官网。
- 下载按钮指向 `releases/latest/download/OrcaPPT-mac-arm64.dmg`,发布工作流每次都会传这个固定名字。
- main 上 `site/` 或同款样稿有改动时,`.github/workflows/site.yml` 自动部署到 Cloudflare。
- 微信群二维码会过期:换 `src/contact/wechat-group-qrcode.png` 时,一起改 `index.html` 里写的有效期。
  联系方式沿用 Jevbot 的(X、微信、交流群),README 只放不过期的那两个,入群链到官网。
