# npm 包(orca-ppt.tgz)的 Windows 冒烟测试:在 CI 的 Windows 机器上全局装 → 新建、检查、导出 →
# 后台起 serve → 用 orca-ppt call 操作(三种参数写法)→ 截图 → 停掉。照 llms-web.txt 给 AI 助手的那条路走。
# 用法:pwsh tools/smoke-npm-win.ps1 release
param([Parameter(Mandatory)][string]$ReleaseDir)
$ErrorActionPreference = 'Stop'

$tgz = Get-ChildItem (Join-Path $ReleaseDir 'orca-ppt-*.tgz') | Select-Object -First 1
if (-not $tgz) { throw "没找到 orca-ppt-*.tgz:$ReleaseDir" }

# 原生命令失败不会让 PowerShell 停下,每一步自己看退出码
function Run([string]$label, [scriptblock]$command) {
  Write-Host "--- $label"
  $out = & $command 2>&1 | Out-String
  Write-Host $out
  if ($LASTEXITCODE -ne 0) { throw "$label 失败(退出码 $LASTEXITCODE)" }
  return $out
}

Run '安装' { npm install -g $tgz.FullName } | Out-Null
Run '版本' { orca-ppt --version } | Out-Null
Run '起始文件' { orca-ppt templates } | Out-Null
$skill = (Run 'skill 目录' { orca-ppt skill }).Trim()
if (-not (Test-Path (Join-Path $skill 'references\workbench.md'))) { throw "包里的 skill 不全:$skill" }

# 稿子放在 C 盘:全局 npm 目录在 C 盘,稿子和 skill 要在同一个盘(跨盘会被拒,见 llms-web.txt)
$decks = Join-Path $env:TEMP 'orca-ppt-smoke'
New-Item -ItemType Directory -Force $decks | Out-Null
$deck = (Run '新建' { orca-ppt new smoke --from recipe:glass-bars --dir $decks }).Trim()
Run '检查' { orca-ppt check --deck $deck } | Out-Null
Run '导出 PPTX' { orca-ppt export --deck $deck } | Out-Null
if (-not (Test-Path "$deck.pptx")) { throw "没导出来:$deck.pptx" }

try {
  Run '后台起 serve' { orca-ppt serve --detach --no-open } | Out-Null
  $page = Invoke-WebRequest 'http://127.0.0.1:6722/' -UseBasicParsing -TimeoutSec 10
  if ($page.StatusCode -ne 200) { throw "工作台没起来:$($page.StatusCode)" }

  Run 'call:key=value(带反斜杠的路径)' { orca-ppt call open_deck "path=$deck" } | Out-Null
  Run 'call:key=value' { orca-ppt call show_slide index=2 } | Out-Null
  Run 'call:标准输入' { '{"index":1}' | orca-ppt call show_slide - } | Out-Null
  # JSON 直接当参数:PowerShell 调 npm 的 .cmd 时可能吃掉双引号。只记结果,不算失败 —— llms-web.txt 里
  # 已经让 Windows 上用 key=value 或标准输入
  Write-Host '--- call:JSON 参数(只记录)'
  orca-ppt call show_slide '{"index":0}' 2>&1 | Out-String | Write-Host
  Write-Host "JSON 参数的退出码:$LASTEXITCODE"

  $shot = Run '截图' { orca-ppt call capture_slide slide=1 }
  $image = ($shot -split "`n" | Where-Object { $_ -match '^图片:' } | Select-Object -First 1) -replace '^图片:', ''
  if (-not $image -or -not (Test-Path $image.Trim())) { throw "截图没存下来:$shot" }
} catch {
  Write-Host '--- serve 日志'
  Get-Content (Join-Path $HOME '.orca-ppt\serve.log') -ErrorAction SilentlyContinue | Select-Object -Last 40 | Write-Host
  throw
} finally {
  orca-ppt stop 2>&1 | Write-Host
}

Start-Sleep -Seconds 2
try {
  Invoke-WebRequest 'http://127.0.0.1:6722/' -UseBasicParsing -TimeoutSec 3 | Out-Null
  throw 'stop 之后工作台还开着'
} catch [System.Net.WebException], [System.Net.Http.HttpRequestException] {
  Write-Host 'stop 之后端口已经关了'
}
Write-Host 'npm 包在 Windows 上冒烟通过'
