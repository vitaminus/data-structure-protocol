param(
  [string]$Task = 'Review current code changes',
  [string]$Root = (git rev-parse --show-toplevel 2>$null)
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Get-Location).Path }
$Root = (Resolve-Path $Root).Path
$ReportDir = Join-Path $Root '.dsp/reports/agent-review'
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

function Invoke-DspJson($Args, $OutFile) {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm dsp @Args | Set-Content -Encoding UTF8 $OutFile
  } else {
    npm run dsp -- @Args | Set-Content -Encoding UTF8 $OutFile
  }
}

Invoke-DspJson @('changed', $Root, '--json') (Join-Path $ReportDir 'changed.json')
Invoke-DspJson @('ci', 'impact', $Root, '--json') (Join-Path $ReportDir 'impact.json')
Invoke-DspJson @('ci', 'context-summary', $Root, '--task', $Task, '--json') (Join-Path $ReportDir 'context.json')
Invoke-DspJson @('validate', $Root, '--json') (Join-Path $ReportDir 'validate.json')

Set-Content -Encoding UTF8 (Join-Path $ReportDir 'README.md') "# DSP Agent Review`n`nTask: $Task`n`nUse changed.json, impact.json, context.json, and validate.json as review context.`n"
Write-Host "DSP review reports written to $ReportDir"
