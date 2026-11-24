# Sends what the server hands out (built on this Windows computer) to the VPS: Grape itself, the installer, the agent,
# the window bundle and the version. The workflow deploys the CODE; these are built here, so they go with this script.
#
#   .\scripts\publish-payload.ps1 -Target deploy@grapeclient.com
#   (run  .\sync-payload.ps1  first so payload\ holds the newest build)
#
# Each file is sent under a temporary name and then renamed on the VPS, so a download never sees a half-written one.
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$Port = 22,
  [string]$Key = (Join-Path $HOME '.ssh\grape-deploy')
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\payload'
$files = 'Grape.exe', 'grape-setup.exe', 'grape-agent-core.jar.enc', 'grape-agent.jar.enc', 'grape-dll.enc', 'grape-ui.json', 'version.json'
foreach ($f in $files) {
  if (-not (Test-Path (Join-Path $dir $f))) { throw "payload\$f is missing: run sync-payload.ps1 (and build the app) first." }
}
foreach ($f in $files) {
  Write-Host "sending $f ..."
  scp -i $Key -P $Port (Join-Path $dir $f) "${Target}:/opt/grape-server/payload/$f.new"
  if ($LASTEXITCODE -ne 0) { throw "scp failed for $f" }
}
if (Test-Path (Join-Path $dir 'names')) {
  Write-Host "sending names\ ..."
  ssh -i $Key -p $Port $Target 'mkdir -p /opt/grape-server/payload/names'
  scp -i $Key -P $Port -r (Join-Path $dir 'names\*') "${Target}:/opt/grape-server/payload/names/"
  if ($LASTEXITCODE -ne 0) { throw "scp failed for names" }
}
ssh -i $Key -p $Port $Target 'cd /opt/grape-server/payload && for f in *.new; do mv -f "$f" "${f%.new}"; done && ls -l'
if ($LASTEXITCODE -ne 0) { throw "could not put the files in place" }
Write-Host 'Done: the server reads the new files on the next request (no restart needed).'
