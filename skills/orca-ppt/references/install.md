# Orca PPT 桌面版:连上、连不上时怎么办

本 skill 自己就能用:照 SKILL.md 做出一个 HTML 文件,浏览器打开就能放映。本机有 `orca-ppt` 命令时,
照 `workbench.md` 用浏览器工作台,不用配 MCP —— 这是默认的用法。

**Orca PPT 桌面版**是增值的选择:全屏放映、离线、本地字体和素材都在一个应用里。它和浏览器工作台是
同一块画布:用户和你看着同一份稿子、你改哪里画布就框出哪里、改错了能用 `undo` 退回去。
桌面版通过 MCP 连接,下面是怎么连。

这份文档也发布在 https://ppt.orca-studio.ai/connect-desktop.txt ,桌面版菜单「帮助 > 连接 AI 助手」
给用户的那句话指向它。

## 连上桌面版

1. **桌面版要开着。** MCP 跟着应用走,在 `http://127.0.0.1:6722/mcp`(Streamable HTTP,本机,无鉴权);
   GET 它返回 406 就是在跑。没装就请用户从 https://ppt.orca-studio.ai 下载安装。
2. **加 MCP**,名字一律 `orca-ppt`。改配置文件前先读原文件、留备份,只加这一条;
   要用户「批准 / 信任」的,让用户自己点,别改批准记录。

   - **Claude Code**:`claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp`
   - **Codex**:`codex mcp add orca-ppt --url http://127.0.0.1:6722/mcp`
   - **WorkBuddy**:写进 `~/.workbuddy/mcp.json`,已有文件就往 `mcpServers` 里加:

     ```json
     {
       "mcpServers": {
         "orca-ppt": { "type": "streamableHttp", "url": "http://127.0.0.1:6722/mcp", "timeout": 300000 }
       }
     }
     ```

     然后请用户:重启 WorkBuddy → 侧边栏「专家 · 技能 · 连接器」→「连接器」→「自定义连接器」→
     「MCP 服务管理」,在「我的 MCP」里找到 `orca-ppt` 点「信任」→ 新建任务再用(旧任务里看不到工具)。

   - **其他助手**:在 MCP 设置里加,名字 `orca-ppt`,HTTP / Streamable HTTP,地址同上。
     只支持 stdio 的接不上,如实告诉用户,改用浏览器工作台(https://ppt.orca-studio.ai/llms.txt)。

3. **请用户重启你**(或新开会话 / 任务)。
4. **验证**:调 `deck_status`,返回 `NO_DECK_OPEN` 或页数都算连上了。

## 怎么判断连上了

你的工具列表里有 orca-ppt 的工具(`deck_status`、`edit_text`、`capture_slide`……)就是连上了。
拿不准就调 `doctor`:它报应用版本、skill 在哪、界面连没连上、开着哪些稿子。

## 连不上时

按顺序排查,每一步都要**告诉用户做什么**,别自己反复重试。

1. **应用开着吗?** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6722/mcp`(Windows 用 `curl.exe`),
   406 就是在跑。连不上多半是用户把应用退出了:macOS 上关掉窗口不断,⌘Q 退出才断;Windows 上关掉最后一个窗口就断。
   没开就打开(macOS `open -a "Orca PPT"`;Windows `Start-Process "$env:LOCALAPPDATA\OrcaPPT\OrcaPPT.exe"`),
   等到返回 406。
2. **MCP 加过没有?** 没加过就照上面「连上桌面版」加一次。
3. **应用刚重启过?** 有的宿主在应用重启的空档里连失败一次,之后就不再自己重试 ——
   应用早就好了,这边还显示断开。先直接再调一次工具;不通就请用户动手:Claude Code 里运行 `/mcp`,
   选 orca-ppt 重新连接;WorkBuddy、Codex 等新建任务 / 新开会话。

连不上也不耽误做稿子:本机有 `orca-ppt` 命令就照 `workbench.md` 用命令操作工作台(桌面版开着时,
`orca-ppt call` 操作的就是桌面版);没有就照 SKILL.md 的流程做,浏览器打开放映。

## 工具返回的错误码

以固定前缀开头的是**环境问题**,重试没用,得先让用户做点什么。前缀后面会写「下一步」,照做。

| 前缀 | 意思 | 该做什么 |
| --- | --- | --- |
| `NO_DECK_OPEN` | 应用里没打开稿子 | 请用户打开一份,或者用 `open_deck` 指定目录 |
| `MULTIPLE_DECKS` | 开着好几份,不知道是哪份 | 用 `open_deck` 指定 |
| `DECK_NOT_OPEN` | 指定的稿子没打开 | 先 `open_deck` |
| `NO_BUILD` | 稿子还没有成品(deck.html) | 按 `phase_prompt` 走到「出稿」 |
| `UI_DISCONNECTED` | 应用窗口没开 | 截图、放映要靠窗口,请用户打开窗口 |
| `NO_BROWSER` | 不开桌面版时(浏览器版、CLI)系统里没有 Chrome 或 Edge | 装上 Google Chrome 再试,不用重启 |
| `NO_RENDERER` | 运行环境里没有能渲稿子的浏览器 | 缩略图、导出 PPTX 做不了,请用户在 Orca PPT 桌面版里打开稿子再试 |
| `UI_TIMEOUT` | 窗口没有回应 | 请用户看看窗口是不是卡住了;可以先调 `doctor` |
| `SKILL_NOT_FOUND` | 应用找不到随附的规范 | 发布版请用户重装 Orca PPT;开发时确认仓内 `skills/orca-ppt/` 在,或设置 `ORCA_PPT_SKILL`;`doctor` 列出了它找过的位置 |
| `READ_ONLY` | 这是同款样稿或示例,只读 | 不要改它。要做同款就新建一份自己的稿子,照 `read_skill` 读到的配方写 |
| `USER_IN_CONTROL` | 用户接管了稿子 | 立刻停下,告诉用户你停在哪一步,等他说继续 |
| `USER_STOPPED` | 用户停止了这件事 | 结束这一轮,不要继续 |

## 你不用调的工具

`recording_events`、`recording_snapshot` 是给宿主录制和回放用的,说明第一句写着「agent 不要调用」。
