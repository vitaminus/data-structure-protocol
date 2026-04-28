param(
  [string]$Root = (git rev-parse --show-toplevel 2>$null)
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Get-Location).Path }
$Root = (Resolve-Path $Root).Path
$HooksSrc = Split-Path -Parent $MyInvocation.MyCommand.Path
$HooksDst = Join-Path $Root '.git/hooks'

if (-not (Test-Path (Join-Path $Root '.git'))) {
  throw "$Root is not a git repository"
}

New-Item -ItemType Directory -Force -Path $HooksDst | Out-Null
foreach ($file in @('dsp-hook-lib.sh','dsp-check-staged.sh','dsp-agent-review.sh','pre-commit','pre-push')) {
  Copy-Item -Force (Join-Path $HooksSrc $file) (Join-Path $HooksDst $file)
  Write-Host "installed $(Join-Path $HooksDst $file)"
}

Write-Host 'DSP hooks installed.'
Write-Host 'Use DSP_HOOK_SKIP=1 to skip hooks, DSP_HOOK_RUN_TESTS=1 to run tests on pre-push.'
