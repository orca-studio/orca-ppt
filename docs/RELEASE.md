# 打包、公证与发布

结构照 [orca-studio/Compositor](https://github.com/orca-studio/Compositor) 的
`docs/release-workflows.md`:两个手动 GitHub Actions,**提交公证和发布分开**,不让 runner
干等 Apple。区别是打包工具换成 Electron 的,自动更新用 Electron 官方的
`update.electronjs.org`,不用 Sparkle。

## 版本

- 版本号在 `apps/desktop/package.json` 的 `version`,从 `0.1.0` 开始,按小版本迭代(0.1.1、0.1.2……)。
- tag 写成 `v<版本>`(例如 `v0.1.0`),必须和 `version` 一致,发布脚本会核对。
- 构建号(bundle 的 `CFBundleVersion`)打包时自动取提交总数,不用手动维护,「关于」里不显示。
- Bundle ID 是 `ai.orca-studio.ppt`。**发过版之后不能改**,自动更新靠它认出是同一个应用。

## 产物

| 文件                              | 给谁                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `OrcaPPT-<版本>-arm64.dmg`        | 第一次安装:打开后把应用拖进 Applications              |
| `OrcaPPT-darwin-arm64-<版本>.zip` | 自动更新:`update.electronjs.org` 按文件名认平台和架构 |
| `SHA256SUMS.txt`                  | 校验                                                  |

应用开着时每小时问一次 `update.electronjs.org`,它读本仓的 GitHub Releases(只认公开、非草稿、
semver tag 的 Release),有新版就下载,下次启动替换。只在发布版里开,见 `apps/desktop/src/main.ts`。

## 打包时做了什么(`tools/package.mjs` + `tools/release-mac.mjs`)

1. esbuild 打 desktop 和 server,带上网页、从当前提交取出的 `skills/orca-ppt/`,用 `@electron/packager` 出 `.app`,
   图标从 `apps/desktop/assets/icon.png` 生成。
2. **签名前**关掉几个 Electron 开关(fuses):RunAsNode、`NODE_OPTIONS`、命令行调试参数;打开 Cookie 加密。
   server 用 `utilityProcess` 起,不需要 RunAsNode。
3. `@electron/osx-sign` 用 Developer ID 签名,逐层签 Helper 和 Framework,开 Hardened Runtime,
   权限见 `apps/desktop/build/entitlements.mac.plist`。核对团队、Hardened Runtime、时间戳。
4. 用同一个签好的 `.app` 做 zip(`ditto`)和 dmg(`hdiutil`,带 Applications 快捷方式),给 dmg 签名。
5. `notarytool submit` 提交 dmg(一次提交覆盖里面的应用),**不等结果**,提交号记进 `release.json`。
6. finalize:查一次结果。通过后给 dmg 和 zip 里的应用 staple,做 Gatekeeper 检查,写 `SHA256SUMS.txt`。

## 一次性配置

和 Compositor 用同一个 Apple 团队和 Developer ID 证书(同一个团队的应用可以共用)。

在本仓 **Settings → Environments** 建一个 `release` Environment(建议限制只能从 `main` 部署、
加上必须审批),把下面这些配进去:

| 类型     | 名称                           | 内容                                            |
| -------- | ------------------------------ | ----------------------------------------------- |
| Variable | `APPLE_TEAM_ID`                | `R2MFZSZP4R`                                    |
| Secret   | `APPLE_CERTIFICATE_P12_BASE64` | 含私钥的 Developer ID Application P12 的 Base64 |
| Secret   | `APPLE_CERTIFICATE_PASSWORD`   | P12 导出密码                                    |
| Secret   | `APPLE_ID`                     | 有该团队公证权限的 Apple ID                     |
| Secret   | `APPLE_APP_SPECIFIC_PASSWORD`  | Apple 专用密码,不是账号密码                     |

这四个 Secret 和 Compositor 的 `.env` 里同名的是同一套值,可以直接用 `gh` 从那份文件读出来上传
(值不会显示在终端里):

```sh
cd ~/ghq/github.com/orca-studio/Compositor
for name in APPLE_CERTIFICATE_P12_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD; do
  python3 -c "import re,sys;print(dict(re.findall(r'^(\w+)=\"?(.*?)\"?$',open('.env').read(),re.M))[sys.argv[1]],end='')" "$name" \
    | gh secret set "$name" --env release --repo orca-studio/orca-ppt
done
gh variable set APPLE_TEAM_ID --env release --repo orca-studio/orca-ppt --body R2MFZSZP4R
```

发布用本仓自己的 `GITHUB_TOKEN`(工作流里 `contents: write`),不需要额外的 PAT ——
和 Compositor 不同,我们的源码和发布在同一个公开仓库。

## 每次发布

1. 本机:改 `apps/desktop/package.json` 的 `version`,跑 `pnpm typecheck && pnpm test && pnpm lint`,提交到 `main`。
2. 打 tag 并推送:

   ```sh
   git tag -a v0.1.0 -m 'Orca PPT 0.1.0'
   git push origin main refs/tags/v0.1.0
   ```

3. Actions → **Build and submit notarization** → Run workflow,`tag` 填 `v0.1.0`。
   成功只表示打包和提交成功,不表示 Apple 已经通过。记下这次的 Run ID(URL 里 `/actions/runs/数字`)。
4. 过几分钟,Actions → **Publish Orca PPT**,`build_run_id` 填上一步的 Run ID:
   - Apple 还在处理:正常结束,没有发布,稍后再跑一次;
   - 公证被拒:失败,日志里有 Apple 给的原因;
   - 通过:staple、检查、发 Release(dmg、zip、SHA256SUMS.txt),再匿名下载回来核对摘要。
5. 下载公开的 dmg 装一次,确认能打开、版本对。从第二个版本起,用上一版验证一次自动更新。

## 本机试打

钥匙串里有 Developer ID 证书就能在本机试到 dmg,跳过公证:

```sh
APPLE_TEAM_ID=R2MFZSZP4R SKIP_NOTARIZE=1 node tools/release-mac.mjs build
```

产物在 `dist/release/`。没公证的应用,Gatekeeper 会判定为「Unnotarized Developer ID」,
自己用可以,不能发给别人。要在本机连公证一起跑,先用 `xcrun notarytool store-credentials` 存一份凭据,
再加 `NOTARY_PROFILE=<名字>`。
