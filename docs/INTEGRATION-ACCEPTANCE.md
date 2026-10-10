# Jevbot 联调验收（2026-10-01）

本次使用本地打包的 Apple Silicon OrcaPPT.app 和 Jevbot 的 CLI 入口连接真实模型。CLI 使用 Jevbot 的运行时、工具和审批流程；本次不包含 Jevbot 聊天窗口的视觉验收。

## 结果

- Codex：读取 Skill、列出模板、创建和打开独立测试 deck、修改标题、截图、撤销成功。
- Claude：在修复后重新打包的应用上完成同样闭环；主题正确呈现，撤销恢复原 revision，初始 currentSlide 为 0。
- DeepSeek Harness：在最终包上读取 Skill、模板、当前文档状态和截图成功；此轮仅做只读验证。
- 打包应用 doctor 确认使用 bundled Skill；Skill 取自打包时那个提交的 `skill/`，不读取工作区里的未提交修改。
- 手动切换文档后，原 MCP 目标返回 DOCUMENT_CHANGED；显式 open_deck 后可以继续。
- 用户点击接管后，Agent 导航返回 USER_IN_CONTROL；手动键盘翻页正常，交还后 MCP 读到 currentSlide 为 1。
- MCP 重播执行成功，最终页面和上报页码一致。验收结束已 hand_off。

测试文件均位于 /tmp/jevbot-orca-acceptance-20261001，没有修改用户文稿。

## 联调发现与修复

1. 模板中注释内的示例 link 导致主题样式被插入注释。改为在 head 末尾插入样式，并增加回归测试。
2. 单页文档初次加载没有上报页码。Stage 加载后读取 Reveal 当前索引并上报。

## 自动验证与交付范围

使用 Node 24.21：typecheck、464 项测试（40 个文件）、lint、打包均通过。

本地产物位于 release/OrcaPPT-darwin-arm64/OrcaPPT.app，未签名、公证或发布，应用版本仍为 0.0.0。未进行完整转场视觉时序验收，也不代表任意长标题均能自动排版。
