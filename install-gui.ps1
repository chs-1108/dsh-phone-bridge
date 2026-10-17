# phone-bridge one-click installer with a real window.
#
# The flow the user sees:
#   1. A window opens and greets them.
#   2. It fetches what it needs (the repo itself, Tailscale, the APKs).
#   3. It asks them to plug in the phone by USB.
#   4. Everything else runs by itself and the window says where it is.
#   5. The only manual steps are the two logins, each announced in the window.
#
# Everything is written in ASCII on purpose: Windows PowerShell 5.1 reads a
# BOM-less script as the ANSI code page, so non-ASCII text here becomes a parse
# error on a Chinese Windows install.

[CmdletBinding()]
param(
    [switch]$Console,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Captured here because $MyInvocation inside a function refers to the caller.
$script:Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# ---------------------------------------------------------------- ui plumbing

$script:Form = $null
$script:LogBox = $null
$script:Status = $null
$script:Bar = $null
$script:Cancel = $false
$script:Bg = $null

function New-Window {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'phone-bridge installer'
    $form.Size = New-Object System.Drawing.Size(760, 620)
    $form.StartPosition = 'CenterScreen'
    $form.BackColor = [System.Drawing.Color]::FromArgb(24, 30, 48)
    $form.ForeColor = [System.Drawing.Color]::White
    $form.FormBorderStyle = 'FixedSingle'
    $form.MaximizeBox = $false
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'phone-bridge   one-click install'
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
    $title.ForeColor = [System.Drawing.Color]::FromArgb(140, 170, 255)
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(24, 18)
    $form.Controls.Add($title)

    $sub = New-Object System.Windows.Forms.Label
    $sub.Text = 'Phone talks to the DSH running on this PC. Nothing to configure by hand.'
    $sub.ForeColor = [System.Drawing.Color]::FromArgb(150, 165, 200)
    $sub.AutoSize = $true
    $sub.Location = New-Object System.Drawing.Point(26, 52)
    $form.Controls.Add($sub)

    $status = New-Object System.Windows.Forms.Label
    $status.Text = 'Starting...'
    $status.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
    $status.ForeColor = [System.Drawing.Color]::FromArgb(220, 230, 255)
    $status.AutoEllipsis = $true
    $status.Size = New-Object System.Drawing.Size(700, 24)
    $status.Location = New-Object System.Drawing.Point(26, 92)
    $form.Controls.Add($status)

    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Location = New-Object System.Drawing.Point(26, 120)
    $bar.Size = New-Object System.Drawing.Size(700, 8)
    $bar.Style = 'Continuous'
    $bar.Minimum = 0
    $bar.Maximum = 100
    $form.Controls.Add($bar)

    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.ScrollBars = 'Vertical'
    $log.BackColor = [System.Drawing.Color]::FromArgb(16, 21, 34)
    $log.ForeColor = [System.Drawing.Color]::FromArgb(180, 200, 240)
    $log.Font = New-Object System.Drawing.Font('Consolas', 9)
    $log.Location = New-Object System.Drawing.Point(26, 142)
    $log.Size = New-Object System.Drawing.Size(700, 380)
    $log.BorderStyle = 'FixedSingle'
    $form.Controls.Add($log)

    $close = New-Object System.Windows.Forms.Button
    $close.Text = 'Close'
    $close.Location = New-Object System.Drawing.Point(646, 534)
    $close.Size = New-Object System.Drawing.Size(80, 30)
    $close.Enabled = $false
    $close.Add_Click({ $script:Form.Close() })
    $form.Controls.Add($close)

    $script:Form = $form
    $script:Status = $status
    $script:Bar = $bar
    $script:LogBox = $log
    $script:CloseButton = $close
}

function Write-Ui {
    param([string]$Text, [string]$Tone = 'info')
    if (-not $script:LogBox) { Write-Host $Text; return }
    $stamp = Get-Date -Format 'HH:mm:ss'
    $line = "  $stamp  $Text"
    $script:LogBox.AppendText($line + "`r`n")
    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-Stage {
    param([string]$Text, [int]$Percent)
    if ($script:Status) {
        $script:Status.Text = $Text
        $script:Bar.Value = [Math]::Max(0, [Math]::Min(100, $Percent))
    }
    [System.Windows.Forms.Application]::DoEvents()
}

function Show-Info {
    param([string]$Text, [string]$Title = 'phone-bridge')
    # In -Console mode there is no window to host a modal box, and a modal box
    # would also stall the background worker that drives the GUI. Announce in
    # the log either way, and only pop a box when a real window exists.
    Write-Ui ('  >> ' + ($Text -replace "`r`n", ' ' -replace "`n", ' '))
    if ($script:LogBox -and $script:Form) {
        [void][System.Windows.Forms.MessageBox]::Show($Text, $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information)
    }
}

function Show-Error {
    param([string]$Text)
    Write-Ui ('  !! ' + ($Text -replace "`r`n", ' ' -replace "`n", ' '))
    if ($script:LogBox -and $script:Form) {
        [void][System.Windows.Forms.MessageBox]::Show($Text, 'phone-bridge - stopped',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    }
}

# Run one step. Both paths write to the same log, so -Console and the window
# stay in sync.
function Invoke-Step {
    param([string]$Label, [int]$Percent, [scriptblock]$Action)
    Set-Stage $Label $Percent
    Write-Ui $Label
    & $Action
}

# ---------------------------------------------------------------- ui helpers

function Format-Bytes {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} B' -f $Bytes)
}

# Download with progress, one range request at a time so the bar can move.
function Save-File {
    param(
        [string]$Url,
        [string]$OutFile,
        [string]$What
    )
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $OutFile + '.part'
    if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }

    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.UserAgent = 'phone-bridge-installer'
        $req.Timeout = 60000
        $req.ReadWriteTimeout = 300000
        $resp = $req.GetResponse()
        try {
            $total = $resp.ContentLength
            $in = $resp.GetResponseStream()
            $out = [System.IO.File]::Create($tmp)
            try {
                $buf = New-Object byte[] 262144
                $done = 0
                $lastTick = 0
                while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                    $out.Write($buf, 0, $n)
                    $done += $n
                    if (-not $script:LogBox) {
                        if ($done -ge ($lastTick + 10MB)) {
                            $lastTick = $done
                            Write-Ui ("    " + $What + ": " + (Format-Bytes $done) + " / " + (Format-Bytes $total))
                        }
                    }
                    elseif ($total -gt 0) {
                        $pct = 10 + [int](55 * (($done / $total)))
                        Set-Stage ("Downloading " + $What + "  " + (Format-Bytes $done) + " / " + (Format-Bytes $total)) $pct
                    }
                }
            }
            finally { $out.Dispose(); $in.Dispose() }
            Move-Item -LiteralPath $tmp -Destination $OutFile -Force
        }
        finally { $resp.Dispose() }
    }
    catch {
        if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
    finally {
        $ProgressPreference = $prevProgress
    }
}

# ---------------------------------------------------------------- the install

function Invoke-Install {
    # $MyInvocation inside a function reports the caller, not the script, so the
    # script root is captured once at load time into $script:Root.
    $root = $script:Root
    Set-Location $root

    # --- 0. where are we ------------------------------------------------
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Ui 'WARNING: not running as Administrator.'
        Write-Ui 'Tailscale install and profile patching may fail.'
        Write-Ui 'If something breaks, close this and use right-click > Run as administrator.'
    }

    $dshHome = Join-Path $env:USERPROFILE '.dsh'
    $profilesDir = Join-Path $dshHome 'profiles'

    # --- 1. DSH present ------------------------------------------------
    Invoke-Step 'Checking that DSH has run on this PC at least once' 6 {
        if (-not (Test-Path $profilesDir)) {
            throw ("No DSH profile at " + $profilesDir + ".`n`nStart the DSH desktop app once, quit it, then run this installer again.")
        }
        Write-Ui ('  found ' + $profilesDir)
    }

    $profileName = 'desktop'
    $profileDir = Join-Path $profilesDir $profileName
    if (-not (Test-Path $profileDir)) {
        $first = Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '^_' } | Select-Object -First 1
        if (-not $first) { throw 'No usable DSH profile found.' }
        $profileName = $first.Name
        $profileDir = $first.FullName
    }
    Write-Ui ('  profile: ' + $profileName)

    # --- 2. Tailscale on the PC ---------------------------------------
    Invoke-Step 'Installing Tailscale on this PC' 14 {
        $ts = Find-Tool -Name 'tailscale' -Exe 'tailscale.exe' -EnvVar 'PHONE_BRIDGE_TAILSCALE' -SubDirs @('Tailscale')
        if ($ts) {
            Write-Ui ('  already installed: ' + $ts)
            return
        }
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            throw "Tailscale is not installed and winget is unavailable.`n`nInstall it from https://tailscale.com/download/windows then run this again."
        }
        Write-Ui '  not found, installing via winget (this takes a minute)...'
        $p = Start-Process -FilePath 'winget' `
            -ArgumentList @('install', '--id', 'Tailscale.Tailscale', '--accept-package-agreements',
                '--accept-source-agreements', '--silent') `
            -Wait -PassThru -NoNewWindow
        if ($p.ExitCode -ne 0) {
            throw ("winget failed (exit " + $p.ExitCode + ").`n`nInstall Tailscale manually from https://tailscale.com/download/windows")
        }
        Start-Sleep -Seconds 3
        $ts = Find-Tool -Name 'tailscale' -Exe 'tailscale.exe' -EnvVar 'PHONE_BRIDGE_TAILSCALE' -SubDirs @('Tailscale')
        if (-not $ts) { throw 'Tailscale installed but tailscale.exe was not found.' }
        Write-Ui ('  installed: ' + $ts)
    }

    # --- 3. Tailscale service -----------------------------------------
    Invoke-Step 'Making sure the Tailscale service is running' 22 {
        $svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
        if ($svc) {
            if ($svc.Status -ne 'Running') {
                Start-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            try { Set-Service -Name 'Tailscale' -StartupType Automatic -ErrorAction SilentlyContinue } catch { }
            Write-Ui '  service running, starts at boot'
        }
        else {
            Write-Ui '  no service yet, the app will start it'
        }
    }

    # --- 4. login (the one manual PC step) ----------------------------
    Set-Stage 'Waiting for you to sign in to Tailscale' 28
    $ts = Find-Tool -Name 'tailscale' -Exe 'tailscale.exe' -EnvVar 'PHONE_BRIDGE_TAILSCALE' -SubDirs @('Tailscale')
    $statusRaw = ''
    try { $statusRaw = (& $ts status 2>&1 | Out-String) } catch { }

    $needsLogin = ($statusRaw -match 'Logged out') -or ($statusRaw -match 'NeedsLogin') -or
                  ($statusRaw -match 'stopped') -or ($statusRaw.Trim() -eq '')

    if ($needsLogin) {
        Write-Ui '--- YOUR TURN 1 of 2 ---'
        Write-Ui 'Tailscale needs you to sign in.'
        Write-Ui 'A browser will open. Use YOUR OWN Tailscale account.'
        Write-Ui 'Free signup if you have none: https://login.tailscale.com/start'
        Show-Info "Tailscale needs you to sign in.`n`nA browser opens next. Use YOUR OWN account (free to create).`n`nWhen you are done, come back here - the installer continues by itself." 'Step 1 of 2 - sign in to Tailscale'
        Start-Process -FilePath $ts -ArgumentList @('up', '--accept-routes=false') -ErrorAction SilentlyContinue
        Write-Ui '  browser opened, waiting for sign-in to finish...'

        $ip = $null
        for ($i = 0; $i -lt 150; $i++) {
            Start-Sleep -Seconds 2
            $ip = Get-TailscaleIp -Exe $ts
            if ($ip) { break }
            if ($i % 5 -eq 0) { Write-Ui '  still waiting for Tailscale login...' }
        }
        if (-not $ip) {
            throw "Tailscale did not come up within 5 minutes.`n`nOpen Tailscale from the system tray, sign in, then run this installer again."
        }
        Write-Ui ('  signed in, this PC is ' + $ip)
    }
    else {
        $ip = Get-TailscaleIp -Exe $ts
        if (-not $ip) {
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 800
                $ip = Get-TailscaleIp -Exe $ts
                if ($ip) { break }
            }
        }
        if (-not $ip) { throw 'Tailscale is signed in but no 100.x address was readable.' }
        Write-Ui ('  already signed in, this PC is ' + $ip)
    }
    $script:TailscaleIp = $ip

    # --- 5. port -----------------------------------------------------
    Invoke-Step 'Working out which port DSH is listening on' 40 {
        $script:Port = Find-DshPort
        Write-Ui ('  port ' + $script:Port)
    }

    # --- 6. profile patch --------------------------------------------
    Invoke-Step 'Pointing the DSH web server at the network' 48 {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $patchFile = Join-Path $profileDir 'cordis.patch.yml'
        $backupDir = Join-Path $dshHome '_phone-bridge-backup'
        if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

        $text = ''
        if (Test-Path $patchFile) {
            Copy-Item $patchFile (Join-Path $backupDir ('cordis.patch.yml.' + $stamp)) -Force
            $text = [System.IO.File]::ReadAllText($patchFile)
        }

        if ($text -notmatch '(?m)^\s*-\s*id:\s*phone-bridge\s*$') {
            if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
            $text += "- id: phone-bridge`n  name: dsh-phone-bridge`n"
            Write-Ui '  registered the plugin'
        }
        else { Write-Ui '  plugin already registered' }

        if ($text -match '(?m)^\s*-\s*id:\s*webserver\s*$') {
            $rowPattern = '(?ms)^\s*-\s*id:\s*webserver\s*$.*?(?=^\s*-\s*id:\s*|\z)'
            $row = [regex]::Match($text, $rowPattern)
            if ($row.Success -and $row.Value -match "host:\s*'?0\.0\.0\.0'?") {
                Write-Ui '  web server already reachable on the network'
            }
            else {
                throw "Your cordis.patch.yml already has a webserver row that does not use host: '0.0.0.0'.`n`nOpen it, change that row's host to '0.0.0.0', and run this installer again.`n`nFile: $patchFile"
            }
        }
        else {
            $block = @"
- id: webserver
  name: '@deepseek-ai/dsh-web-server'
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? $($script:Port)
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
  inject: [webStartup]
"@
            if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
            $text += $block
            Write-Ui '  made the web server reachable on the network'
        }

        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchFile, $text, $utf8)
        Write-Ui ('  backup kept in ' + $backupDir)
    }

    # --- 7. install the plugin files ---------------------------------
    Invoke-Step 'Installing the phone-bridge plugin' 56 {
        $target = Join-Path $dshHome 'phone-bridge'
        $items = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'web', 'vendor', 'bin')
        if (Test-Path $target) {
            $backupDir = Join-Path $dshHome '_phone-bridge-backup'
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Copy-Item $target (Join-Path $backupDir ('phone-bridge.' + $stamp)) -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($item in $items) {
            $src = Join-Path $root $item
            if (-not (Test-Path $src)) { continue }
            $dst = Join-Path $target $item
            $parent = Split-Path -Parent $dst
            if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item $src $dst -Recurse -Force
        }
        Write-Ui ('  files -> ' + $target)

        $nmDir = Join-Path $profileDir 'node_modules'
        if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
        $link = Join-Path $nmDir 'dsh-phone-bridge'
        if (Test-Path $link) { Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue }
        try {
            New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null
            Write-Ui '  linked into the profile'
        }
        catch {
            Copy-Item $target $link -Recurse -Force
            Write-Ui '  copied into the profile'
        }
    }

    # --- 8. token ----------------------------------------------------
    Invoke-Step 'Creating the pairing key' 62 {
        $stateFile = Join-Path (Join-Path $dshHome 'phone-bridge') 'state.json'
        $token = $null
        if (Test-Path $stateFile) {
            try {
                $st = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
                if ($st.token) { $token = $st.token; Write-Ui '  reusing the existing key' }
            }
            catch { }
        }
        if (-not $token) {
            $bytes = New-Object byte[] 24
            [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
            Write-Ui '  generated a new key'
        }
        $obj = @{}
        if (Test-Path $stateFile) {
            try { $obj = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json -AsHashtable } catch { $obj = @{} }
        }
        if (-not $obj) { $obj = @{} }
        $obj['token'] = $token
        if (-not $obj.ContainsKey('cloudflaredPath')) { $obj['cloudflaredPath'] = $null }
        if (-not $obj.ContainsKey('defaultShowThinking')) { $obj['defaultShowThinking'] = $false }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($stateFile, ($obj | ConvertTo-Json -Depth 5), $utf8)
        $script:Token = $token
    }

    $script:BaseUrl = 'http://' + $script:TailscaleIp + ':' + $script:Port + '/phone-bridge'
    $script:ConnectUrl = $script:BaseUrl + '/?token=' + $script:Token

    # --- 9. restart DSH ----------------------------------------------
    Invoke-Step 'Restarting DSH so it picks up the plugin' 70 {
        $proc = Get-Process -Name 'DSH', 'dsh' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle } | Select-Object -First 1
        if (-not $proc) {
            Write-Ui '  DSH is not running; start it yourself afterwards'
            return
        }
        $answer = [System.Windows.Forms.MessageBox]::Show(
            "DSH has to restart to load the plugin.`n`nSave your work, then press Yes.",
            'Restart DSH now?',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
            Write-Ui '  skipped; restart DSH yourself to activate the plugin'
            return
        }
        $exe = $null
        try { $exe = $proc.Path } catch { }
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        if ($exe -and (Test-Path $exe)) {
            Start-Process $exe
            Write-Ui '  DSH restarted'
            Start-Sleep -Seconds 8
        }
        else {
            Write-Ui '  could not relaunch automatically; open DSH yourself'
        }
    }

    # --- 10. adb + phone ---------------------------------------------
    Invoke-Step 'Looking for the Android tools needed to talk to your phone' 78 {
        $script:Adb = Find-Tool -Name 'adb' -Exe 'adb.exe' -EnvVar 'PHONE_BRIDGE_ADB' -SubDirs @('platform-tools')
        if ($script:Adb) { Write-Ui ('  adb: ' + $script:Adb) }
        else {
            Write-Ui '  adb not found - the phone has to be set up by hand'
            Write-Ui '  (that is fine: the browser address works without the app)'
        }
    }

    $phoneOk = $false
    if ($script:Adb) {
        Set-Stage 'Plug your phone in with a USB cable' 82
        Write-Ui ''
        Write-Ui '--- YOUR TURN 2 of 2 ---'
        Write-Ui 'Plug the phone in with a USB cable.'
        Write-Ui 'On the phone: Settings > About phone > tap Build number 7 times,'
        Write-Ui 'then Developer options > turn on USB debugging.'
        Write-Ui 'When the phone asks Allow USB debugging, tap Allow.'
        Write-Ui ''
        Show-Info "Plug the phone in with a USB cable now.`n`nOn the phone:`n  1. Settings > About phone > tap Build number 7 times`n  2. Developer options > enable USB debugging`n  3. Tap Allow when the phone asks`n`nThe installer is already looking for it and continues by itself." 'Step 2 of 2 - connect the phone'

        $serial = Wait-ForDevice -TimeoutSec 300
        if ($serial) {
            Write-Ui ('  phone found: ' + $serial)
            $phoneOk = $true
        }
        else {
            Write-Ui '  no phone appeared within 5 minutes; skipping the phone'
            Write-Ui '  you can still use the browser address below'
        }
    }

    # --- 11. build the APK -------------------------------------------
    $apkPath = Join-Path $root 'apk-out\phone-bridge.apk'
    Invoke-Step 'Building the Android app with your address baked in' 88 {
        $jdk = Find-Jdk
        $sdk = Find-AndroidSdk
        if (-not $jdk -or -not $sdk) {
            if (-not $jdk) { Write-Ui '  JDK 17 not found - cannot build the app' }
            if (-not $sdk) { Write-Ui '  Android SDK not found - cannot build the app' }
            if (Test-Path $apkPath) { Write-Ui '  using the build that came with the download' }
            else { Write-Ui '  skipping; use the browser address instead' }
            return
        }
        Write-Ui ('  JDK: ' + $jdk)
        Write-Ui ('  SDK: ' + $sdk)
        $env:JAVA_HOME = $jdk
        $env:PHONE_BRIDGE_JAVA_HOME = $jdk
        $env:PHONE_BRIDGE_SDK = $sdk
        if (-not $env:PHONE_BRIDGE_BUILD_TOOLS) { $env:PHONE_BRIDGE_BUILD_TOOLS = '34.0.0' }
        $builder = Join-Path $root 'build-apk.ps1'
        if (-not (Test-Path $builder)) { Write-Ui '  build-apk.ps1 missing'; return }
        $p = Start-Process -FilePath 'powershell' `
            -ArgumentList @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $builder,
                '-BaseUrl', $script:BaseUrl, '-Token', $script:Token) `
            -Wait -PassThru -NoNewWindow
        if ($p.ExitCode -eq 0 -and (Test-Path $apkPath)) { Write-Ui '  app built' }
        else { Write-Ui ('  build failed (exit ' + $p.ExitCode + ')') }
    }

    # --- 12. push everything to the phone ----------------------------
    if ($phoneOk) {
        Invoke-Step 'Installing Tailscale and the app on your phone' 94 {
            $adb = $script:Adb
            $serial = $script:Serial

            $packages = Invoke-Adb -Adb $adb -Serial $serial -AdbArgs @('shell', 'pm', 'list', 'packages') -QuietText
            if ($packages -match 'package:com\.tailscale\.ipn') {
                Write-Ui '  Tailscale already on the phone'
            }
            else {
                $tsApk = Join-Path $root 'bin\tailscale-android.apk'
                if (-not (Test-Path $tsApk)) {
                    Write-Ui '  fetching Tailscale for Android (about 100 MB, one time)...'
                    try {
                        Save-File -Url 'https://f-droid.org/repo/com.tailscale.ipn_298177930.apk' `
                            -OutFile $tsApk -What 'Tailscale for Android'
                        Write-Ui ('  downloaded ' + (Format-Bytes (Get-Item $tsApk).Length))
                    }
                    catch {
                        Write-Ui ('  download failed: ' + $_.Exception.Message)
                        Write-Ui '  install Tailscale from the Play Store on the phone instead'
                    }
                }
                if (Test-Path $tsApk) {
                    $code = Invoke-Adb -Adb $adb -Serial $serial -AdbArgs @('install', '-r', $tsApk)
                    if ($code -eq 0) { Write-Ui '  Tailscale installed on the phone' }
                    else { Write-Ui '  Tailscale install failed' }
                }
            }

            if (Test-Path $apkPath) {
                $code = Invoke-Adb -Adb $adb -Serial $serial -AdbArgs @('install', '-r', $apkPath)
                if ($code -eq 0) { Write-Ui '  DSH app installed and already paired' }
                else {
                    Write-Ui '  app install failed'
                    Write-Ui ('  if it says signatures conflict: adb -s ' + $serial + ' uninstall com.dsh.phonebridge')
                }
            }
            else { Write-Ui '  no app to install' }

            foreach ($perm in @('android.permission.CAMERA', 'android.permission.READ_MEDIA_IMAGES')) {
                Invoke-Adb -Adb $adb -Serial $serial `
                    -AdbArgs @('shell', 'pm', 'grant', 'com.dsh.phonebridge', $perm) -Quiet | Out-Null
            }
            Write-Ui '  camera and photo permissions granted'

            Invoke-Adb -Adb $adb -Serial $serial `
                -AdbArgs @('shell', 'monkey', '-p', 'com.tailscale.ipn', '-c',
                    'android.intent.category.LAUNCHER', '1') -Quiet | Out-Null
            Write-Ui '  Tailscale opened on the phone'
        }
    }

    # --- 13. verify ---------------------------------------------------
    Invoke-Step 'Checking that the plugin is alive' 97 {
        $ok = $false
        for ($i = 0; $i -lt 15; $i++) {
            try {
                $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $script:Port + '/phone-bridge/health') `
                    -UseBasicParsing -TimeoutSec 3
                if ($r.Content -match '"ok"\s*:\s*true') { $ok = $true; break }
            }
            catch { }
            Start-Sleep -Seconds 2
        }
        if ($ok) { Write-Ui '  plugin answered: healthy' }
        else { Write-Ui '  no answer yet; it should come up once DSH is running' }
    }

    Set-Stage 'Done' 100
    Write-Ui ''
    Write-Ui '================================================'
    Write-Ui '  Installation finished'
    Write-Ui '================================================'
    Write-Ui ''
    Write-Ui '  Open this on the phone:'
    Write-Ui ('  ' + $script:ConnectUrl)
    Write-Ui ''
    if ($phoneOk) {
        Write-Ui '  On the phone, one last thing:'
        Write-Ui '    Open Tailscale > sign in with the SAME account > tap Connect.'
        Write-Ui '    Then open the DSH app - it is already paired.'
    }
    else {
        Write-Ui '  On the phone:'
        Write-Ui '    Install Tailscale, sign in with the same account, open the URL above.'
    }
    Write-Ui ''

    return $script:ConnectUrl
}

# ---------------------------------------------------------------- tool finders

function Find-Tool {
    param(
        [string]$Name,
        [string]$Exe,
        [string]$EnvVar,
        [string[]]$SubDirs
    )
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($EnvVar) {
        $v = [Environment]::GetEnvironmentVariable($EnvVar)
        if ($v) {
            # The override may be either the executable itself or its directory.
            $item = Get-Item -LiteralPath $v -ErrorAction SilentlyContinue
            if ($item -and -not $item.PSIsContainer) { return $item.FullName }
            if ($item -and $item.PSIsContainer) { $candidates.Add($item.FullName) }
        }
    }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
        Where-Object { $_ }
    foreach ($sub in $SubDirs) {
        foreach ($root in $roots) {
            if ($root) { $candidates.Add((Join-Path $root $sub)) }
        }
        if ($env:LOCALAPPDATA) {
            $candidates.Add((Join-Path $env:LOCALAPPDATA ('Android\Sdk\' + $sub)))
        }
    }
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        $direct = Join-Path $c $Exe
        if (Test-Path -LiteralPath $direct) { return $direct }
    }
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Find-Jdk {
    $candidates = @(
        $env:PHONE_BRIDGE_JAVA_HOME,
        $env:JAVA_HOME,
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Zulu\zulu-17' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Eclipse Adoptium\jdk-17' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft\jdk-17' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Java\jdk-17' })
    ) | Where-Object { $_ }
    foreach ($c in $candidates) {
        $javac = Join-Path $c 'bin\javac.exe'
        if (Test-Path -LiteralPath $javac) { return $c }
    }
    return $null
}

function Find-AndroidSdk {
    $candidates = @(
        $env:PHONE_BRIDGE_SDK,
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Android\Sdk' })
    ) | Where-Object { $_ }
    foreach ($c in $candidates) {
        $bt = Join-Path $c 'build-tools'
        if (Test-Path -LiteralPath $bt) { return $c }
    }
    return $null
}

function Find-DshPort {
    $found = @()
    try {
        foreach ($conn in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'dsh|electron|deepseek') { $found += $conn.LocalPort }
        }
    }
    catch { }
    $found = $found | Sort-Object -Unique
    if ($found -contains 19387) { return 19387 }
    if ($found.Count -gt 0) { return $found[0] }
    return 19387
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

# ---------------------------------------------------------------- adb helpers

function Invoke-Adb {
    param(
        [string]$Adb,
        [string]$Serial,
        [string[]]$AdbArgs,
        [switch]$Quiet
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $all = @()
        if ($Serial) { $all += @('-s', $Serial) }
        $all += $AdbArgs
        $out = & $Adb @all 2>&1
        $code = $LASTEXITCODE
        if (-not $Quiet) {
            foreach ($line in $out) { Write-Ui ('    ' + [string]$line) }
        }
        $script:LastAdbText = ($out | Out-String)
        return $code
    }
    finally { $ErrorActionPreference = $prev }
}

function Wait-ForDevice {
    param([int]$TimeoutSec = 300)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $hinted = $false
    while ((Get-Date) -lt $deadline) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $raw = & $script:Adb devices 2>&1 } finally { $ErrorActionPreference = $prev }
        $ready = @()
        $unauth = @()
        foreach ($line in ($raw | Select-Object -Skip 1)) {
            $s = ([string]$line).Trim()
            if (-not $s) { continue }
            $parts = $s -split '\s+'
            if ($parts.Count -lt 2) { continue }
            if ($parts[1] -eq 'device') { $ready += [pscustomobject]@{ Serial = $parts[0] } }
            elseif ($parts[1] -eq 'unauthorized') { $unauth += $parts[0] }
        }
        if ($ready.Count -gt 0) {
            $script:Serial = $ready[0].Serial
            return $script:Serial
        }
        if ($unauth.Count -gt 0 -and -not $hinted) {
            Write-Ui '  phone is connected but not authorised yet'
            Write-Ui '  unlock it and tap "Allow" on the USB debugging prompt'
            $hinted = $true
        }
        Set-Stage 'Plug your phone in with a USB cable - waiting...' 84
        Start-Sleep -Seconds 2
    }
    return $null
}

# ---------------------------------------------------------------- entry point

if ($Console) {
    $script:LogBox = $null
    try {
        $url = Invoke-Install
        Write-Host ''
        Write-Host ('  Phone URL: ' + $url)
        exit 0
    }
    catch {
        Write-Host ''
        Write-Host ('  STOPPED: ' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}

New-Window

# The install runs on a background job so the window keeps repainting.
$script:Bg = [System.ComponentModel.BackgroundWorker]::new()
$script:Bg.WorkerReportsProgress = $false
$script:Bg.DoWork += {
    try {
        $script:Result = Invoke-Install
        $script:ErrorMessage = $null
    }
    catch {
        $script:ErrorMessage = $_.Exception.Message
    }
}
$script:Bg.RunWorkerCompleted += {
    $script:CloseButton.Enabled = $true
    if ($script:ErrorMessage) {
        Set-Stage 'Stopped' 100
        Write-Ui ('STOPPED: ' + $script:ErrorMessage)
        Show-Error ($script:ErrorMessage + "`n`nThe window keeps the full log.")
    }
    else {
        Set-Stage 'Done' 100
        Show-Info ("Installation finished.`n`nOpen this on the phone:`n" + $script:Result +
            "`n`nOn the phone, sign in to Tailscale with the SAME account and tap Connect.")
    }
}

$script:Form.Add_Shown({ $script:Bg.RunWorkerAsync() })
[void]$script:Form.ShowDialog()
