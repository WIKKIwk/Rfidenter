param(
  [Parameter(Mandatory = $true)][string]$BenchDir,
  [Parameter(Mandatory = $true)][string]$Site
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppSrc = Join-Path $ScriptDir "rfidenter"

if (!(Test-Path $AppSrc)) {
  throw "App source not found: $AppSrc"
}
if (!(Test-Path $BenchDir)) {
  throw "Bench dir not found: $BenchDir"
}
if (!(Test-Path (Join-Path $BenchDir "sites/$Site"))) {
  throw "Site not found: $BenchDir/sites/$Site"
}

$BenchCmd = "bench"
$BenchFromEnv = Join-Path $BenchDir "env/Scripts/bench.exe"
$BenchFromEnvLinux = Join-Path $BenchDir "env/bin/bench"
if (Test-Path $BenchFromEnv) {
  $BenchCmd = $BenchFromEnv
} elseif (Test-Path $BenchFromEnvLinux) {
  $BenchCmd = $BenchFromEnvLinux
}

Push-Location $BenchDir

New-Item -ItemType Directory -Force -Path (Join-Path $BenchDir "apps") | Out-Null

$Dst = Join-Path $BenchDir "apps/rfidenter"
if (Test-Path $Dst) {
  $ts = Get-Date -Format "yyyyMMdd_HHmmss"
  $bak = Join-Path $BenchDir "apps/rfidenter.bak.$ts"
  Write-Host "Backup: $Dst -> $bak"
  Move-Item -Force $Dst $bak
}

Write-Host "Copying rfidenter app into bench..."
Copy-Item -Recurse -Force $AppSrc (Join-Path $BenchDir "apps")

try {
  $appsFile = Join-Path $BenchDir "sites/apps.txt"
  New-Item -ItemType Directory -Force -Path (Join-Path $BenchDir "sites") | Out-Null
  if (!(Test-Path $appsFile)) { New-Item -ItemType File -Force $appsFile | Out-Null }
  $lines = Get-Content $appsFile -ErrorAction SilentlyContinue
  if ($lines -notcontains "rfidenter") { Add-Content -Path $appsFile -Value "rfidenter" }
} catch {
  Write-Warning "Could not update sites/apps.txt. If install fails, add 'rfidenter' to $BenchDir/sites/apps.txt"
}

try {
  $pip = Join-Path $BenchDir "env/Scripts/pip.exe"
  $pipLinux = Join-Path $BenchDir "env/bin/pip"
  if (Test-Path $pip) {
    Write-Host "Installing python package (editable)..."
    & $pip install -e (Join-Path $BenchDir "apps/rfidenter")
  } elseif (Test-Path $pipLinux) {
    Write-Host "Installing python package (editable)..."
    & $pipLinux install -e (Join-Path $BenchDir "apps/rfidenter")
  } else {
    Write-Warning "pip not found. If install fails, run: pip install -e $BenchDir/apps/rfidenter"
  }
} catch {
  Write-Warning "pip install failed. You may need to run: pip install -e $BenchDir/apps/rfidenter"
}

Write-Host "Installing / migrating..."
$apps = & $BenchCmd --site $Site list-apps
if ($apps -match "^rfidenter\b") {
  & $BenchCmd --site $Site migrate
} else {
  & $BenchCmd --site $Site install-app rfidenter
  & $BenchCmd --site $Site migrate
}

Write-Host "Building assets (optional)..."
try {
  & $BenchCmd build --app rfidenter
} catch {
  Write-Warning "bench build failed. Node/yarn kerak bo‘lishi mumkin. Keyinroq serverda build qiling."
}

Pop-Location
Write-Host "Done. Open: http(s)://<ERP_DOMAIN>/app/rfidenter"
