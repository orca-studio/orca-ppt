# Host operation feedback

MCP tools expose localized `title` values and standard JSON Schema property titles for common text, navigation and deck operations. `x-jevbot-format: one-based-index` lets the host display page 1 while passing the unchanged protocol value 0. Text replacements expose the original and replacement text separately.

`visual_target` supports stable `targetId` tracking. During `phase: track`, resolving the target does not navigate the deck or renew control. Switching deck, removing the target or losing its visible geometry makes tracking unavailable.

`take_control` accepts optional `renew: true`. A renewal is refused while the user holds control or has stopped the agent. Only an explicit new user task may take control again without that renewal flag. Both MCP and the manual UI continue through the shared protocol and control state.
