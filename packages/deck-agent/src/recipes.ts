/**
 * 「做同款」的提示词。界面右上角复制的就是它,用户贴进自己的 agent。
 *
 * **品味在 skill 的 RECIPE.md 里,不在这里** —— 这段话只做三件事:指到配方、留出用户贴
 * 内容的位置、把配方之外的通用底线说一遍(不适用就直说、不编人名数据、做完自检)。
 * 配方的结构和动效原则一个字都不抄进来,否则 skill 改了配方,这里还是旧的。
 */
export interface RecipeRef {
  id: string
  title: string
  summary?: string | undefined
  /** 样稿目录,相对 skill 根(`examples/drink-showcase`)。不给就是配方目录本身。 */
  sample?: string | undefined
}

/** 用户的 agent 没连上 Orca PPT 时,提示词里要转告的两步。地址和 README、install.md 一致。 */
const PROJECT = 'https://github.com/orca-studio/orca-ppt'
const MCP_URL = 'http://127.0.0.1:6722/mcp'

export function recipePrompt(recipe: RecipeRef): string {
  const dir = `recipes/${recipe.id}`
  const sample = recipe.sample ?? dir
  const what = recipe.summary ? `「${recipe.title}」—— ${recipe.summary}` : `「${recipe.title}」`
  return `用 Orca PPT 帮我做一份同款:${what}

0. 先看你的工具里有没有 orca-ppt(read_skill、open_deck)。没有就先别做,把这两步转告我:
   - 装上并打开 Orca PPT 桌面应用:${PROJECT}
   - 应用开着时,把 MCP 地址 ${MCP_URL} 加到你身上(名字填 orca-ppt),比如
     Claude Code:claude mcp add --transport http orca-ppt ${MCP_URL}
     Codex:codex mcp add orca-ppt --url ${MCP_URL}
   连上之后再从第 1 步开始。不要凭印象做。
1. 调 read_skill 读 \`recipes/README.md\`,再读 \`${dir}/RECIPE.md\`,按配方的顺序做。
   样稿在 \`${sample}/index.html\`,是给你看手法和分寸的,不是让你改字。
2. 先对照配方的「适用 / 不适用」看我的内容。不适合就直接告诉我为什么,别硬套。
3. 缺的细节你自己定,把假设写进转场计划注释里。不要编人名和数据,没有的留占位。
4. 做完用 open_deck 在 Orca PPT 里打开,按配方的「自检」过一遍再交给我。

我的内容:
(在这里贴上主题、每页要讲的内容、名单等材料)
`
}
