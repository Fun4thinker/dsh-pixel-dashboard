# 重启 dsh web：先结束当前监听 3080 的进程树，再以脱离父进程的方式重新拉起，
# 让新装的插件行在下次 boot 时被正常 import。
#
# 之所以要脱离父进程：本脚本常常由当前会话（本身就是 dsh 的子进程）触发，
# 如果新进程挂在同一棵进程树上，宿主一退出它就会被一起清掉。
#
# 用法: powershell -File tools/restart-dsh.ps1
$ErrorActionPreference = 'Stop'

$harness = 'D:\deepseek-harness'
$log = 'D:\blog\dsh-pixel-plugin\dsh-web.log'

# 1) 找到监听 3080 的进程，连同它的父进程链一起结束
$listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -ne $listener) {
  $pid0 = $listener.OwningProcess
  Write-Host "监听 3080 的进程: $pid0"
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid0" -ErrorAction SilentlyContinue
  # 父进程通常是 pnpm 包装层；一并结束避免残留
  if ($null -ne $proc -and $null -ne $proc.ParentProcessId) {
    Write-Host "结束父进程: $($proc.ParentProcessId)"
    Stop-Process -Id $proc.ParentProcessId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $pid0 -Force -ErrorAction SilentlyContinue
} else {
  Write-Host '没有进程在监听 3080'
}

Start-Sleep -Seconds 3

# 2) 脱离父进程重新拉起（宿主只保证 powershell.exe 存在，pwsh 未必安装）
$inner = "Set-Location '$harness'; pnpm dsh web *> '$log'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$shell = Join-Path $PSHOME 'powershell.exe'
Start-Process -FilePath $shell -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden
Write-Host "已重新拉起 dsh web，日志: $log"
