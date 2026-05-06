# Mirror the current PatchManager stubs into the extension bundle.
# Run from the extension root: npm run sync-stubs

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$source = Resolve-Path (Join-Path $repoRoot '..\ksp2redux\Assets\Modules\PatchManager\Stubs')
$dest = Join-Path $repoRoot 'stubs'

if (-not (Test-Path $source)) {
    throw "Source stubs not found at $source"
}

if (Test-Path $dest) {
    Get-ChildItem -Path $dest -Filter '*.d.lua' | Remove-Item -Force
} else {
    New-Item -ItemType Directory -Path $dest | Out-Null
}

Get-ChildItem -Path $source -Filter '*.d.lua' | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $dest -Force
    Write-Host "  copied $($_.Name)"
}

Write-Host "Synced stubs from $source -> $dest"
