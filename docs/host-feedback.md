# Host operation feedback

MCP tools expose localized `title` values and standard JSON Schema property titles for common text, navigation and deck operations. `x-jevbot-format: one-based-index` lets the host display page 1 while passing the unchanged protocol value 0. Text replacements expose the original and replacement text separately.

`visual_target` has been replaced by `resolve_ui_targets` (`studio.orca/ui-targets` v1, see MCP.md). Its results carry stable `targetId`s that can be queried again as `controlId`; resolving never navigates the deck or renews control.

`take_control` accepts optional `renew: true`. A renewal is refused while the user holds control or has stopped the agent. Only an explicit new user task may take control again without that renewal flag. Both MCP and the manual UI continue through the shared protocol and control state.
