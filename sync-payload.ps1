# Copies what the server hands out from the build computer into payload/:
#   the agent (D:\DonutClient\dist), Grape itself and the installer (the release build in D:\Grape), and version.json.
# Run after:  npm run build  (in D:\Grape)  and  cargo build --release --bin grape-setup  (in D:\Grape\src-tauri)
param([string]$App = 'D:\Grape')
$p = "$PSScriptRoot\payload"
New-Item -ItemType Directory -Force $p | Out-Null
$agent = "$PSScriptRoot\..\dist\grape-agent-core.jar"
if (Test-Path $agent) { Copy-Item $agent "$p\grape-agent-core.jar" -Force }
Copy-Item "$App\src-tauri\target\release\grape.exe" "$p\Grape.exe" -Force
Copy-Item "$App\src-tauri\target\release\grape-setup.exe" "$p\grape-setup.exe" -Force
$version = (Get-Content "$App\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
(@{ version = $version } | ConvertTo-Json -Compress) | Set-Content "$p\version.json" -Encoding ascii
Get-ChildItem $p | Select-Object Name, Length | Format-Table -AutoSize
