<#
.SYNOPSIS
    phone-bridge one-click deployment: PC side + phone side over USB.

.DESCRIPTION
    Sets up "phone talks to DSH on this PC" end to end. Connect the phone by USB
    with USB debugging enabled; the script pushes everything to both ends.

    PC side:
      1. Install / verify Tailscale (winget)
      2. Log in to the user's OWN Tailscale account
      3. Read this machine's Tailscale IP
      4. Patch the DSH webServer to listen on 0.0.0.0
      5. Register the phone-bridge plugin in the DSH profile
      6. Generate the pairing token

    Phone side (over adb):
      7. Install the Tailscale APK if missing
      8. Build + install the phone-bridge APK with address/token baked in
      9. Launch Tailscale so the user only has to sign in

    The user supplies their own Tailscale account and taps "Connect" on the
    phone. Everything else is automatic.

.PARAMETER SkipTailscale
    Skip the PC Tailscale install/login steps.

.PARAMETER SkipApk
    Do not build the Android APK (uses an existing apk-out build if present).

.PARAMETER SkipRestart
    Do not restart DSH at the end.

.PARAMETER SkipPhone
    PC side only; do not touch the phone.

.PARAMETER Port
    DSH web port. 0 = auto-detect from the running DSH, else 19387.

.EXAMPLE
    .\setup-phone-bridge.ps1
    Full deployment, PC and phone.

.EXAMPLE
    .\setup-phone-bridge.ps1 -SkipPhone
    PC side only.

.NOTES
    Run from an elevated PowerShell. USB debugging must be enabled on the phone.
#>

[CmdletBinding()]
param(
    [switch]$SkipTailscale,
    [switch]$SkipApk,
    [switch]$SkipRestart,
    [switch]$SkipPhone,
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- presentation

$script:StepNo = 0
$script:StepTotal = 9

function Write-Step {
    param([string]$Title)
    $script:StepNo++
    Write-Host ""
    Write-Host ("-" * 64) -ForegroundColor DarkGray
    Write-Host ("  [{0}/{1}] {2}" -f $script:StepNo, $script:StepTotal, $Title) -ForegroundColor Cyan
    Write-Host ("-" * 64) -ForegroundColor DarkGray
}

function Write-Ok { param([string]$m) Write-Host ("  [ok] " + $m) -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host ("  [!!] " + $m) -ForegroundColor Yellow }
function Write-Info { param([string]$m) Write-Host ("  -  " + $m) -ForegroundColor Gray }

function Fail {
    param([string]$Message, [string]$Hint = '')
    Write-Host ""
    Write-Host ("  [XX] " + $Message) -ForegroundColor Red
    if ($Hint) { Write-Host ("       " + $Hint) -ForegroundColor DarkYellow }
    Write-Host ""
    exit 1
}

function Read-Yes {
    param([string]$Prompt)
    $a = Read-Host $Prompt
    return ($a -match '^[Yy]')
}

# adb tools write progress and warnings to stderr, which trips
# $ErrorActionPreference = 'Stop'. Run them without letting that abort the script.
function Invoke-Adb {
    param(
        [string]$Adb,
        [string[]]$AdbArgs,
        [switch]$Quiet
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Adb @AdbArgs 2>&1
        $code = $LASTEXITCODE
        if (-not $Quiet) {
            foreach ($line in $out) { Write-Info ([string]$line) }
        }
        return $code
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

# ---------------------------------------------------------------- tool finders

function Find-Tailscale {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'),
        'D:\bian_cheng_ruan_jian\Tailscale\tailscale.exe'
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

function Find-Adb {
    $candidates = @(
        $env:PHONE_BRIDGE_ADB,
        'D:\bian_cheng_ruan_jian\platform-tools\adb.exe',
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-TailscaleIp {
    param([string]$Exe)
    if (-not $Exe) { return $null }
    try {
        $raw = (& $Exe status --json 2>&1 | Out-String)
        $j = $raw | ConvertFrom-Json
        if ($j.Self -and $j.Self.TailscaleIPs) {
            return ($j.Self.TailscaleIPs |
                Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } |
                Select-Object -First 1)
        }
    }
    catch { }
    return $null
}

# ------------------------------------------------------------------- boot check

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "         phone-bridge   one-click deployment" -ForegroundColor Cyan
Write-Host "         PC side + phone side over USB" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Info ("workdir: " + $root)

$isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Warn2 "Not running as Administrator."
    Write-Info "Installing Tailscale and patching config may fail."
    if (-not (Read-Yes "  Continue anyway? (y/N)")) { exit 0 }
}

# ============================================================== 1. Tailscale

$script:TailscaleIp = $null
$tsExe = Find-Tailscale

if ($SkipTailscale) {
    Write-Step "Tailscale on PC (skipped)"
    Write-Info "-SkipTailscale specified"
}
else {
    Write-Step "Tailscale on PC"

    if ($tsExe) {
        Write-Ok ("found: " + $tsExe)
    }
    else {
        Write-Info "not found, installing via winget..."
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Fail "winget not available." "Install manually: https://tailscale.com/download/windows"
        }
        & winget install --id Tailscale.Tailscale --accept-package-agreements `
            --accept-source-agreements --silent
        if ($LASTEXITCODE -ne 0) {
            Fail ("winget install failed (exit " + $LASTEXITCODE + ").") "Manual: https://tailscale.com/download/windows"
        }
        $tsExe = Find-Tailscale
        if (-not $tsExe) { Fail "Installed but tailscale.exe not found." }
        Write-Ok ("installed: " + $tsExe)
    }

    $svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') {
        Write-Info "starting service..."
        Start-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    try {
        if ((Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue).StartType -ne 'Automatic') {
            Set-Service -Name 'Tailscale' -StartupType Automatic -ErrorAction SilentlyContinue
        }
        Write-Ok "service runs at boot; closing the GUI keeps the tunnel up"
    }
    catch { Write-Warn2 "could not set startup type" }

    Write-Info "checking login state..."
    $statusRaw = ''
    try { $statusRaw = (& $tsExe status 2>&1 | Out-String) } catch { }

    if (($statusRaw -match 'Logged out') -or ($statusRaw -match 'NeedsLogin') -or ($statusRaw.Trim() -eq '')) {
        Write-Host ""
        Write-Host "  Not logged in to Tailscale." -ForegroundColor Yellow
        Write-Host "  A browser will open. Sign in with YOUR OWN Tailscale account." -ForegroundColor Yellow
        Write-Host "  Free signup: https://login.tailscale.com/start" -ForegroundColor Yellow
        Write-Host ""
        Read-Host "  Press Enter to open the browser"
        & $tsExe up --accept-routes=false
        if ($LASTEXITCODE -ne 0) {
            Fail ("tailscale up failed (exit " + $LASTEXITCODE + ").") ("Manual: `"" + $tsExe + "`" up")
        }
        Start-Sleep -Seconds 3
    }
    else {
        Write-Ok "already logged in"
    }

    Write-Info "reading Tailscale IP..."
    for ($i = 0; $i -lt 20; $i++) {
        $script:TailscaleIp = Get-TailscaleIp -Exe $tsExe
        if ($script:TailscaleIp) { break }
        Start-Sleep -Milliseconds 800
    }
    if (-not $script:TailscaleIp) {
        Fail "Could not read the Tailscale IP." "Check that Tailscale is logged in and running."
    }
    Write-Ok ("Tailscale IP: " + $script:TailscaleIp)
}

if (-not $script:TailscaleIp) {
    $script:TailscaleIp = Get-TailscaleIp -Exe $tsExe
    if (-not $script:TailscaleIp) { Fail "Could not determine the Tailscale IP." }
    Write-Ok ("Tailscale IP: " + $script:TailscaleIp)
}

# ======================================================= 2. port & listening

Write-Step "DSH port and listen address"

if ($Port -eq 0) {
    $detected = @()
    try {
        foreach ($c in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
            $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -match 'dsh|electron|deepseek') {
                $detected += $c.LocalPort
            }
        }
    }
    catch { }
    $detected = $detected | Sort-Object -Unique
    if ($detected -contains 19387) { $Port = 19387 }
    elseif ($detected.Count -gt 0) { $Port = $detected[0] }
    else { $Port = 19387 }

    if ($detected.Count -gt 0) { Write-Ok ("detected port: " + $Port) }
    else { Write-Warn2 ("no running DSH, defaulting to " + $Port) }
}
else {
    Write-Info ("using port " + $Port)
}
$script:Port = $Port

$bound = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($bound) {
    $addrs = ($bound.LocalAddress | Sort-Object -Unique) -join ', '
    Write-Info ("listeners: " + $addrs)
    if ($addrs -match '0\.0\.0\.0') { Write-Ok "listening on 0.0.0.0" }
    else { Write-Warn2 "loopback only - phones cannot reach this yet" }
}

# ======================================================= 3. locate profile

Write-Step "Locate DSH profile"

$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profilesDir = Join-Path $dshHome 'profiles'

if (-not (Test-Path $profilesDir)) {
    Fail ("DSH profile directory not found: " + $profilesDir) "Start DSH desktop once, then rerun."
}

$profileName = 'desktop'
$profileDir = Join-Path $profilesDir $profileName
if (-not (Test-Path $profileDir)) {
    $first = Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '^_' } | Select-Object -First 1
    if ($first) { $profileName = $first.Name; $profileDir = $first.FullName }
    else { Fail "No usable DSH profile found." }
}
Write-Ok ("profile: " + $profileName)
Write-Info ("path: " + $profileDir)

# ======================================================= 4. apply patch

Write-Step "Patch webServer to listen on 0.0.0.0"

$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (Test-Path $patchFile) {
    Copy-Item $patchFile ($patchFile + '.bak-' + $stamp) -Force
    Write-Info ("backup: cordis.patch.yml.bak-" + $stamp)
}

$patchText = ''
if (Test-Path $patchFile) { $patchText = [System.IO.File]::ReadAllText($patchFile) }

if ($patchText -notmatch '(?m)^\s*-\s*id:\s*phone-bridge\s*$') {
    if ($patchText -and -not $patchText.EndsWith("`n")) { $patchText += "`n" }
    $patchText += "- id: phone-bridge`n  name: dsh-phone-bridge`n"
    Write-Ok "added phone-bridge plugin row"
}
else {
    Write-Ok "phone-bridge plugin row present"
}

if ($patchText -match '(?m)^\s*-\s*id:\s*webserver\s*$') {
    if ($patchText -match "host:\s*'?0\.0\.0\.0'?") {
        Write-Ok "webServer already at 0.0.0.0"
    }
    else {
        Write-Warn2 "webServer row exists but host is not 0.0.0.0"
        Write-Info "Edit that row's host to '0.0.0.0', or delete it and rerun."
    }
}
else {
    $block = @"
- id: webserver
  name: '@deepseek-ai/dsh-web-server'
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? $Port
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
  inject: [webStartup]
"@
    if ($patchText -and -not $patchText.EndsWith("`n")) { $patchText += "`n" }
    $patchText += $block
    Write-Ok "added webServer 0.0.0.0 override"
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($patchFile, $patchText, $utf8)
Write-Ok ("wrote: " + $patchFile)

# ======================================================= 5. install plugin

Write-Step "Install phone-bridge plugin"

$pluginTarget = Join-Path $dshHome 'phone-bridge'
if (Test-Path $pluginTarget) {
    $bak = $pluginTarget + '.bak-' + $stamp
    Copy-Item $pluginTarget $bak -Recurse -Force -ErrorAction SilentlyContinue
    Write-Info ("backup: " + $bak)
}

foreach ($item in @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'web', 'vendor', 'bin')) {
    $srcPath = Join-Path $root $item
    if (-not (Test-Path $srcPath)) { continue }
    $dstPath = Join-Path $pluginTarget $item
    $parent = Split-Path -Parent $dstPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item $srcPath $dstPath -Recurse -Force
}
Write-Ok ("plugin files -> " + $pluginTarget)

$nmDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
$nmLink = Join-Path $nmDir 'dsh-phone-bridge'

if (Test-Path $nmLink) { Remove-Item $nmLink -Recurse -Force -ErrorAction SilentlyContinue }
try {
    New-Item -ItemType Junction -Path $nmLink -Target $pluginTarget -ErrorAction Stop | Out-Null
    Write-Ok "junction in profile node_modules"
}
catch {
    Copy-Item $pluginTarget $nmLink -Recurse -Force
    Write-Ok "copied into profile node_modules"
}

# ======================================================= 6. token & URL

Write-Step "Generate pairing token"

$stateFile = Join-Path $pluginTarget 'state.json'
$token = $null
if (Test-Path $stateFile) {
    try {
        $st = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
        if ($st.token) { $token = $st.token; Write-Ok "reused existing token" }
    }
    catch { }
}
if (-not $token) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Write-Ok "generated new token"
}

$stateObj = @{}
if (Test-Path $stateFile) {
    try { $stateObj = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json -AsHashtable }
    catch { $stateObj = @{} }
}
if (-not $stateObj) { $stateObj = @{} }
$stateObj['token'] = $token
if (-not $stateObj.ContainsKey('cloudflaredPath')) { $stateObj['cloudflaredPath'] = $null }
if (-not $stateObj.ContainsKey('defaultShowThinking')) { $stateObj['defaultShowThinking'] = $false }
[System.IO.File]::WriteAllText($stateFile, ($stateObj | ConvertTo-Json -Depth 5), $utf8)
Write-Ok ("wrote: " + $stateFile)

$baseUrl = 'http://' + $script:TailscaleIp + ':' + $script:Port + '/phone-bridge'
$connectUrl = $baseUrl + '/?token=' + $token

# ======================================================= 7. restart DSH

Write-Step "Restart DSH to load the plugin"

if ($SkipRestart) {
    Write-Info "-SkipRestart specified"
}
else {
    $dshProc = Get-Process -Name 'DSH', 'dsh' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle } | Select-Object -First 1

    if ($dshProc) {
        Write-Info ("found " + $dshProc.ProcessName + " (PID " + $dshProc.Id + ")")
        if (Read-Yes "  Restart DSH now? Save your work first (y/N)") {
            $exePath = $null
            try { $exePath = $dshProc.Path } catch { }
            Stop-Process -Id $dshProc.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            if ($exePath -and (Test-Path $exePath)) {
                Start-Process $exePath
                Write-Ok "DSH restarted"
                Start-Sleep -Seconds 6
            }
            else {
                Write-Warn2 "relaunch DSH manually"
            }
        }
        else { Write-Info "restart later to activate the plugin" }
    }
    else { Write-Warn2 "no running DSH found" }
}

# ======================================================= 8. build APK

Write-Step "Build phone-bridge APK"

$apkPath = Join-Path $root 'apk-out\phone-bridge.apk'

if ($SkipApk) {
    Write-Info "-SkipApk specified"
    if (Test-Path $apkPath) { Write-Ok ("using existing build: " + $apkPath) }
    else { Write-Warn2 "no existing APK; the phone step will be skipped" }
}
else {
    $jdk = $null
    foreach ($c in @(
            $env:PHONE_BRIDGE_JAVA_HOME,
            'D:\bian_cheng_ruan_jian\jabba\jdk\zulu@17.0.9',
            (Join-Path $env:ProgramFiles 'Zulu\zulu-17'),
            (Join-Path $env:ProgramFiles 'Eclipse Adoptium\jdk-17')
        )) {
        if ($c -and (Test-Path $c)) { $jdk = $c; break }
    }
    $sdk = $null
    foreach ($c in @(
            $env:PHONE_BRIDGE_SDK,
            'D:\bian_cheng_ruan_jian\AndroidSdk\sdk',
            (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
        )) {
        if ($c -and (Test-Path $c)) { $sdk = $c; break }
    }

    if (-not $jdk -or -not $sdk) {
        if (-not $jdk) { Write-Warn2 "JDK 17 not found" }
        if (-not $sdk) { Write-Warn2 "Android SDK not found" }
        if (Test-Path $apkPath) { Write-Ok ("falling back to existing build: " + $apkPath) }
        else { Write-Warn2 "cannot build; phone step will be skipped" }
    }
    else {
        Write-Ok ("JDK: " + $jdk)
        Write-Ok ("SDK: " + $sdk)
        $env:JAVA_HOME = $jdk
        $env:PHONE_BRIDGE_JAVA_HOME = $jdk
        $env:PHONE_BRIDGE_SDK = $sdk
        if (-not $env:PHONE_BRIDGE_BUILD_TOOLS) { $env:PHONE_BRIDGE_BUILD_TOOLS = '34.0.0' }

        $buildScript = Join-Path $root 'build-apk.ps1'
        if (Test-Path $buildScript) {
            Write-Info "building with the detected IP and token baked in..."
            & powershell -ExecutionPolicy Bypass -File $buildScript -BaseUrl $baseUrl -Token $token
            if ($LASTEXITCODE -eq 0) { Write-Ok "APK built" }
            else { Write-Warn2 ("build failed (exit " + $LASTEXITCODE + ")") }
        }
        else { Write-Warn2 "build-apk.ps1 not found" }
    }
}

# ======================================================= 9. phone over USB

Write-Step "Deploy to the phone over USB"

if ($SkipPhone) {
    Write-Info "-SkipPhone specified"
}
else {
    $adb = Find-Adb
    if (-not $adb) {
        Write-Warn2 "adb not found"
        Write-Info "Install platform-tools, or set PHONE_BRIDGE_ADB to adb.exe"
        Write-Info "The phone can still use the browser URL."
    }
    else {
        Write-Ok ("adb: " + $adb)

        Invoke-Adb -Adb $adb -AdbArgs @('start-server') -Quiet | Out-Null
        Start-Sleep -Seconds 1

        $devices = @()
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $rawDevices = & $adb devices 2>&1
        }
        finally {
            $ErrorActionPreference = $prev
        }
        foreach ($line in ($rawDevices | Select-Object -Skip 1)) {
            $s = ([string]$line).Trim()
            if (-not $s) { continue }
            $parts = $s -split '\s+'
            if ($parts.Count -ge 2) {
                $devices += [pscustomobject]@{ Serial = $parts[0]; State = $parts[1] }
            }
        }

        $ready = @($devices | Where-Object { $_.State -eq 'device' })
        $unauthorized = @($devices | Where-Object { $_.State -eq 'unauthorized' })

        if ($ready.Count -eq 0) {
            if ($unauthorized.Count -gt 0) {
                Write-Warn2 "phone is connected but NOT authorized"
                Write-Info "Unlock the phone and tap 'Allow USB debugging'"
            }
            else {
                Write-Warn2 "no phone detected over USB"
                Write-Info "1. Connect the USB cable"
                Write-Info "2. Enable Developer options -> USB debugging"
                Write-Info "3. Accept the 'Allow USB debugging' prompt"
            }
            Write-Info "Then rerun with -SkipTailscale -SkipRestart to retry only the phone step."
        }
        else {
            $serial = $ready[0].Serial
            Write-Ok ("device: " + $serial)

            # NOTE: $args is a PowerShell automatic variable - never reuse it.
            $adbShell = @('-s', $serial, 'shell')
            $model = (& $adb @adbShell 'getprop ro.product.model' 2>&1 | Out-String).Trim()
            if ($model) { Write-Info ("model: " + $model) }

            $installed = (& $adb @adbShell 'pm list packages' 2>&1 | Out-String)

            # --- Tailscale on the phone ---
            if ($installed -match 'package:com\.tailscale\.ipn') {
                Write-Ok "Tailscale already installed on the phone"
            }
            else {
                $tsApk = Join-Path $root 'bin\tailscale-android.apk'
                if (-not (Test-Path $tsApk)) {
                    $tsApk = 'D:\bian_cheng_ruan_jian\Tailscale\tailscale-android.apk'
                }
                if (Test-Path $tsApk) {
                    Write-Info "installing Tailscale on the phone..."
                    $code = Invoke-Adb -Adb $adb -AdbArgs @('-s', $serial, 'install', '-r', $tsApk)
                    if ($code -eq 0) { Write-Ok "Tailscale installed" }
                    else { Write-Warn2 "Tailscale install failed" }
                }
                else {
                    Write-Warn2 "tailscale-android.apk not found"
                    Write-Info "Put it in bin\tailscale-android.apk, or install from the store"
                    Write-Info "Download: https://f-droid.org/repo/com.tailscale.ipn_298177930.apk"
                }
            }

            # --- phone-bridge app ---
            if (Test-Path $apkPath) {
                Write-Info "installing phone-bridge app..."
                $code = Invoke-Adb -Adb $adb -AdbArgs @('-s', $serial, 'install', '-r', $apkPath)
                if ($code -eq 0) {
                    Write-Ok "app installed (address and token baked in)"
                }
                else {
                    Write-Warn2 "app install failed"
                    Write-Info "If it reports a signature mismatch, uninstall first:"
                    Write-Info ("  adb -s " + $serial + " uninstall com.dsh.phonebridge")
                }
            }
            else {
                Write-Warn2 "no APK to install"
            }

            # --- grant the camera permissions up front ---
            foreach ($perm in @(
                    'android.permission.CAMERA',
                    'android.permission.READ_MEDIA_IMAGES'
                )) {
                Invoke-Adb -Adb $adb -AdbArgs @('-s', $serial, 'shell', 'pm', 'grant',
                    'com.dsh.phonebridge', $perm) -Quiet | Out-Null
            }
            Write-Ok "camera and photo permissions granted"

            # --- launch Tailscale so the user only has to sign in ---
            Write-Info "opening Tailscale on the phone..."
            Invoke-Adb -Adb $adb -AdbArgs @('-s', $serial, 'shell', 'monkey', '-p',
                'com.tailscale.ipn', '-c', 'android.intent.category.LAUNCHER', '1') -Quiet | Out-Null
            Start-Sleep -Seconds 2
            Write-Ok "sign in with the SAME Tailscale account and tap Connect"
        }
    }
}

# ============================================================== done

Write-Host ""
Write-Host ("=" * 64) -ForegroundColor Green
Write-Host "  Deployment finished" -ForegroundColor Green
Write-Host ("=" * 64) -ForegroundColor Green
Write-Host ""
Write-Host "  Phone URL:" -ForegroundColor White
Write-Host ("  " + $connectUrl) -ForegroundColor Cyan
Write-Host ""
Write-Host "  Remaining manual step on the phone:" -ForegroundColor White
Write-Host "    Sign in to Tailscale with the SAME account, tap Connect." -ForegroundColor Gray
Write-Host "    Then open the DSH app - it is already paired." -ForegroundColor Gray
Write-Host ""
Write-Host "  Troubleshooting:" -ForegroundColor White
Write-Host "    tailscale status                    PC connection state" -ForegroundColor Gray
Write-Host "    tailscale ip -4                     PC IP on the tailnet" -ForegroundColor Gray
Write-Host ("    Get-NetTCPConnection -LocalPort " + $script:Port + "   listen address") -ForegroundColor Gray
Write-Host "    adb devices                         phone connection" -ForegroundColor Gray
Write-Host ""
