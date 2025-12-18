param(
  [int]$Port = 8787,
  [string]$BindHost = "127.0.0.1"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerJs = Join-Path $ScriptDir "web-localhost/server/server.js"

node $ServerJs --host $BindHost --port $Port
