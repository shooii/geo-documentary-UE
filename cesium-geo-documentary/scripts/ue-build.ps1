param([string]$EngineRoot='C:\Program Files\Epic Games\UE_5.7')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try { & pnpm exec tsx scripts/ue-cloud-assets.ts; if($LASTEXITCODE -ne 0){throw 'Cloud texture generation failed'} } finally { Pop-Location }
$source=Join-Path $projectRoot 'unreal\GeoDocumentary'
# SHA256::HashData / Convert::ToHexString are PowerShell 7 APIs. Windows PowerShell
# 5.1 is what ships on this machine, so compute the same staging hash the long way —
# it must stay byte-identical or every build would start from an empty stage.
$sha=[Security.Cryptography.SHA256]::Create()
$hash=(-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot)) | ForEach-Object { $_.ToString('X2') })).Substring(0,12)
$sha.Dispose()
$stage=Join-Path $env:LOCALAPPDATA "Temp\GeoDocumentary-$hash"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path "$stage\Content\Geo" | Out-Null
Copy-Item -Path "$projectRoot\unreal\assets\*.png" -Destination "$stage\Content\Geo" -Force
Copy-Item -LiteralPath "$source\Source","$source\Config","$source\GeoDocumentary.uproject" -Destination $stage -Recurse -Force
$uproject=Join-Path $stage 'GeoDocumentary.uproject'
& "$EngineRoot\Engine\Build\BatchFiles\Build.bat" GeoDocumentaryEditor Win64 Development "-Project=$uproject" -WaitMutex -NoHotReloadFromIDE -NoUBA
if($LASTEXITCODE -ne 0){throw 'UE C++ build failed'}
$python=Join-Path $projectRoot 'unreal\prepare_content.py'
& "$EngineRoot\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" $uproject '-run=pythonscript' "-script=$python" -unattended -nosplash -nullrhi
if($LASTEXITCODE -ne 0){throw 'UE content preparation failed'}
Copy-Item -LiteralPath "$stage\Binaries","$stage\Content" -Destination $source -Recurse -Force
$workspace=Join-Path $projectRoot 'workspace'
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
@{engineRoot=$EngineRoot;project=$uproject}|ConvertTo-Json|Set-Content -LiteralPath "$workspace\ue-runtime.json" -Encoding utf8
Write-Output "UE_BUILD_READY $uproject"
