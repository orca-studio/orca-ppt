# 工作台:用 `orca-ppt` 命令

本机装了 `orca-ppt` 命令(`orca-ppt --version` 有输出)时,在工作台里做稿:用户在浏览器里看着同一块画布,
你改哪里画布就框出哪里,改错了能用 `undo` 退回去。没有这个命令也不耽误,照 SKILL.md
做出 HTML,浏览器打开放映。

你的工具列表里已经有 orca-ppt 的工具(配过 MCP)时,直接用那些工具,不用这份里的命令,规则一样。

## 开工作台

每次用之前先跑一遍,不用请用户做什么:

```
orca-ppt serve --detach --no-open
```

它放到后台常驻,打印工作台的网址;已经在跑就只打印它的网址。

- **你有自带的浏览器就用它打开这个网址**,用户在你旁边就能看到工作台;没有就跑
  `orca-ppt serve --detach`(不带 `--no-open`),它会用 Chrome 或 Edge 打开。
- 网址里的令牌每次启动都换:用这次打印的,别用记着的旧网址(旧网址打开会说连不上)。
- 请用户把工作台留在前台:标签页在后台,浏览器会限速,你截图、等画布都会变慢。
- 用完不用停;要停就 `orca-ppt stop`。
- 6722 端口被 OrcaPPT 桌面版占着时 `serve` 起不来:不用起,下面的 `orca-ppt call` 照样操作开着的桌面版。

## 读用法,然后操作

```
orca-ppt tools
```

打印工作台的使用说明和全部工具(和桌面版 MCP 的是同一份)。说明里的规则照做 —— 改稿子前先
`take_control`、做完 `hand_off`;返回 `USER_IN_CONTROL` 就停下;改字先 `deck_status` 读原文……

之后用 `orca-ppt call <工具> 参数` 调。参数三种写法:

```
orca-ppt call show_slide index=2                  # key=value,值按 JSON 读,读不了就当字符串
orca-ppt call show_slide '{"index":2}'            # 一个 JSON 对象
echo '{"index":2}' | orca-ppt call show_slide -   # 从标准输入读 JSON
```

Windows 的 PowerShell 会吃掉参数里的双引号,在那里用 `key=value` 或标准输入;值里要嵌对象时用标准输入。

- 工具报错时退出码是 1,原因照原文打出来;大写前缀的错误(`NO_DECK_OPEN`、`USER_IN_CONTROL`、
  `NO_BROWSER`……)按 `install.md` 的错误码表处理。
- 返回的图片存成文件、打印路径(`图片:<路径>`),要看画面就读那个文件。
- 加 `--json` 拿到机器可读的结果。

## 怎么开始

用户还没说要做什么时:请他在工作台首页挑一个同款点「做同款」,把复制的那段话发给你;或者直接说要做
什么稿子。稿子怎么做照 SKILL.md 的流程;新建、打开、改动尽量经 `orca-ppt call`(`create_deck`、
`open_deck`、`edit_text`、`write_page`……)—— 画布会翻到那一页、框出改动,改错了能 `undo`。
直接改文件画布也会刷新,但不框改动、不能撤销。
