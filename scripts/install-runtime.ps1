# Installs the portable, per-user runtime used for local development on Windows (no administrator rights needed):
#   PostgreSQL 16 (EDB binaries), Redis 7 (redis-windows build), SeaweedFS (S3-compatible object storage).
# Mosquitto 2.x and Node.js 22 are installed system-wide with winget:
#   winget install OpenJS.NodeJS.22 EclipseFoundation.Mosquitto
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$rt = if ($env:BAMP_RUNTIME) { $env:BAMP_RUNTIME } else { Join-Path $env:LOCALAPPDATA 'bamp-runtime' }
New-Item -ItemType Directory -Force $rt | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
function Say($m) { Write-Host "[runtime] $m" }

function Expand-Zip($zip, $dest, [string[]]$exclude = @()) {
  New-Item -ItemType Directory -Force $dest | Out-Null
  $args = @('-xf', $zip, '-C', $dest)
  foreach ($e in $exclude) { $args += @('--exclude', $e) }
  & $tar @args
  if ($LASTEXITCODE -ne 0) { throw "extraction of $zip failed" }
}

# PostgreSQL 16
if (-not (Test-Path (Join-Path $rt 'pgsql\bin\postgres.exe'))) {
  $zip = Join-Path $rt 'pgsql.zip'
  $got = $false
  foreach ($v in @('16.15-4', '16.15-3', '16.15-2', '16.15-1', '16.14-1', '16.13-1', '16.12-1', '16.11-1', '16.10-1')) {
    try { Say "PostgreSQL $v…"; Invoke-WebRequest "https://get.enterprisedb.com/postgresql/postgresql-$v-windows-x64-binaries.zip" -OutFile $zip -UseBasicParsing; $got = $true; break } catch { }
  }
  if (-not $got) { throw 'Could not download PostgreSQL 16 binaries' }
  Expand-Zip $zip $rt @('pgsql/pgAdmin 4', 'pgsql/StackBuilder', 'pgsql/doc', 'pgsql/symbols', 'pgsql/include')
  Remove-Item $zip -Force
}

# Redis 7
if (-not (Test-Path (Join-Path $rt 'redis\redis-server.exe'))) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/redis-windows/redis-windows/releases' -Headers @{ 'User-Agent' = 'bamp-setup' }
  $asset = $null
  foreach ($r in $rel) { if ($r.tag_name -match '^7\.') { $asset = $r.assets | Where-Object { $_.name -match 'Windows-x64-msys2\.zip$' } | Select-Object -First 1; if ($asset) { break } } }
  Say "Redis $($asset.name)…"
  $zip = Join-Path $rt 'redis.zip'
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $rt 'redis-tmp'
  Expand-Zip $zip $tmp
  $srv = Get-ChildItem $tmp -Recurse -Filter 'redis-server.exe' | Select-Object -First 1
  Move-Item $srv.Directory.FullName (Join-Path $rt 'redis')
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force
}

# SeaweedFS
if (-not (Test-Path (Join-Path $rt 'seaweedfs\weed.exe'))) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/seaweedfs/seaweedfs/releases/latest' -Headers @{ 'User-Agent' = 'bamp-setup' }
  $asset = $rel.assets | Where-Object { $_.name -eq 'windows_amd64.zip' } | Select-Object -First 1
  Say "SeaweedFS $($rel.tag_name)…"
  $zip = Join-Path $rt 'weed.zip'
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Zip $zip (Join-Path $rt 'seaweedfs')
  Remove-Item $zip -Force
}

# Integrity check: an interrupted extraction leaves zero-filled files behind.
$bad = Get-ChildItem (Join-Path $rt 'pgsql\share\timezonesets') -File | Where-Object {
  $b = [IO.File]::ReadAllBytes($_.FullName); $b.Length -gt 0 -and -not ($b | Where-Object { $_ -ne 0 } | Select-Object -First 1)
}
if ($bad) { throw "PostgreSQL files are corrupt ($($bad.Count)); delete $rt\pgsql and re-run this script." }
Say "runtime ready in $rt"
