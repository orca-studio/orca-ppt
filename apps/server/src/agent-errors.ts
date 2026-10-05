/**
 * 给 agent 的环境类错误:重试没用,得先让人做点什么(开窗口、开稿子、装 skill)。
 *
 * 写法和 USER_IN_CONTROL 一样:`固定前缀:原因。下一步:…。`
 * - 前缀给宿主认 —— 宿主可以不经模型就知道「这是环境问题」,比如直接提示用户开窗口;
 * - 「下一步」给模型读 —— 不说下一步的话,它多半会原样重试,或者自己编一个理由。
 *
 * 只收环境类的。「原文对不上」「没有可撤销的」这类是这次调用本身的问题,
 * 理由已经说清楚了,不加前缀。
 */
const say = (code: string, why: string, next: string) => `${code}:${why}。下一步:${next}。`

export const AgentError = {
  noDeckOpen: () =>
    say(
      'NO_DECK_OPEN',
      '应用里还没打开稿子',
      '让用户在 Orca PPT 里打开一份,或者用 open_deck 指定目录',
    ),
  multipleDecks: (paths: string[]) =>
    say('MULTIPLE_DECKS', `应用里开着好几份稿子:${paths.join('、')}`, '用 open_deck 指定是哪一份'),
  deckNotOpen: () => say('DECK_NOT_OPEN', '这份稿子还没打开', '先用 open_deck 打开它'),
  noBuild: () =>
    say('NO_BUILD', '这份稿子还没有出稿文件', '先按 phase_prompt 走到「出稿」,生成 deck.html'),
  uiDisconnected: () =>
    say(
      'UI_DISCONNECTED',
      'Orca PPT 的窗口没开 —— 截图、缩略图、放映都要靠它',
      '请用户打开 Orca PPT 的窗口,再试一次',
    ),
  uiTimeout: () =>
    say(
      'UI_TIMEOUT',
      'Orca PPT 的界面没有回应',
      '请用户确认窗口开着、没有卡住;doctor 能看连接状态',
    ),
  skillNotFound: () =>
    say(
      'SKILL_NOT_FOUND',
      '找不到 orca-ppt-skill,没有模板和规范可用',
      '让用户安装 orca-ppt-skill,或者设置环境变量 ORCA_PPT_SKILL 指向它;doctor 能看它在哪些位置找过',
    ),
}

/** 已经带了前缀的理由,原样交给 agent,不要再在前面套一层「没改:」—— 前缀得在开头宿主才认得出。 */
export const hasAgentCode = (text: string): boolean => /^[A-Z][A-Z_]+:/.test(text)
