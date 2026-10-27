import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.js'
import { defaultWebRoot } from './web-host.js'

/** 开发时的 `pnpm serve`:界面取仓里 `apps/web/dist` 那份。发布出去的走 CLI(`orca-ppt serve`)。 */
await serve(process.argv.slice(2), {
  webRoot: defaultWebRoot(dirname(fileURLToPath(import.meta.url))),
})
