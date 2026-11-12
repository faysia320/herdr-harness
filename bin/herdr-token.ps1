param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,15}$')][string]$Key)
$ErrorActionPreference = 'Stop'
$active = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.config/herdr-harness/active.json') -Raw | ConvertFrom-Json
& (Join-Path $active.release 'bin/claude-token-import.ps1') -Key $Key
