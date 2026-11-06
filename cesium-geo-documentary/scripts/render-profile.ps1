param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("landscape", "portrait", "square")]
  [string]$Profile,

  [ValidateSet("draft", "high")]
  [string]$Quality = "draft",

  [string]$Regions = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$compositor = Join-Path $root "apps\video-compositor"
$outputDirectory = if ($Quality -eq "high") {
  Join-Path $root "renders\final"
} else {
  Join-Path $root "renders\previews"
}
$contentIndex = Get-Content -Raw -Encoding UTF8 (Join-Path $root "content\regions.zh-CN.json") | ConvertFrom-Json
$allIds = @($contentIndex.PSObject.Properties.Name)
$ids = if ([string]::IsNullOrWhiteSpace($Regions)) {
  $allIds
} else {
  @($Regions.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() })
}
$invalidIds = @($ids | Where-Object { $_ -notin $allIds })
if ($invalidIds.Count -gt 0) {
  throw "Unknown region IDs: $($invalidIds -join ', ')"
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
# HyperFrames launches FFmpeg through a child-process boundary that can still
# receive an ANSI-decoded PATH on Windows. Keep executable tools in an ASCII
# system-temp path so projects stored below Chinese directory names remain
# renderable; media inputs and outputs stay inside the isolated job sandbox.
$toolDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "cesium-geo-documentary-tools"
New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
$ffmpegSource = (Resolve-Path (Join-Path $root "node_modules\ffmpeg-static\ffmpeg.exe")).Path
$ffprobeSource = (Resolve-Path (Join-Path $root "node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe")).Path
$ffmpegTarget = Join-Path $toolDirectory "ffmpeg.exe"
$ffprobeTarget = Join-Path $toolDirectory "ffprobe.exe"
$toolMutex = [System.Threading.Mutex]::new($false, "Local\CesiumGeoDocumentaryTools")
$toolLockAcquired = $toolMutex.WaitOne([TimeSpan]::FromSeconds(60))
if (!$toolLockAcquired) { throw "Timed out waiting for the FFmpeg tool cache lock" }
try {
  if (!(Test-Path -LiteralPath $ffmpegTarget) -or (Get-Item -LiteralPath $ffmpegTarget).Length -ne (Get-Item -LiteralPath $ffmpegSource).Length) {
    Copy-Item -LiteralPath $ffmpegSource -Destination $ffmpegTarget -Force
  }
  if (!(Test-Path -LiteralPath $ffprobeTarget) -or (Get-Item -LiteralPath $ffprobeTarget).Length -ne (Get-Item -LiteralPath $ffprobeSource).Length) {
    Copy-Item -LiteralPath $ffprobeSource -Destination $ffprobeTarget -Force
  }
} finally {
  $toolMutex.ReleaseMutex()
  $toolMutex.Dispose()
}
$env:PATH = "$toolDirectory;$env:PATH"

Push-Location -LiteralPath $compositor
try {
  foreach ($id in $ids) {
    $suffix = if ($Quality -eq "high") { "final" } else { "draft" }
    $output = Join-Path $outputDirectory "$id-$Profile-$suffix.mp4"
    Write-Output "RENDER_START quality=$Quality profile=$Profile region=$id"
    # Call the HyperFrames CLI through node directly instead of the .cmd npm
    # shim: the shim embeds an ANSI-decoded absolute NODE_PATH pointing at the
    # repo under its Chinese-named parent folder, which makes PowerShell child
    # processes fail to boot node at all (empty $LASTEXITCODE, no stdout).
    $nodeExe = if ($env:HF_NODE) { $env:HF_NODE } else { (Get-Command node -ErrorAction Stop).Source }
    $hyperframesCli = (Resolve-Path (Join-Path $root "node_modules\hyperframes\dist\cli.js")).Path
    & $nodeExe $hyperframesCli render . `
      --composition "compositions/$id-$Profile.html" `
      --output $output `
      --quality $Quality `
      --fps 30 `
      --workers 1 `
      --strict `
      --sdr `
      --browser-timeout 120 `
      --quiet
    if ($LASTEXITCODE -ne 0) {
      throw "HyperFrames render failed: quality=$Quality profile=$Profile region=$id exit=$LASTEXITCODE"
    }
    Write-Output "RENDER_DONE quality=$Quality profile=$Profile region=$id output=$output"
  }
} finally {
  Pop-Location
}
