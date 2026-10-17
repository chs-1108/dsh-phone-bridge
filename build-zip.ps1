# Packs the plugin into the installable ZIP with the same layout as the
# original archive: one top-level `phone-bridge/` folder, no extra layers.
#
# Usage:  pwsh -NoProfile -File build-zip.ps1 [-Version 1.0.1]
#
# The staging copy exists so the archive holds exactly the shipped file set
# (no dist/, no scratch directories) and so a stray editor backup cannot leak in.

[CmdletBinding()]
param(
    [string]$Version,
    [string]$Output
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
if (-not $Version) {
    $Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
}
if (-not $Output) {
    $Output = Join-Path $Root "dist\phone-bridge-plugin-$Version.zip"
}

$Include = @(
    'package.json',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'README.md',
    'SETUP.md',
    'IMPLEMENTATION.md',
    'pair-qr.png',
    'pair-qr.svg',
    'build-apk.ps1',
    'build-zip.ps1',
    'setup-phone-bridge.ps1',
    'web',
    'vendor',
    'bin',
    'apk',
    'apk-out',
    'test',
    'tools'
)

$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("phone-bridge-pack-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Target = Join-Path $Stage 'phone-bridge'
New-Item -ItemType Directory -Path $Target -Force | Out-Null

try {
    foreach ($item in $Include) {
        $source = Join-Path $Root $item
        if (-not (Test-Path $source)) {
            Write-Warning "missing packaged file, skipped: $item"
            continue
        }
        Copy-Item -LiteralPath $source -Destination $Target -Recurse -Force
    }

    # Never ship scratch state, editor leftovers, or build scratch.
    Get-ChildItem $Target -Recurse -Force -Include '*.bak', '*.bak-*', '*.orig', '*~', 'state.json', '*.idsig' |
        Remove-Item -Force -ErrorAction SilentlyContinue
    # The Tailscale installer is 100 MB and only the deploy script wants it, so it
    # is fetched on demand instead of riding along in every download.
    $tailscaleApk = Join-Path $Target 'bin\tailscale-android.apk'
    if (Test-Path $tailscaleApk) { Remove-Item -LiteralPath $tailscaleApk -Force -ErrorAction SilentlyContinue }
    foreach ($junk in @('apk-out\classes', 'apk-out\dex', 'apk-out\gen', 'apk-out\compiled', 'apk-out\res.zip')) {
        $p = Join-Path $Target $junk
        if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
    }

    $outDir = Split-Path -Parent $Output
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    if (Test-Path $Output) { Remove-Item -LiteralPath $Output -Force }

    # Zip the staged tree with forward-slash entry names. The framework helper
    # CreateFromDirectory writes backslashes on Windows, which non-Windows
    # extractors render as literal filename characters, so build entries by hand.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    $zipStream = [System.IO.File]::Open($Output, [System.IO.FileMode]::Create)
    try {
        $archive = New-Object System.IO.Compression.ZipArchive(
            $zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            # Entries are relative to the working directory with a single
            # top-level `phone-bridge/` folder, matching the original archive.
            $workLen = (Split-Path -Parent $Target).Length + 1
            foreach ($file in (Get-ChildItem $Target -Recurse -File -Force)) {
                $rel = $file.FullName.Substring($workLen).Replace('\', '/')
                $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                try {
                    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
                    $entryStream.Write($bytes, 0, $bytes.Length)
                }
                finally { $entryStream.Dispose() }
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $zipStream.Dispose() }

    $entries = [System.IO.Compression.ZipFile]::OpenRead($Output)
    $count = $entries.Entries.Count
    $entries.Dispose()

    $info = Get-Item $Output
    Write-Host ("packed {0} entries -> {1}" -f $count, $info.FullName)
    Write-Host ("size  : {0:N1} MB" -f ($info.Length / 1MB))
    Write-Host ("sha256: {0}" -f (Get-FileHash $Output -Algorithm SHA256).Hash)
}
finally {
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
