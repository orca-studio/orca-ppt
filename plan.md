# 接下来的计划

2026-09-24 写,10-28 清过一遍。按先后排;每一项写清在等什么、做到什么程度算完。
长期方向见 [docs/ROADMAP.md](./docs/ROADMAP.md),决策见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 1. 在等别人

(空。原来的「和 Jevbot 联调可录制应用约定」撤掉:10-19 起 Jevbot 是另一条线,orca-ppt 不再跟它联调。
`recording_*` 工具和 `recording.ts` 留着,不再为它改。)

## 2. 发布前必须做(交付形态)

决策已记在 ARCHITECTURE「交付形态」:app + MCP + skill 同一个版本号一起交付。

- [x] **打包配置。** `pnpm package` 固定 Skill Git 提交并复制到 Resources/skill，包含锁定依赖和 bundle-manifest；正式签名、公证仍待完成。
- [x] **MCP 按需读取 Skill。** list_skill / read_skill 提供受限相对路径、分页文本读取，phase_prompt 指向此入口。
- [x] ~~**首次引导。**~~ 不做:装应用、连 MCP、链 skill 都交给 AI 助手按 llms.txt 做,应用里不替别家写配置。
      各家目录链到稳定路径 `~/.local/share/orca-ppt/skill`(`4e0f798`),升级只换它指向哪里。
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

- [x] **一变多、多合一的缓动**:10-28 左右并排放过,定为 `power2.inOut`,和共享元素、文字级匹配统一。
- [ ] **中途打断时的快进时长**:引擎 `FINISH_S` 现在 0.15 秒,快进第一帧变化很大。嫌猛就调长。
- [ ] **两个 skill 的镜头曲线对齐**:orca-motion-skill `references/principles.md` 写「镜头用
      `power3.inOut`」,和 ppt-skill 引擎的结论(`power3` 起步太慢)相反。改那边。

## 4. 有需要再做

- [ ] **`recording_restore`(预览 / 恢复到某一步)。** 约定里是可选的。要先存下每个版本的
      完整内容,现在只有改字有前后快照,而且只在内存里。
- [ ] **事件日志覆盖更多操作。** 现在记改字、撤销、重做和外部修改;阶段产物(`.deck/*.json`)
      被 agent 直接写的只落成 external。视图操作(翻页)约定里是可报可不报,v1 没报。
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
