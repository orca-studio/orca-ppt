import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    // 操作记录别写进真的 ~/.orca-ppt:每次跑测试换一个临时文件
    env: {
      ORCA_PPT_RECORDING_FILE: join(tmpdir(), `orca-ppt-test-recording-${process.pid}.jsonl`),
      // 缩略图缓存也一样
      ORCA_PPT_THUMBNAIL_DIR: join(tmpdir(), `orca-ppt-test-thumbnails-${process.pid}`),
      // server 起来时会清旧版的样片缓存,别清到真的 ~/.orca-ppt
      ORCA_PPT_PREVIEW_DIR: join(tmpdir(), `orca-ppt-test-previews-${process.pid}`),
      // skill 的固定位置:别把真的 ~/.local/share/orca-ppt/skill 改指到测试用的 skill
      ORCA_PPT_STABLE_SKILL: join(tmpdir(), `orca-ppt-test-stable-${process.pid}`, 'skill'),
      // 首页「我的」的记录:别把测试建的临时稿子记进真的 ~/.orca-ppt
      ORCA_PPT_RECENT_DECKS_FILE: join(tmpdir(), `orca-ppt-test-recent-decks-${process.pid}.json`),
    },
  },
})
