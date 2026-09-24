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
    },
  },
})
