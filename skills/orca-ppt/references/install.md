# OrcaPPT 应用:装上、连上、连不上时怎么办

本 skill 自己就能用:照 SKILL.md 做出一个 HTML 文件,浏览器打开就能放映,`capture.mjs` 能录成视频。
**OrcaPPT 是配套的桌面应用**,不是必需的。它多给的是:用户和你看着同一块画布、用户在画布上
点一处「指给你看」、改字能撤销、你改稿子时用户不会同时动它。

## 怎么判断连上了

你的工具列表里有 orca-ppt 的工具(`deck_status`、`edit_text`、`capture_slide`……)就是连上了。
拿不准就调 `doctor`:它报应用版本、skill 在哪、界面连没连上、开着哪些稿子。

## 连不上时

按顺序排查,每一步都要**告诉用户做什么**,别自己反复重试。

1. **应用开着吗?** MCP 由应用自己提供(`http://127.0.0.1:6722/mcp`),应用没开就连不上。
   请用户打开 OrcaPPT。
2. **MCP 加过没有?** 没加过就请用户加一次(在用户自己的终端里跑):

   ```bash
   claude mcp add --transport http orca-ppt http://127.0.0.1:6722/mcp
   codex mcp add orca-ppt --url http://127.0.0.1:6722/mcp
   ```

   其他宿主按 https://ppt.orca-studio.ai/llms.txt 里对应的一节加。
3. **应用刚重启过?** 有的宿主在应用重启的空档里连失败一次,之后就不再自己重试 ——
   应用早就好了,这边还显示断开。Claude Code 里请用户运行 `/mcp`,选 orca-ppt 重新连接。

连不上也不耽误做稿子:照 SKILL.md 的流程做,浏览器打开放映。

## 工具返回的错误码

以固定前缀开头的是**环境问题**,重试没用,得先让用户做点什么。前缀后面会写「下一步」,照做。

| 前缀 | 意思 | 该做什么 |
| --- | --- | --- |
| `NO_DECK_OPEN` | 应用里没打开稿子 | 请用户打开一份,或者用 `open_deck` 指定目录 |
| `MULTIPLE_DECKS` | 开着好几份,不知道是哪份 | 用 `open_deck` 指定 |
| `DECK_NOT_OPEN` | 指定的稿子没打开 | 先 `open_deck` |
| `NO_BUILD` | 稿子还没有成品(deck.html) | 按 `phase_prompt` 走到「出稿」 |
| `UI_DISCONNECTED` | 应用窗口没开 | 截图、缩略图、放映要靠窗口,请用户打开窗口 |
| `UI_TIMEOUT` | 窗口没有回应 | 请用户看看窗口是不是卡住了;可以先调 `doctor` |
| `SKILL_NOT_FOUND` | 应用找不到随附的规范 | 发布版请用户重装 OrcaPPT;开发时确认仓内 `skills/orca-ppt/` 在,或设置 `ORCA_PPT_SKILL`;`doctor` 列出了它找过的位置 |
| `READ_ONLY` | 这是同款样稿或示例,只读 | 不要改它。要做同款就新建一份自己的稿子,照 `read_skill` 读到的配方写 |
| `USER_IN_CONTROL` | 用户接管了稿子 | 立刻停下,告诉用户你停在哪一步,等他说继续 |
| `USER_STOPPED` | 用户停止了这件事 | 结束这一轮,不要继续 |

## 你不用调的工具

`recording_events`、`recording_snapshot` 是给宿主录制和回放用的,说明第一句写着「agent 不要调用」。
