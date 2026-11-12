$ErrorActionPreference = 'Stop'
$active = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.config/herdr-harness/active.json') -Raw | ConvertFrom-Json
& node (Join-Path $active.release 'bin/claude-token-run.mjs') -- @args
exit $LASTEXITCODE
