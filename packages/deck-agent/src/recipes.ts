/**
 * 「做同款」的提示词。界面右上角复制的就是它,用户贴进自己的 agent。
 *
 * **品味在 skill 的样稿和 RECIPE.md 里,不在这里** —— 这段话只做四件事:指到配方和样稿、
 * 让 agent 从样稿起头(复刻就是改样稿,不是照着文字重写)、留出用户贴内容的位置、
 * 把配方之外的通用底线说一遍(不适用就直说、不编人名数据、做完看图自检)。
 * 配方的结构和动效原则一个字都不抄进来,否则 skill 改了配方,这里还是旧的。
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

0. 先看你的工具里有没有 orca-ppt(read_skill、open_deck)。没有就先别做,照这句话装好、连上:
   ${CONNECT}
   你自己做不到(读不了网页、改不了自己的配置)就把这句话原样转告我。连上之后再从第 1 步开始。不要凭印象做。
1. 调 read_skill 读 \`${dir}/RECIPE.md\`,再读样稿 \`${sample}/index.html\`。
   样稿就是这个同款的答案,开头的转场计划注释写着每次翻页的手法。
   样稿比一次返回的长:结果里 next 不为空就带着它接着读,读到底再动手。
2. 先对照配方的「适用 / 不适用」看我的内容。不适合就直接告诉我为什么,别硬套。
3. 用 create_deck 新建,from 填 \`recipe:${recipe.id}\`:它复制一份样稿,主题、配色、素材都带上。
   紧接着用 open_deck 打开它 —— 之后你的每一处改动,画布都会翻过去框给我看。
   在这份上换成我的内容:改字用 edit_text(一段一段换,能撤销,不会碰坏转场靠的属性),
   转场计划注释里的字用 edit_plan,删页用 edit_pages。
   要多一页同样结构的页:先用 edit_pages 插一页,再 read_page 读相邻那一页,改好用 write_page 写进新插的那一页。
   要改转场锚的坐标:逐页 read_page,改好用 write_page 写回,按配方的「页面结构」算锚点。
   不要用你自己的文件工具改 deck.html —— 那样画面上看不见,也撤销不了。不要从空白重写,也不要写脚本整份替换。
4. 缺的细节你自己定,把假设写进转场计划注释里。不要编人名和数据,没有的留占位。
   样稿里的示例年份、公司名、标语和句子都是别人的,一条也别留:换成我的,或者删掉。
5. 用 capture_slide 把每一页都截下来看(漏一页就不算看过),按配方的「自检」过一遍再交给我。
   交给我时说一声「在 Orca PPT 里看」;要发给别人,用 export_pptx 导出。
   不要把 deck.html 当成品单独交出去 —— 离开 Orca PPT 它打不开。

${slots}`
}
