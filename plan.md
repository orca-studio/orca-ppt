# 接下来的计划

2026-09-24。按先后排;每一项写清在等什么、做到什么程度算完。
长期方向见 [docs/ROADMAP.md](./docs/ROADMAP.md),决策见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 1. 在等别人

- [ ] **和 Jevbot 联调「可录制应用」约定。** 约定草案在 jevbot-mac `docs/recordable-app-contract.md`,
      orca-ppt 这一侧已实现(`23b74df`)。等 Jevbot 做完它那边的时间线、联调出问题再改。
      **完成:** 联调通过、约定定稿;定稿有改动时同步改 `recording.ts` 和两个 `recording_*` 工具。

## 2. 发布前必须做(交付形态)

决策已记在 ARCHITECTURE「交付形态」:app + MCP + skill 同一个版本号一起交付。

- [ ] **打包配置。** 现在没有任何打包配置(electron-builder 之类)。发布版要把 orca-ppt-skill
      复制进 `Resources/skill`(orca-motion-skill 不带,app 不读它);壳已经会把这个路径
      通过 `ORCA_PPT_BUNDLED_SKILL` 告诉 server。
- [ ] **首次引导。** 先问人,同意后只链 `~/.agents/skills` 和 `~/.claude/skills`;软链三层
      (各家目录 → `~/.local/share/orca-ppt/skill` → 当前版本),升级只换最后一根。
      顺带引导把 MCP 加进用户的 agent。
- [x] **`doctor` 诊断工具。** 协议方法 `app.doctor` 加 MCP 工具 `doctor`:app 版本、skill 路径和
      来源(explicit / bundled / local / missing)及找过的位置、界面连没连上、开着哪些稿子、操作记录。
- [x] **skill 里加 `references/install.md`。** 连不上时按顺序排查、错误码表;SKILL.md 指过去。
- [x] **错误码带下一步。** `agent-errors.ts`:`NO_DECK_OPEN` / `MULTIPLE_DECKS` / `DECK_NOT_OPEN` /
      `NO_BUILD` / `UI_DISCONNECTED` / `UI_TIMEOUT` / `SKILL_NOT_FOUND`,格式「前缀:原因。下一步:…」。
      界面不在时截图立刻报 `UI_DISCONNECTED`,不再干等 15 秒。
- [x] **MCP 的版本号跟着版本走。** 握手报 app 的真实版本(壳用 `ORCA_PPT_APP_VERSION` 传给 server)。
      **使用说明不从 skill 读:** 那段讲的是这个应用的工具怎么用(控制权、改字、撤销),属于 MCP 接口
      而不是规范内容;skill 已经跟着 app 发版,写在 app 里版本本来就对得上。

## 3. 要看过画面再定

都需要录出来并排看,是看出来的事,不是算出来的。录制可以用 `capture.mjs`(`--interrupt` 已有)。

- [ ] **一变多、多合一的缓动**:现在是 `power3.inOut`,共享元素和文字级匹配是 `power2.inOut`。
      要不要统一。(见 skill `references/transitions.md`「缓动曲线」)
- [ ] **中途打断时的快进时长**:引擎 `FINISH_S` 现在 0.15 秒,快进第一帧变化很大。嫌猛就调长。
- [ ] **两个 skill 的镜头曲线对齐**:orca-motion-skill `references/principles.md` 写「镜头用
      `power3.inOut`」,和 ppt-skill 引擎的结论(`power3` 起步太慢)相反。改那边。

## 4. 有需要再做

- [ ] **`recording_restore`(预览 / 恢复到某一步)。** 约定里是可选的。要先存下每个版本的
      完整内容,现在只有改字有前后快照,而且只在内存里。
- [ ] **事件日志覆盖更多操作。** 现在记改字、撤销、重做和外部修改;阶段产物(`.deck/*.json`)
      被 agent 直接写的只落成 external。视图操作(翻页)约定里是可报可不报,v1 没报。
- [ ] **应用内要不要「经过」时间线。** 回放的主体定在 Harness;orca-ppt 自己要不要一个轻量的
      时间线(点一步看当时的稿子),等 Jevbot 那边的时间线做出来再判断会不会重复。
- [ ] **慢 GPU 下的转场。** 逐帧改尺寸只在 CPU 限速 6 倍下测过(稳 60 帧),没测真机投屏、
      没模拟慢 GPU。有人反馈卡顿再测。

## 5. 文档欠账

- [x] ARCHITECTURE 里「事件日志(SQLite)」改成实际的 JSONL,变更表记了一行;顺带删掉
      「录制 job」的残留说法(录制导出 09-20 已否掉)。
- [x] ROADMAP 的「已知欠账」去掉已经不成立的两条;M4 里写清 `--interrupt` 和否掉的录制导出不是一回事。
- [ ] **deck 和 skill 之外的引用会 403**(ROADMAP 已知欠账里原有的一条,还在)。

## 6. 待定:server 要不要活得比窗口久

ARCHITECTURE 说「关掉窗口,server 还在」,但壳在最后一个窗口关掉时就停 server
(`apps/desktop/src/main.ts` 的 `window-all-closed`),MCP 跟着断 —— agent 那头正在做的事会失败。
二选一:改代码让 server 在 macOS 上活到应用退出(窗口关了 agent 照样能用,但没有画布,截图会失败);
或者改文档,承认「窗口在,服务才在」。
