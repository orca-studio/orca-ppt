/**
 * 「做同款」的提示词。界面右上角复制的就是它,用户贴进自己的 agent。
 *
 * **只写这一次独有的东西**:做哪个同款、样稿在哪、没连上怎么办、用户的内容。怎么做(读配方、
 * 从样稿起头、用哪个工具改、不编数据、截图自检)写在 skill 的 `references/remake.md` ——
 * 写在这里的话,skill 一改,用户手里已经复制出去的旧提示词还在教旧做法。
 * 品味在样稿和 RECIPE.md 里,配方的结构和动效原则一个字都不抄进来。
 * 内容槽位是 server 从配方的「内容槽位」表里原样读出来的,不是这里写的。
 */
export interface RecipeRef {
  id: string
  title: string
  summary?: string | undefined
  /** 样稿目录,相对 skill 根(`examples/drink-showcase`)。不给就是配方目录本身。 */
  sample?: string | undefined
  /** 配方「内容槽位」表第一列,给用户列一张要贴什么的清单。读不到就不列。 */
  slots?: string[] | undefined
}

/**
 * 用户的 agent 没连上 Orca PPT 时照着做、做不到就转告的那一句。和 README、帮助菜单
 * 「连接 AI 助手」同一句:各家加 MCP 的步骤写在 llms.txt 里,这里不按助手列命令。
 */
const CONNECT =
  '读 https://ppt.orca-studio.ai/llms.txt ，帮我装好 Orca PPT 应用，并把你自己连上它。'

export function recipePrompt(recipe: RecipeRef): string {
  const dir = `recipes/${recipe.id}`
  const sample = recipe.sample ?? dir
  const what = recipe.summary ? `「${recipe.title}」—— ${recipe.summary}` : `「${recipe.title}」`
  const slots = recipe.slots?.length
    ? `我的内容(按配方的内容槽位,缺的空着):
${recipe.slots.map((slot) => `- ${slot}:`).join('\n')}

其他材料:
`
    : `我的内容:
(在这里贴上主题、每页要讲的内容、名单等材料)
`
  return `用 Orca PPT 帮我做一份同款:${what}
同款 \`recipe:${recipe.id}\`,配方 \`${dir}/RECIPE.md\`,样稿 \`${sample}/index.html\`。

先看你的工具里有没有 orca-ppt(read_skill、open_deck),或者本机有没有 \`orca-ppt\` 命令。都没有就先别做,照这句话装好、连上:
${CONNECT}
你自己做不到就把这句话原样转告我。不要凭印象做。
连上之后读 skill 里的 \`references/remake.md\`,照它做。我没给的人名和数据不要编。

${slots}`
}
