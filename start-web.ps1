param(
  [int]$Port = 8787,
  [string]$BindHost = "127.0.0.1"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "Demo/start-web.ps1") -Port $Port -BindHost $BindHost
