<#
  oneclick-build.ps1  (v6.1)
  Local build for clash-verge-rev 2.5.2 on Windows x64, mirroring CI windows-latest.

  v6 / v6.1 changes (why this version exists):
  1. Every sub-step of [5/6] now prints a marker with elapsed seconds, so a stall is
     visible immediately instead of looking like a silent hang.
  2. All HTTP calls carry an explicit -TimeoutSec (Invoke-WebRequest has NO default
     timeout on PowerShell 5.1, which is what made earlier runs wait forever).
  3. pnpm install is SKIPPED when node_modules is already healthy (that is the usual
     reason [5/6] sits there with no output - pnpm 11 re-verifies the lockfile against
     supply-chain policies over the network). Use -ForceInstall to reinstall anyway.
  4. prebuild is invoked as `node scripts/prebuild.mjs <target>` for live output, and
     all of its downloads are pre-staged here, so prebuild runs fully offline.
  5. Rust: no longer switches rustup default to another version. The version pinned by
     the repo's rust-toolchain.toml (1.95.0) is used, and it is only downloaded if it is
     not installed yet - this removes a slow network sync from every run.
  6. v6.1: the final build no longer goes through `pnpm build`. pnpm 11 runs a lockfile
     "supply-chain policy" verification before any script starts, and that check can sit
     on the network for a very long time with no output - which is exactly what made
     [6/6] look frozen. The tauri CLI is now called directly, and the beforeBuildCommand
     hook is rewritten in the temporary config to call node directly as well.

  Usage:
    build.bat                       (recommended; it finds node/pnpm/MSVC/cargo)
    powershell -ExecutionPolicy Bypass -File oneclick-build.ps1 -Repo E:\clash-verge
    ... -ForceInstall               reinstall node_modules
    ... -SkipInstall                never touch node_modules (same as default when healthy)
    ... -SkipAssets                 do not download sidecar/geo resources
    ... -SkipBuild                  stop after prebuild (fast sanity check)
    ... -Proxy http://127.0.0.1:7890 downloads through a local proxy
#>
param(
    [string]$Repo    = 'E:\clash-verge',
    [string]$Target  = 'x86_64-pc-windows-msvc',
    [string]$Proxy   = '',
    [switch]$NoMirror,
    [switch]$ForceInstall,
    [switch]$SkipInstall,
    [switch]$SkipAssets,
    [switch]$SkipBuild,
    [string[]]$ToolRoots = @('E:\throne-tools', 'E:\VS2022BT')
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'          # IWR progress bar makes 5.1 crawl
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$script:ProxyUrl = $null
if ($Proxy) { $env:HTTP_PROXY = $Proxy; $env:HTTPS_PROXY = $Proxy; $script:ProxyUrl = $Proxy }

if (-not (Test-Path -LiteralPath $Repo)) { Write-Host "[FATAL] repo not found: $Repo"; exit 1 }
$Repo = (Resolve-Path -LiteralPath $Repo).Path
Set-Location -LiteralPath $Repo

# ---------------------------------------------------------------- logging
$script:LogWriter = $null
$script:LogPath   = $null

function Init-Log([string]$repo) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $cands = @((Join-Path $repo 'oneclick-log.txt'), (Join-Path $repo ('oneclick-log-' + $stamp + '.txt')))
    foreach ($c in $cands) {
        try {
            $enc = New-Object System.Text.UTF8Encoding($false)
            $sw  = New-Object System.IO.StreamWriter($c, $false, $enc)   # not exclusive
            $sw.AutoFlush = $true
            $script:LogPath   = $c
            $script:LogWriter = $sw
            return $c
        } catch { }
    }
    return $null
}

function Say([string]$m) {
    Write-Host $m
    if ($script:LogWriter) { try { $script:LogWriter.WriteLine($m); $script:LogWriter.Flush() } catch { } }
}

$script:StepStart = Get-Date
function Mark([string]$m) {
    $script:StepStart = Get-Date
    Say $m
}
function Done([string]$m) {
    $s = [int]((Get-Date) - $script:StepStart).TotalSeconds
    if ($m) { Say ('[DONE] ' + $m + '  (' + $s + 's)') } else { Say ('[DONE] ' + $s + 's') }
}

function Run([string]$exe, [string[]]$params) {
    & $exe @params 2>&1 | ForEach-Object {
        $s = [string]$_
        Write-Host $s
        if ($script:LogWriter) { try { $script:LogWriter.WriteLine($s); $script:LogWriter.Flush() } catch { } }
    }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [int]$code
}

function Resolve-Exe([string]$name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    $src = $c.Source
    if (-not $src) { return $c }
    $dir = Split-Path -Parent $src
    foreach ($ext in @('.cmd', '.exe', '.bat')) {
        $p = Join-Path $dir ($name + $ext)
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $src
}

function AddPathDir([string]$dir) {
    if (-not $dir) { return $false }
    if (-not (Test-Path -LiteralPath $dir)) { return $false }
    $parts = $env:Path -split ';'
    if ($parts -notcontains $dir) { $env:Path = $dir + ';' + $env:Path }
    return $true
}

function FindExe([string]$name, [string]$root, [int]$depth) {
    if (-not (Test-Path -LiteralPath $root)) { return $null }
    try {
        $hit = Get-ChildItem -LiteralPath $root -Recurse -Depth $depth -File -Filter $name -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) { return $hit.FullName }
    } catch { }
    return $null
}

$logResult = Init-Log $Repo

Say '=================================================================='
Say ('oneclick-build v6.1 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ('Repo    : ' + $Repo)
Say ('Target  : ' + $Target)
Say ('Host    : ' + $env:COMPUTERNAME + ' / ' + [Environment]::OSVersion.VersionString)
Say ('PS      : ' + $PSVersionTable.PSVersion.ToString())
Say ('ToolRoot: ' + ($ToolRoots -join ' ; '))
if ($logResult) {
    Say ('Log     : ' + $logResult)
    if ($logResult -ne (Join-Path $Repo 'oneclick-log.txt')) {
        Say '[WARN] oneclick-log.txt is locked by another window - logging to the file above'
    }
} else {
    Say '[WARN] cannot open any log file - console output only'
}

# ---------------------------------------------------------------- 0. mirrors
if (-not $NoMirror) {
    Say ''
    Say '[0/6] CN mirrors'
    if (-not $env:RUSTUP_DIST_SERVER) { $env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn' }
    if (-not $env:RUSTUP_UPDATE_ROOT)  { $env:RUSTUP_UPDATE_ROOT  = 'https://rsproxy.cn/rustup' }
    if (-not $env:npm_config_registry) { $env:npm_config_registry = 'https://registry.npmmirror.com' }
    Say ('[OK]   RUSTUP_DIST_SERVER  = ' + $env:RUSTUP_DIST_SERVER)
    Say ('[OK]   RUSTUP_UPDATE_ROOT = ' + $env:RUSTUP_UPDATE_ROOT)
    Say ('[OK]   npm registry       = ' + $env:npm_config_registry)

    $cargoDir = Join-Path $env:USERPROFILE '.cargo'
    if (-not (Test-Path -LiteralPath $cargoDir)) { New-Item -ItemType Directory -Path $cargoDir | Out-Null }
    $cargoCfg  = Join-Path $cargoDir 'config.toml'
    $mirrorCfg = "[source.crates-io]`r`nreplace-with = 'rsproxy-sparse'`r`n`r`n[source.rsproxy-sparse]`r`nregistry = 'sparse+https://rsproxy.cn/index/'`r`n`r`n[net]`r`ngit-fetch-with-cli = true`r`n"
    if (-not (Test-Path -LiteralPath $cargoCfg)) {
        [IO.File]::WriteAllText($cargoCfg, $mirrorCfg, (New-Object Text.UTF8Encoding $false))
        Say ('[OK]   wrote ' + $cargoCfg)
    } else {
        $txt = [IO.File]::ReadAllText($cargoCfg)
        if ($txt -match 'rsproxy') {
            Say ('[INFO] cargo config already mirrored: ' + $cargoCfg)
        } elseif ($txt -notmatch '\[source\.crates-io\]') {
            Copy-Item -LiteralPath $cargoCfg -Destination ($cargoCfg + '.bak') -Force
            [IO.File]::WriteAllText($cargoCfg, ($txt.TrimEnd() + "`r`n`r`n" + $mirrorCfg), (New-Object Text.UTF8Encoding $false))
            Say ('[OK]   appended mirror, backup: ' + $cargoCfg + '.bak')
        } else {
            Say ('[WARN] existing [source.crates-io] left untouched: ' + $cargoCfg)
        }
    }
}

# ---------------------------------------------------------------- 1. node
Say ''
Say '[1/6] Node'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    foreach ($r in $ToolRoots) {
        $p = FindExe 'node.exe' $r 4
        if ($p) {
            AddPathDir (Split-Path -Parent $p) | Out-Null
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($nodeCmd) { break }
        }
    }
}
if (-not $nodeCmd) { Say '[FATAL] node not found. Install: winget install OpenJS.NodeJS.LTS -e'; exit 1 }
$nv = ((& node -v) 2>$null | Out-String).Trim()
Say ('[OK]   node ' + $nv + '  -> ' + $nodeCmd.Source)
if ($nv -match 'v(\d+)') {
    if ([int]$Matches[1] -lt 22) { Say ('[WARN] node major ' + [int]$Matches[1] + ' is below 22; vite 8 / react 19 may fail') }
}

# ---------------------------------------------------------------- 2. pnpm
Say ''
Say '[2/6] pnpm'
$pnpmExe = Resolve-Exe 'pnpm'
if (-not $pnpmExe) {
    foreach ($r in $ToolRoots) {
        $p = FindExe 'pnpm.cmd' $r 4
        if ($p) { AddPathDir (Split-Path -Parent $p) | Out-Null; $pnpmExe = $p; break }
    }
}
if (-not $pnpmExe -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    $prefix = ((& npm prefix -g) 2>$null | Out-String).Trim()
    if ($prefix) { AddPathDir $prefix | Out-Null }
    $pnpmExe = Resolve-Exe 'pnpm'
}
if (-not $pnpmExe) {
    $npmExe = Resolve-Exe 'npm'
    if (-not $npmExe) { Say '[FATAL] npm missing too'; exit 1 }
    Say '[INFO] installing pnpm'
    Run $npmExe @('i','-g','pnpm') | Out-Null
    $prefix = ((& npm prefix -g) 2>$null | Out-String).Trim()
    if ($prefix) { AddPathDir $prefix | Out-Null }
    $pnpmExe = Resolve-Exe 'pnpm'
}
if (-not $pnpmExe) { Say '[FATAL] pnpm still missing after install'; exit 1 }
Say ('[OK]   pnpm ' + (((& $pnpmExe -v) 2>$null | Out-String).Trim()) + '  -> ' + $pnpmExe)

# ---------------------------------------------------------------- 3. MSVC
Say ''
Say '[3/6] MSVC toolchain'
$vcvars = $null
$candidates = @()

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $out = (& $vswhere @('-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath') 2>$null)
    if ($out) { foreach ($line in $out) { if ($line.Trim()) { $candidates += $line.Trim() } } }
}
foreach ($r in $ToolRoots) {
    if (Test-Path -LiteralPath $r) {
        $candidates += $r
        $sub = Join-Path $r 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path -LiteralPath $sub) { $vcvars = $sub; break }
    }
}
if (-not $vcvars) {
    foreach ($c in $candidates) {
        $bat = Join-Path $c 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path -LiteralPath $bat) { $vcvars = $bat; break }
    }
}
if (-not $vcvars) {
    foreach ($r in $ToolRoots) {
        $p = FindExe 'vcvars64.bat' $r 6
        if ($p) { $vcvars = $p; break }
    }
}

if ($vcvars) {
    Say ('[OK]   vcvars64: ' + $vcvars)
    Mark '[3.1] importing MSVC environment'
    $dump = (& cmd.exe /c ('call "' + $vcvars + '" >nul && set') 2>$null)
    foreach ($ln in $dump) {
        $i = $ln.IndexOf('=')
        if ($i -gt 0) {
            $k = $ln.Substring(0, $i)
            $v = $ln.Substring($i + 1)
            try { Set-Item -Path ('Env:' + $k) -Value $v -ErrorAction Stop } catch { }
        }
    }
    Done 'MSVC env imported'
} else {
    Say '[MISS] vcvars64.bat not found in vswhere results or ToolRoots'
}

$linkCmd = Get-Command link.exe -ErrorAction SilentlyContinue
if ($linkCmd) {
    Say ('[OK]   link.exe: ' + $linkCmd.Source)
} else {
    Say '[FATAL] link.exe unavailable - MSVC C++ workload missing.'
    exit 1
}

# ---------------------------------------------------------------- 4. rust
Say ''
Say '[4/6] Rust'
$cargoExe = Resolve-Exe 'cargo'
if (-not $cargoExe) {
    foreach ($r in $ToolRoots) {
        $p = FindExe 'cargo.exe' $r 5
        if ($p) { AddPathDir (Split-Path -Parent $p) | Out-Null; $cargoExe = $p; break }
    }
}
$cargoHome = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not $cargoExe) {
    AddPathDir $cargoHome | Out-Null
    $cargoExe = Resolve-Exe 'cargo'
}
if (-not $cargoExe) {
    Say '[MISS] cargo not found - installing rustup'
    $winget = Resolve-Exe 'winget'
    if ($winget) { Run $winget @('install','--id','Rustlang.Rustup','-e','--accept-source-agreements','--accept-package-agreements') | Out-Null }
    AddPathDir $cargoHome | Out-Null
    $cargoExe = Resolve-Exe 'cargo'
}
if (-not $cargoExe) {
    Say '[INFO] fallback: rustup-init from rsproxy.cn'
    $tmp = Join-Path $env:TEMP 'rustup-init.exe'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    $p = @('-UseBasicParsing','-TimeoutSec','120','-Uri','https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe','-OutFile',$tmp)
    if ($script:ProxyUrl) { $p += @('-Proxy',$script:ProxyUrl) }
    try {
        Invoke-WebRequest @p | Out-Null
        Run $tmp @('-y','--default-toolchain','none','--profile','minimal') | Out-Null
    } catch {
        Say ('[WARN] rustup-init failed: ' + $_.Exception.Message)
    }
    AddPathDir $cargoHome | Out-Null
    $cargoExe = Resolve-Exe 'cargo'
}
if (-not $cargoExe) { Say '[FATAL] cargo unavailable after all attempts'; exit 1 }

# The repo pins its toolchain in rust-toolchain.toml and that pin wins over
# `rustup default`; installing/switching to another version is pure network
# wait, so only make sure the pinned version exists.
$pinFile = Join-Path $Repo 'rust-toolchain.toml'
$pinVer  = $null
if (Test-Path -LiteralPath $pinFile) {
    $pinTxt = [IO.File]::ReadAllText($pinFile)
    if ($pinTxt -match 'channel\s*=\s*"([0-9]+(?:\.[0-9]+)+(?:-[a-z]+)?)"') { $pinVer = $Matches[1] }
}
if ($pinVer) {
    Say ('[INFO] repo pins rust ' + $pinVer + ' via rust-toolchain.toml (it overrides rustup default)')
    $rustupExe = Resolve-Exe 'rustup'
    if ($rustupExe) {
        $list = ((& $rustupExe @('toolchain','list') 2>$null) | Out-String)
        if ($list -match [Regex]::Escape($pinVer)) {
            Say ('[OK]   toolchain ' + $pinVer + ' already installed - no download')
        } else {
            Say ('[INFO] installing toolchain ' + $pinVer)
            $rc = Run $rustupExe @('toolchain','install',$pinVer)
            if ($rc -eq 0) { Say ('[OK]   toolchain ' + $pinVer + ' installed') } else { Say ('[WARN] toolchain install exit ' + $rc) }
        }
    } else {
        Say '[WARN] rustup not found - relying on the rustc already on PATH'
    }
} else {
    Say '[INFO] no rust-toolchain.toml pin found'
}

$rvOut = ((& rustc -V) 2>$null | Out-String).Trim()
Say ('[OK]   rustc: ' + $rvOut + '  -> ' + $cargoExe)

$rustupExe = Resolve-Exe 'rustup'
if ($rustupExe) {
    $list = ((& $rustupExe @('target','list','--installed') 2>$null) | Out-String)
    if ($list -match 'x86_64-pc-windows-msvc') {
        Say '[OK]   target x86_64-pc-windows-msvc present'
    } else {
        Say '[INFO] adding target x86_64-pc-windows-msvc'
        Run $rustupExe @('target','add','x86_64-pc-windows-msvc') | Out-Null
    }
}

# ---------------------------------------------------------------- 5. deps + assets
Say ''
Say '[5/6] deps + prebuild assets'

$SidecarDir = Join-Path $Repo 'src-tauri\sidecar'
$ResDir     = Join-Path $Repo 'src-tauri\resources'
$TempRoot   = Join-Path $Repo 'node_modules\.verge'
foreach ($d in @($SidecarDir, $ResDir, $TempRoot)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$script:CacheFile = Join-Path $TempRoot '.version_cache.json'

# ---------- 5.1 install
Mark '[5.1] dependency install'
$modulesYaml = Join-Path $Repo 'node_modules\.modules.yaml'
$lockYaml    = Join-Path $Repo 'pnpm-lock.yaml'
$haveModules = Test-Path -LiteralPath $modulesYaml
$staleDeps   = $false
if ($haveModules) {
    $modulesTime = (Get-Item -LiteralPath $modulesYaml).LastWriteTime
    # Only a changed lockfile means the dependency tree changed. package.json
    # is often newer just because scripts/version changed; using it here would
    # trigger pnpm 11 supply-chain verification (which looks like a hang).
    if (Test-Path -LiteralPath $lockYaml) {
        $lockTime = (Get-Item -LiteralPath $lockYaml).LastWriteTime
        if ($lockTime -gt $modulesTime) { $staleDeps = $true }
    } else {
        $pkgTime = (Get-Item -LiteralPath (Join-Path $Repo 'package.json')).LastWriteTime
        if ($pkgTime -gt $modulesTime) { $staleDeps = $true }
    }
}
if ($SkipInstall) {
    Say '[SKIP] -SkipInstall given; node_modules left as-is'
} elseif ($haveModules -and -not $ForceInstall -and -not $staleDeps) {
    Say '[SKIP] node_modules is already installed and pnpm-lock.yaml is unchanged'
    Say '       (scripts-only package.json edits no longer trigger pnpm 11 network verification)'
    Say '       use -ForceInstall to reinstall anyway'
} elseif (-not $haveModules) {
    Say '[INFO] node_modules missing - running pnpm install (this can take several minutes)'
    $env:NODE_OPTIONS = '--max-old-space-size=4096 --dns-result-order=ipv4first'
    $env:HUSKY = '0'
    $rc = Run $pnpmExe @('i','--prefer-offline','--reporter=append-only')
    if ($rc -ne 0) { Say ('[WARN] pnpm install exit ' + $rc + ' - continuing, prebuild may fail') } else { Say '[OK]   pnpm install finished' }
} else {
    Say '[INFO] pnpm-lock.yaml is newer than node_modules - running pnpm install'
    $env:NODE_OPTIONS = '--max-old-space-size=4096 --dns-result-order=ipv4first'
    $env:HUSKY = '0'
    $rc = Run $pnpmExe @('i','--prefer-offline','--reporter=append-only')
    if ($rc -ne 0) { Say ('[WARN] pnpm install exit ' + $rc + ' - continuing') } else { Say '[OK]   pnpm install finished' }
}
Done 'install step'

# ---------- 5.2 resource staging
$env:NODE_OPTIONS = '--max-old-space-size=4096 --dns-result-order=ipv4first'
$env:HUSKY = '0'
$script:NetDead = $false
$script:FailStreak = 0

function Http-Text([string]$url, [int]$timeout) {
    for ($i = 1; $i -le 2; $i++) {
        try {
            $p = @('-UseBasicParsing','-TimeoutSec',$timeout,'-Uri',$url)
            if ($script:ProxyUrl) { $p += @('-Proxy',$script:ProxyUrl) }
            $r = Invoke-WebRequest @p
            return ([string]$r.Content).Trim()
        } catch {
            Say ('  [ERR] ' + $_.Exception.Message)
            Start-Sleep -Seconds 2
        }
    }
    return $null
}

function Http-Save([string]$url, [string]$dest, [int]$timeout) {
    for ($i = 1; $i -le 2; $i++) {
        try {
            $p = @('-UseBasicParsing','-TimeoutSec',$timeout,'-Uri',$url,'-OutFile',$dest)
            if ($script:ProxyUrl) { $p += @('-Proxy',$script:ProxyUrl) }
            Invoke-WebRequest @p | Out-Null
            return $true
        } catch {
            Say ('  [ERR] ' + $_.Exception.Message)
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function FindUnder([string]$dir, [string]$name) {
    $hit = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Asset-File([string]$label, [string]$url, [string]$dest, [int]$minBytes) {
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -ge $minBytes)) {
        Say ('[SKIP] ' + $label + ' already staged')
        return $true
    }
    if ($script:NetDead) { Say ('[SKIP] ' + $label + ' - network looked dead, skipping'); return $false }
    Say ('[GET ] ' + $label + '  <- ' + $url)
    $t0 = Get-Date
    $ok = Http-Save $url $dest 180
    if ($ok -and (Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -ge $minBytes) {
        Say ('[OK]   ' + $label + '  (' + [int]((Get-Date) - $t0).TotalSeconds + 's, ' + [int]((Get-Item -LiteralPath $dest).Length / 1KB) + ' KB)')
        $script:FailStreak = 0
        return $true
    }
    Say ('[WARN] ' + $label + ' staging failed')
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
    $script:FailStreak++
    if ($script:FailStreak -ge 3) {
        $script:NetDead = $true
        Say '[WARN] three downloads failed in a row - assuming GitHub is unreachable from this network'
        Say '       (try again with -Proxy http://127.0.0.1:7890 if you have a local proxy)'
    }
    return $false
}

function Asset-Zip([string]$label, [string]$url, [string]$entryName, [string]$dest, [int]$minBytes) {
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -ge $minBytes)) {
        Say ('[SKIP] ' + $label + ' already staged')
        return $true
    }
    if ($script:NetDead) { Say ('[SKIP] ' + $label + ' - network looked dead, skipping'); return $false }
    Say ('[GET ] ' + $label + '  <- ' + $url)
    $t0 = Get-Date
    $tmpZip = Join-Path $TempRoot ([Guid]::NewGuid().ToString('N') + '.zip')
    $tmpDir = Join-Path $TempRoot ([Guid]::NewGuid().ToString('N') + '-x')
    try {
        if (-not (Http-Save $url $tmpZip 240)) { throw 'download failed' }
        Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
        $src = FindUnder $tmpDir $entryName
        if (-not $src) { throw ('entry not found in archive: ' + $entryName) }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        Say ('[OK]   ' + $label + '  (' + [int]((Get-Date) - $t0).TotalSeconds + 's)')
        $script:FailStreak = 0
        return $true
    } catch {
        Say ('[WARN] ' + $label + ' :: ' + $_.Exception.Message)
        $script:FailStreak++
        if ($script:FailStreak -ge 3) { $script:NetDead = $true; Say '[WARN] three downloads failed in a row - skipping the rest' }
        return $false
    } finally {
        Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$alphaExe  = Join-Path $SidecarDir ('verge-mihomo-alpha-' + $Target + '.exe')
$stableExe = Join-Path $SidecarDir ('verge-mihomo-' + $Target + '.exe')
$svcExes   = @('clash-verge-service.exe','clash-verge-service-install.exe','clash-verge-service-uninstall.exe') |
             ForEach-Object { Join-Path $ResDir $_ }
$geoFiles  = @(@('Country.mmdb',1000000), @('geosite.dat',1000000), @('geoip.dat',1000000), @('enableLoopback.exe',50000)) |
             ForEach-Object { Join-Path $ResDir $_[0] }
$nsisDir   = Join-Path $env:APPDATA 'Local\NSIS'
$scDll     = Join-Path $nsisDir 'SimpleSC.dll'

$allStaged = $true
foreach ($f in @($alphaExe,$stableExe,$scDll) + $svcExes + $geoFiles) {
    if (-not (Test-Path -LiteralPath $f)) { $allStaged = $false; break }
}

Mark '[5.2] prebuild resources'

# Known-good versions, used when GitHub is slow/unreachable. They are only used to
# build a download URL and to fill the version cache - prebuild itself checks the
# staged files first, so a stale number never breaks an already-staged build.
$fbAlpha  = 'alpha-478af2a'
$fbStable = 'v1.19.33'
$fbSvc    = 'v2.7.7'

$script:AlphaVer  = $fbAlpha
$script:StableVer = $fbStable
$script:SvcVer    = $fbSvc

if ($allStaged) {
    Say '[OK]   every resource is already in place - skipping version lookups entirely'
} elseif ($SkipAssets) {
    Say '[SKIP] -SkipAssets given; missing resources are left for prebuild to download'
} else {
    $v = Http-Text 'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/version.txt' 20
    if ($v) { $script:AlphaVer = $v; Say ('[OK]   mihomo alpha  = ' + $v) } else { Say ('[WARN] alpha version lookup failed - falling back to ' + $fbAlpha) }

    $v = Http-Text 'https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt' 20
    if ($v) { $script:StableVer = $v; Say ('[OK]   mihomo stable = ' + $v) } else { Say ('[WARN] stable version lookup failed - falling back to ' + $fbStable) }

    try {
        $p = @('-UseBasicParsing','-TimeoutSec','20','-MaximumRedirection','8','-Uri','https://github.com/clash-verge-rev/clash-verge-service-ipc/releases/latest')
        if ($script:ProxyUrl) { $p += @('-Proxy',$script:ProxyUrl) }
        $r = Invoke-WebRequest @p
        $final = $r.BaseResponse.ResponseUri
        if (-not $final) { $final = $r.BaseResponse.RequestMessage.RequestUri }
        if ($final -and ($final.ToString() -match '/tag/([^/#?]+)')) { $script:SvcVer = $Matches[1] }
        Say ('[OK]   service version = ' + $script:SvcVer)
    } catch {
        Say ('[WARN] service version lookup failed - falling back to ' + $fbSvc)
    }

    Asset-Zip 'mihomo alpha sidecar' ('https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/mihomo-windows-amd64-v2-' + $script:AlphaVer + '.zip') 'mihomo-windows-amd64-v2.exe' $alphaExe 3000000 | Out-Null
    Asset-Zip 'mihomo stable sidecar' ('https://github.com/MetaCubeX/mihomo/releases/download/' + $script:StableVer + '/mihomo-windows-amd64-v2-' + $script:StableVer + '.zip') 'mihomo-windows-amd64-v2.exe' $stableExe 3000000 | Out-Null

    $svcZip = 'https://github.com/clash-verge-rev/clash-verge-service-ipc/releases/download/' + $script:SvcVer + '/clash-verge-service-ipc-' + $script:SvcVer + '-' + $Target + '.zip'
    foreach ($n in @('clash-verge-service.exe','clash-verge-service-install.exe','clash-verge-service-uninstall.exe')) {
        Asset-Zip ('service ' + $n) $svcZip $n (Join-Path $ResDir $n) 200000 | Out-Null
    }

    Asset-File 'Country.mmdb' 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb' (Join-Path $ResDir 'Country.mmdb') 1000000 | Out-Null
    Asset-File 'geosite.dat'  'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat'  (Join-Path $ResDir 'geosite.dat')  1000000 | Out-Null
    Asset-File 'geoip.dat'    'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat'    (Join-Path $ResDir 'geoip.dat')    1000000 | Out-Null
    Asset-File 'enableLoopback.exe' 'https://github.com/Kuingsmile/uwp-tool/releases/download/latest/enableLoopback.exe' (Join-Path $ResDir 'enableLoopback.exe') 50000 | Out-Null

    if (-not (Test-Path -LiteralPath $nsisDir)) { New-Item -ItemType Directory -Path $nsisDir -Force | Out-Null }
    Asset-Zip 'NSIS SimpleSC plugin' 'https://nsis.sourceforge.io/mediawiki/images/e/ef/NSIS_Simple_Service_Plugin_Unicode_1.30.zip' 'SimpleSC.dll' $scDll 10000 | Out-Null
}
Done 'resource staging'

# ---------- 5.3 version cache (prebuild reads this for 1h and never calls GitHub)
function Write-VersionCache() {
    $ms = [int64]((([DateTime]::UtcNow) - ([DateTime]'1970-01-01T00:00:00Z')).TotalMilliseconds)
    $cache = @{
        META_ALPHA_VERSION = @{ version = $script:AlphaVer; timestamp = $ms }
        META_VERSION       = @{ version = $script:StableVer; timestamp = $ms }
        SERVICE_VERSION    = @{ version = $script:SvcVer; timestamp = $ms }
    }
    $json = $cache | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($script:CacheFile, $json, (New-Object Text.UTF8Encoding $false))
}
Mark '[5.3] version cache'
Write-VersionCache
Say ('[OK]   wrote ' + $script:CacheFile + '  (alpha=' + $script:AlphaVer + ', stable=' + $script:StableVer + ', service=' + $script:SvcVer + ')')
Done 'cache'

# ---------- 5.4 prebuild
Mark '[5.4] prebuild (node scripts/prebuild.mjs)'
$preMjs = Join-Path $Repo 'scripts\prebuild.mjs'
if (-not (Test-Path -LiteralPath $preMjs)) {
    Say ('[FATAL] missing ' + $preMjs)
    exit 1
}
$rc = Run $nodeCmd.Source @($preMjs, $Target)
if ($rc -eq 0) {
    Say '[OK]   prebuild finished'
} else {
    Say ('[WARN] prebuild exit ' + $rc + ' - see lines above. If it says "fetch failed", the')
    Say '       resource staging above did not cover a file; rerun with -Proxy if you have one.'
}
Done 'prebuild'

# ---------- 5.5 speed test sidecar (implementation lives in its own entry script)
Mark '[5.5] build speed test sidecar'
$psExe = Join-Path $PSHOME 'powershell.exe'
$speedScript = Join-Path $Repo 'scripts\build-speedtest-sidecar.ps1'
$rc = Run $psExe @('-NoProfile','-ExecutionPolicy','Bypass','-File',$speedScript,'-Repo',$Repo,'-Target',$Target)
if ($rc -ne 0) {
    Say '[FATAL] speed test sidecar build failed'
    exit 1
}
Done 'speed test sidecar'

# ---------------------------------------------------------------- 6. tauri build
Say ''
Say '[6/6] tauri build'
if ($SkipBuild) {
    Say '[SKIP] -SkipBuild given; stopping after prebuild'
    if ($script:LogWriter) { try { $script:LogWriter.Flush(); $script:LogWriter.Close() } catch { } }
    Say 'DONE'
    exit 0
}

$code  = 1
$conf  = Join-Path $Repo 'src-tauri\tauri.conf.json'
$bak   = $conf + '.oneclick.bak'
Copy-Item -LiteralPath $conf -Destination $bak -Force

# ---- 6.0 tauri CLI must answer instantly. If this step hangs, the npm/pnpm layer is
# ----     the problem, not cargo.
Mark '[6.0] tauri CLI'
$tauriJs  = Join-Path $Repo 'node_modules\@tauri-apps\cli\tauri.js'
$tauriCli = $null
if (Test-Path -LiteralPath $tauriJs) { $tauriCli = $tauriJs }
if (-not $tauriCli) {
    foreach ($n in @('tauri.cmd','tauri.exe','tauri.ps1','tauri')) {
        $p = Join-Path $Repo ('node_modules\.bin\' + $n)
        if (Test-Path -LiteralPath $p) { $tauriCli = $p; break }
    }
}
if ($tauriCli) {
    Say ('[OK]   ' + $tauriCli)
    if ($tauriCli.ToLower().EndsWith('.js')) {
        $ver = ((& $nodeCmd.Source $tauriCli --version 2>&1) | Out-String).Trim()
    } else {
        $ver = ((& $tauriCli --version 2>&1) | Out-String).Trim()
    }
    Say ('[OK]   tauri-cli: ' + $ver)
} else {
    Say '[WARN] tauri CLI not found under node_modules - will fall back to pnpm build'
}
$stale = @(Get-Process cargo,rustc -ErrorAction SilentlyContinue)
if ($stale.Count -gt 0) {
    Say ('[WARN] ' + $stale.Count + ' cargo/rustc process(es) already running - a previous build may still hold the target lock')
}
Done 'tauri CLI'

# ---- 6.1 temporary config: drop the updater signature requirement, and remove pnpm
# ----      from the web-build hook so nothing in the build chain re-enters `pnpm run`.
Mark '[6.1] patch tauri.conf.json (temporary)'
$raw     = [IO.File]::ReadAllText($conf)
$patched = $raw
$signKey = $env:TAURI_SIGNING_PRIVATE_KEY
if ($signKey -and $signKey.Trim().Length -gt 0) {
    Say '[INFO] signing key present - updater artifacts will be signed'
} else {
    $patched = [Regex]::Replace($patched, '"createUpdaterArtifacts"\s*:\s*true', '"createUpdaterArtifacts": false')
    Say '[INFO] no signing key - createUpdaterArtifacts temporarily disabled'
}
$webHook  = 'node node_modules/vite/bin/vite.js build'
$rewritten = [Regex]::Replace($patched, '"beforeBuildCommand"\s*:\s*"[^"]*"', ('"beforeBuildCommand": "' + $webHook + '"'))
if ($rewritten -ne $patched) {
    $patched = $rewritten
    Say '[INFO] beforeBuildCommand rewritten (web build no longer goes through pnpm):'
    Say ('       ' + $webHook)
}
[IO.File]::WriteAllText($conf, $patched, (New-Object Text.UTF8Encoding $false))
Done 'config patch'

# ---- 6.1b type check (CI runs `tsc --noEmit && vite build`; we run tsc here so the
# ----      hook can stay a single command that works without a shell)
Mark '[6.1b] tsc --noEmit'
$tscJs = Join-Path $Repo 'node_modules\typescript\bin\tsc'
if (Test-Path -LiteralPath $tscJs) {
    $rc = Run $nodeCmd.Source @($tscJs,'--noEmit')
    if ($rc -eq 0) { Say '[OK]   type check clean' } else { Say ('[WARN] type check exit ' + $rc + ' - vite build continues, but CI would reject this') }
} else {
    Say '[WARN] typescript not installed - skipping type check'
}
Done 'type check'

# ---- 6.2 the real build
Mark '[6.2] cargo build + nsis bundle'
Say '[INFO] this compiles several hundred crates on a first run - 20 to 40 minutes is normal'
Say '[INFO] a silent stretch while rustc works is expected; check CPU of cargo.exe/rustc.exe'
Write-VersionCache   # refresh: the cache TTL is 1 hour and tauri runs prebuild again here
try {
    if ($tauriCli -and $tauriCli.ToLower().EndsWith('.js')) {
        $code = Run $nodeCmd.Source @($tauriCli,'build','--target',$Target)
    } elseif ($tauriCli) {
        $code = Run $tauriCli @('build','--target',$Target)
    } else {
        $code = Run $pnpmExe @('build','--target',$Target)
    }
} finally {
    if (Test-Path -LiteralPath $bak) {
        Copy-Item -LiteralPath $bak -Destination $conf -Force
        Remove-Item -LiteralPath $bak -Force
    }
    Say '[INFO] tauri.conf.json restored'
}
Done 'build'

Say ''
Say '=================================================================='
if ($code -eq 0) { Say 'BUILD OK' } else { Say ('BUILD FAILED exit=' + $code) }

$bundle = Join-Path $Repo ('target\' + $Target + '\release\bundle')
if (Test-Path -LiteralPath $bundle) {
    Say ('artifacts: ' + $bundle)
    Get-ChildItem -LiteralPath $bundle -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { @('.exe','.msi','.sig','.zip') -contains $_.Extension } |
        ForEach-Object { Say ('    {0,10:N0} KB  {1}' -f ($_.Length / 1KB), $_.FullName) }
} else {
    Say '[WARN] bundle directory not created'
}

if ($script:LogWriter) { try { $script:LogWriter.Flush(); $script:LogWriter.Close() } catch { } }
Say 'DONE'
exit $code
</content>
