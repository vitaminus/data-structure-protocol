param(
  [ValidateSet('all','codex','claude','cursor','none')]
  [string]$Agent = 'all',
  [switch]$Global,
  [string]$Root = (Get-Location).Path,
  [switch]$SkipBuild,
  [switch]$NoInit,
  [switch]$WithHooks
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
Set-Location $Root

Write-Host '==> DSP installer'
Write-Host "    root:  $Root"
Write-Host "    agent: $Agent"
Write-Host "    scope: $(if ($Global) { 'global' } else { 'project' })"

function Ensure-Pnpm {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) { return }
  Write-Host '==> pnpm not found; trying to enable/install pnpm'
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack enable
    corepack prepare pnpm@10.17.0 --activate
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      npm install -g pnpm@10.17.0
    } else {
      throw 'pnpm/npm not found. Install Node.js and pnpm, then rerun.'
    }
  }
}

if (-not $SkipBuild) {
  Ensure-Pnpm
  Write-Host '==> Installing dependencies'
  pnpm install
  Write-Host '==> Building packages'
  pnpm build
}

if (-not $NoInit) {
  Write-Host '==> Initializing DSP'
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm dsp init $Root | Out-Null
  } else {
    npm run dsp -- init $Root | Out-Null
  }
}

function Get-AgentText {
@'
# DSP v2 project memory

This project uses DSP v2: a local structural-semantic graph and context compiler for AI coding agents.

Before larger code changes:
- run `pnpm dsp search "<task>"` to find relevant entities;
- run `pnpm dsp impact <file-or-uid>` before refactors;
- run `pnpm dsp validate` after indexing or edits;
- use `pnpm dsp export --format protocol` when a plain-text agent-readable graph is useful.

When code structure changes:
- run `pnpm dsp update --changed-only` or `pnpm dsp index . --changed-only`;
- keep `.dsp/dsp.sqlite` local unless the team intentionally shares it;
- prefer `.dsp/protocol` export for reviewable graph snapshots.
'@
}

function Write-TextFile($Path, $Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  Set-Content -Path $Path -Value $Text -Encoding UTF8
}

function Install-Codex {
  $target = if ($Global) { Join-Path $HOME '.codex/AGENTS.md' } else { Join-Path $Root 'AGENTS.md' }
  $text = Get-AgentText
  if ((Test-Path $target) -and ((Get-Content $target -Raw) -match 'DSP v2 project memory')) {
    Write-Host "==> Codex guidance already installed: $target"
  } elseif (Test-Path $target) {
    Add-Content -Path $target -Value "`n---`n$text"
    Write-Host "==> Appended Codex guidance: $target"
  } else {
    Write-TextFile $target $text
    Write-Host "==> Installed Codex guidance: $target"
  }
}

function Install-Claude {
  $target = if ($Global) { Join-Path $HOME '.claude/AGENTS.md' } else { Join-Path $Root '.claude/AGENTS.md' }
  Write-TextFile $target (Get-AgentText)
  Write-Host "==> Installed Claude guidance: $target"
}

function Install-Cursor {
  $target = if ($Global) { Join-Path $HOME '.cursor/rules/dsp.mdc' } else { Join-Path $Root '.cursor/rules/dsp.mdc' }
  $text = "---`ndescription: DSP v2 structural memory and context compiler`nalwaysApply: true`n---`n$(Get-AgentText)"
  Write-TextFile $target $text
  Write-Host "==> Installed Cursor rule: $target"
}

if ($Agent -ne 'none') {
  if ($Agent -eq 'all' -or $Agent -eq 'codex') { Install-Codex }
  if ($Agent -eq 'all' -or $Agent -eq 'claude') { Install-Claude }
  if ($Agent -eq 'all' -or $Agent -eq 'cursor') { Install-Cursor }
}

if ($WithHooks) {
  $gitDir = Join-Path $Root '.git'
  if (Test-Path $gitDir) {
    $hook = Join-Path $gitDir 'hooks/pre-commit'
    $hookText = @'
#!/usr/bin/env bash
set -euo pipefail
if command -v pnpm >/dev/null 2>&1; then
  pnpm dsp validate . --json >/tmp/dsp-validate.json
else
  npm run dsp -- validate . --json >/tmp/dsp-validate.json
fi
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync("/tmp/dsp-validate.json","utf8")); if(r.summary && r.summary.errors>0){ console.error(JSON.stringify(r,null,2)); process.exit(1); }'
'@
    Write-TextFile $hook $hookText
    Write-Host '==> Installed git pre-commit DSP validation hook'
  } else {
    Write-Host '==> Skipping hooks: .git directory not found'
  }
}

Write-Host '==> Done'
Write-Host 'Next: pnpm dsp bootstrap . --lazy && pnpm dsp validate'
