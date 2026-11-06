param(
  [Parameter(Mandatory = $true)]
  [string]$TextPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$Voice = "Microsoft Huihui Desktop",

  [ValidateRange(-10, 10)]
  [int]$Rate = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$resolvedText = (Resolve-Path -LiteralPath $TextPath).Path
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synthesizer.SelectVoice($Voice)
  $synthesizer.Rate = $Rate
  $synthesizer.Volume = 100
  $synthesizer.SetOutputToWaveFile($OutputPath)
  $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedText
  $synthesizer.Speak($text)
} finally {
  $synthesizer.Dispose()
}

Write-Output "WINDOWS_SAPI_READY $OutputPath"
