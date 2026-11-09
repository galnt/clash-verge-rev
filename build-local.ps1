<#
  Local build script for clash-verge-rev 2.5.2 (Windows x64)
  Mirrors .github/workflows/autobuild.yml -> job autobuild-x86-windows-macos-linux
  Usage:  powershell -ExecutionPolicy Bypass -File .\build-local.ps1
  Optional: .\build-local.ps1 -Repo "E:\clash-verge" -Target x86_64-pc-windows-msvc
#>
param(
    [string]$Repo   = 'E:\clash-verge',
    [string]$Target = 'x86_64-pc-windows-msvc',
    [switch]$KeepUpdaterArtifacts,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path -LiteralPath $Repo).Path
Set-Location -LiteralPath $Repo
$log = Join-Path $Repo 'build-log.txt'
Set-Content -LiteralPath $log -Value '' -Encoding utf8

function Log([string]$msg) { Write-Host $msg; Add-Content -LiteralPath $log -Value $msg -Encoding utf8 }

function Run([string]$name, [string]$exe, [string[]]$argv) {
    Log "==> $name"
    Log ("    " + $exe + ' ' + ($argv -join ' '))
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $exe @argv *>&1 | Tee-Object -FilePath $log -Append | Out-Host
    $code = $LASTEXITCODE
    $sw.Stop()
    if ($code -ne 0) {
        Log ("[FAIL] $name exit=$code after " + [int]$sw.Elapsed.TotalSeconds + "s")
        throw "$name failed with exit code $code"
    }
    Log ("[OK]   $name in " + [int]$sw.Elapsed.TotalSeconds + "s")
}

function Need([string]$cmd, [string]$hint) {
    $p = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $p) {
        Log "[MISS] $cmd not found. $hint"
        throw "missing tool: $cmd"
    }
    return $p.Source
}

Log ("Repo   : " + $Repo)
Log ("Target : " + $Target)
Log ("Host   : " + $env:COMPUTERNAME + " / " + [Environment]::OSVersion.VersionString)
Log ("PS     : " + $PSVersionTable.PSVersion)

$node  = Need 'node'  'Install Node 26.x (CI uses 26.13.0): https://nodejs.org/'
$pnpm  = Need 'pnpm'  'Install: npm i -g pnpm@11.3.0'
$cargo = Need 'cargo' 'Install Rust via https://rustup.rs (CI uses 1.99.1)'

Run 'node -v'  $node  @('-v')
Run 'pnpm -v'  $pnpm  @('-v')
Run 'cargo -V' $cargo @('-V')

# rust target
Log '==> ensure rust target'
& $cargo @('--list') 2>$null | Out-Null
$rustup = Get-Command 'rustup' -ErrorAction SilentlyContinue
if ($rustup) { Run 'rustup target add' $rustup.Source @('target','add',$Target) }
else { Log '[WARN] rustup not found - if toolchain target is missing, cargo will report it' }

# MSVC linker sanity: import vcvars64 when link.exe is not already on PATH.
$link = Get-Command 'link.exe' -ErrorAction SilentlyContinue
if (-not $link) {
    $vcvars = $null
    $roots = @(
        'E:\VS2022BT',
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools')
    )
    foreach ($r in $roots) {
        $p = Join-Path $r 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path -LiteralPath $p) { $vcvars = $p; break }
    }
    if ($vcvars) {
        Log ("[INFO] importing MSVC env from " + $vcvars)
        $dump = (& cmd.exe /c ('call "' + $vcvars + '" >nul && set') 2>$null)
        foreach ($ln in $dump) {
            $i = $ln.IndexOf('=')
            if ($i -gt 0) {
                try { Set-Item -Path ('Env:' + $ln.Substring(0, $i)) -Value $ln.Substring($i + 1) -ErrorAction Stop } catch { }
            }
        }
        $link = Get-Command 'link.exe' -ErrorAction SilentlyContinue
    }
}
if (-not $link) {
    Log '[WARN] link.exe not on PATH. If cargo fails to link, install "Visual Studio Build Tools" with the C++ workload, or run from a "Developer PowerShell" / vcvars64 shell.'
} else {
    Log ("link.exe: " + $link.Source)
}

$env:NODE_OPTIONS = '--max-old-space-size=4096'
$env:TAURI_SIGNING_PRIVATE_KEY = ''
$env:HUSKY = '0'

# ---- 1. dependencies
# Only a changed lockfile means the dependency tree changed. scripts/version
# edits in package.json must not trigger pnpm 11 network verification here.
$modulesYaml = Join-Path $Repo 'node_modules\.modules.yaml'
$lockYaml = Join-Path $Repo 'pnpm-lock.yaml'
$needInstall = -not (Test-Path -LiteralPath $modulesYaml)
if (-not $needInstall -and (Test-Path -LiteralPath $lockYaml)) {
    $lockTime = (Get-Item -LiteralPath $lockYaml).LastWriteTime
    if ($lockTime -gt (Get-Item -LiteralPath $modulesYaml).LastWriteTime) { $needInstall = $true }
}
if ($SkipInstall) {
    Log '[SKIP] -SkipInstall given; node_modules left as-is'
} elseif ($needInstall) {
    Run 'pnpm install' $pnpm @('i')
} else {
    Log '[SKIP] node_modules is already installed and pnpm-lock.yaml is unchanged'
}

# ---- 2. prebuild (sidecars + resources into src-tauri)
Run 'pnpm run prebuild <target>' $pnpm @('run','prebuild',$Target)

# ---- 2b. speed test sidecar (implementation lives in its own entry script)
Run 'build speed test sidecar' (Join-Path $PSHOME 'powershell.exe') @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    (Join-Path $Repo 'scripts\build-speedtest-sidecar.ps1'),
    '-Repo', $Repo, '-Target', $Target
)

# ---- 3. updater artifacts guard
# tauri.conf.json has bundle.createUpdaterArtifacts=true AND plugins.updater.pubkey set.
# Tauri refuses to bundle in that case unless TAURI_SIGNING_PRIVATE_KEY is present.
$conf = Join-Path $Repo 'src-tauri\tauri.conf.json'
$backup = $conf + '.localbuild.bak'
Copy-Item -LiteralPath $conf -Destination $backup -Force
Log ("conf backup: " + $backup)

$hasKey = $env:TAURI_SIGNING_PRIVATE_KEY -and $env:TAURI_SIGNING_PRIVATE_KEY.Trim().Length -gt 0
if ($hasKey) {
    Log '[INFO] TAURI_SIGNING_PRIVATE_KEY is set - updater signatures will be produced'
} elseif ($KeepUpdaterArtifacts) {
    Log '[INFO] -KeepUpdaterArtifacts given but no key: build will likely fail at bundling'
} else {
    $raw = [IO.File]::ReadAllText($conf)
    $patched = [Regex]::Replace($raw, '"createUpdaterArtifacts"\s*:\s*true', '"createUpdaterArtifacts": false')
    if ($patched -ne $raw) {
        [IO.File]::WriteAllText($conf, $patched, (New-Object Text.UTF8Encoding $false))
        Log '[INFO] createUpdaterArtifacts set to false (no signing key locally; produced exe will NOT be updater-signed)'
    } else {
        Log '[WARN] could not patch createUpdaterArtifacts - leaving config as is'
    }
}

# ---- 4. build
try {
    Run 'pnpm build --target' $pnpm @('build','--target',$Target)
} finally {
    Copy-Item -LiteralPath $backup -Destination $conf -Force
    Remove-Item -LiteralPath $backup -Force
    Log '[INFO] tauri.conf.json restored'
}

# ---- 5. artifacts
$bundle = Join-Path $Repo ("target\" + $Target + "\release\bundle")
Log ("==> artifacts under " + $bundle)
if (Test-Path -LiteralPath $bundle) {
    Get-ChildItem -LiteralPath $bundle -Recurse -File |
        Where-Object { $_.Extension -in '.exe','.msi','.zip','.sig' } |
        ForEach-Object { Log ("    {0,10:N0} KB  {1}" -f ($_.Length/1KB), $_.FullName) }
} else {
    Log '[WARN] bundle dir not found - build may not have reached bundling'
}
Log 'DONE'
