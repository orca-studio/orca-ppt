/**
 * 机械的那一半内核:新建稿子、读写稿子目录、切页改页、阶段状态。只吃路径、只返回值,
 * 不起进程、不持有状态 —— server、CLI 都调它(见 docs/ARCHITECTURE.md「一个内核,三种形态」)。
 * 品味不在这里,在 deck-agent。
 */
export * from './asset-digest.js'
export * from './create.js'
export * from './decks.js'
export * from './edit.js'
export * from './page-edit.js'
export * from './phases.js'
export * from './pptx.js'
export * from './recent.js'
export * from './recipes.js'
export * from './renderer.js'
export * from './skill.js'
export * from './tags.js'
export * from './templates.js'
