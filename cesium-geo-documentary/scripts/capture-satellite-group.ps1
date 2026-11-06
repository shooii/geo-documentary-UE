param(
  [Parameter(Mandatory = $true)]
  [string]$Regions,

  [Parameter(Mandatory = $true)]
  [string]$CacheKey
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ids = $Regions.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries)
Set-Location -LiteralPath $root

foreach ($id in $ids) {
  $port = 4700 + [int]$id.Substring($id.Length - 2)
  Write-Output "SATELLITE_CAPTURE_START region=$id cache=$CacheKey"
  & pnpm.cmd capture -- --region $id --profile landscape --encode --cache-key $CacheKey --port $port
  if ($LASTEXITCODE -ne 0) {
    throw "Satellite capture failed: region=$id exit=$LASTEXITCODE"
  }
  Write-Output "SATELLITE_CAPTURE_DONE region=$id cache=$CacheKey"
}
