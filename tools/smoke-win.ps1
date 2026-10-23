# Windows 安装包冒烟测试:在 CI 的 Windows 机器上静默安装 → 确认快捷方式和 MCP 起来了 →
# 截一张屏 → 卸载 → 确认卸干净了。用法:pwsh tools/smoke-win.ps1 dist/release
# 截图和应用日志写到 dist/smoke/,跟着 artifact 一起传上去;失败时也截、也打出日志。
param([Parameter(Mandatory)][string]$ReleaseDir)
$ErrorActionPreference = 'Stop'

$setup = Get-ChildItem (Join-Path $ReleaseDir '*-Setup.exe') | Select-Object -First 1
if (-not $setup) { throw "没找到 Setup.exe:$ReleaseDir" }
$installRoot = Join-Path $env:LOCALAPPDATA 'OrcaPPT'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$mcp = 'http://127.0.0.1:6722/mcp'
$shots = Join-Path (Split-Path $ReleaseDir -Parent) 'smoke'
New-Item -ItemType Directory -Force $shots | Out-Null

function Find-Shortcut {
  @($programs, [Environment]::GetFolderPath('Desktop')) |
    ForEach-Object { Get-ChildItem $_ -Recurse -Filter 'Orca PPT.lnk' -ErrorAction SilentlyContinue }
}

# MCP 只接受 POST;GET 回 406 就说明应用和 server 都起来了(llms.txt 里给 AI 助手的也是这个判断)
function Test-Mcp {
  try {
    Invoke-WebRequest $mcp -UseBasicParsing -TimeoutSec 3 | Out-Null
    return $true
  } catch {
    return $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 406
  }
}

function Save-Screenshot([string]$name) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $shots $name), [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "截图:$shots\$name"
}

function Write-Diagnostics {
  Write-Host '--- 进程 ---'
  Get-CimInstance Win32_Process -Filter "Name = 'OrcaPPT.exe' OR Name = 'Update.exe'" |
    Format-Table ProcessId, ParentProcessId, CommandLine -Wrap | Out-String -Width 300 | Write-Host
  Write-Host '--- 端口 6722 ---'
  Get-NetTCPConnection -LocalPort 6722 -ErrorAction SilentlyContinue | Out-String | Write-Host
}

function Wait-Until([scriptblock]$check, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $check) { return }
    Start-Sleep -Seconds 2
  }
  throw "等了 $seconds 秒,$what"
}

Write-Host "安装 $($setup.Name)"
Start-Process $setup.FullName -ArgumentList '--silent' -Wait
$exe = Join-Path $installRoot 'OrcaPPT.exe'
if (-not (Test-Path $exe)) { throw "没装到 $exe" }
$appDir = Get-ChildItem $installRoot -Directory -Filter 'app-*' | Select-Object -First 1
if (-not $appDir) { throw "没找到 $installRoot\app-*" }
Write-Host "装到了 $($appDir.FullName)"
if (-not (Test-Path (Join-Path $appDir.FullName 'resources\skill\SKILL.md'))) { throw '安装包里没有 skill' }
Wait-Until { Find-Shortcut } 30 '开始菜单 / 桌面上没出现 Orca PPT 的快捷方式'
Write-Host "快捷方式:$((Find-Shortcut).FullName -join ', ')"

# --silent 装完不会自己起应用。直接起 app-* 里那个真正的 exe(根目录的 OrcaPPT.exe 只是 Squirrel 的
# 转发器),把它的输出接到文件里:主进程和 server 的报错都在这里
Get-Process OrcaPPT -ErrorAction SilentlyContinue | Stop-Process -Force
$env:ELECTRON_ENABLE_LOGGING = '1'
$stdout = Join-Path $shots 'app-stdout.log'
$stderr = Join-Path $shots 'app-stderr.log'
Start-Process (Join-Path $appDir.FullName 'OrcaPPT.exe') -RedirectStandardOutput $stdout -RedirectStandardError $stderr
try {
  Wait-Until { Test-Mcp } 90 "MCP($mcp)没起来"
  Write-Host 'MCP 起来了'
  # 等界面画完再截屏
  Start-Sleep -Seconds 8
  Save-Screenshot 'workbench.png'
} catch {
  Save-Screenshot 'failure.png'
  Write-Diagnostics
  foreach ($log in @($stdout, $stderr)) {
    Write-Host "--- $log ---"
    if (Test-Path $log) { Get-Content $log -Tail 80 | Write-Host }
  }
  throw
}

# 再按用户的方式打开一次:开始菜单的快捷方式 → 根目录的转发器 → app-* 里的 exe
Get-Process OrcaPPT -ErrorAction SilentlyContinue | Stop-Process -Force
Wait-Until { -not (Test-Mcp) } 15 '关掉应用后 MCP 还在'
$shortcut = Find-Shortcut | Where-Object { $_.FullName.StartsWith($programs) } | Select-Object -First 1
Write-Host "从快捷方式打开:$($shortcut.FullName)"
Start-Process $shortcut.FullName
try {
  Wait-Until { Test-Mcp } 60 "从快捷方式打开后 MCP($mcp)没起来"
  Write-Host '从快捷方式打开,MCP 起来了'
} catch {
  Save-Screenshot 'shortcut-failure.png'
  Write-Diagnostics
  throw
}

Write-Host '卸载'
Get-Process OrcaPPT -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process (Join-Path $installRoot 'Update.exe') -ArgumentList '--uninstall' -Wait
Wait-Until { -not (Find-Shortcut) } 30 '卸载后快捷方式还在'
Write-Host '冒烟测试通过'
