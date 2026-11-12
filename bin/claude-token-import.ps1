param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,15}$')][string]$Key, [string]$Label)
$ErrorActionPreference = 'Stop'
$tokenRoot = Join-Path $env:USERPROFILE '.config/herdr-harness/tokens'
New-Item -ItemType Directory -Path $tokenRoot -Force | Out-Null
Write-Host "Register the setup-token for account $Key. Input is hidden; do not paste it into chat."
$secureToken = Read-Host 'Long-lived token' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer).Trim()
    if ($tokenText -notmatch '^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$') { throw 'Not a Claude OAuth token.' }
    $normalizedToken = ConvertTo-SecureString $tokenText -AsPlainText -Force
    $protectedToken = ConvertFrom-SecureString $normalizedToken
    $tokenPath = Join-Path $tokenRoot "$Key.dpapi"
    $tempPath = "$tokenPath.$PID.tmp"
    [System.IO.File]::WriteAllText($tempPath, $protectedToken)
    if (Test-Path -LiteralPath $tokenPath) { Copy-Item -LiteralPath $tokenPath -Destination "$tokenPath.previous" -Force }
    Move-Item -LiteralPath $tempPath -Destination $tokenPath -Force
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    $tokenText = $null
    $secureToken.Dispose()
    if ($normalizedToken) { $normalizedToken.Dispose() }
}
if (-not $Label) { $Label = $Key.ToUpperInvariant() }
& node (Join-Path $PSScriptRoot 'claude-account.mjs') register $Key $Label
if ($LASTEXITCODE -ne 0) { throw 'Token registration metadata failed.' }
Write-Host 'Encrypted token saved. Select this account in the Herdr token panel.'
