<#
  Fast incremental installer build (menu mode 6).

  Assumes dependencies, resources and the speed test sidecar are already built
  (menu 2/4/5). Skips install, asset staging, prebuild, sidecar rebuild and
  tsc; only patches tauri.conf.json temporarily, runs `tauri build`, then
  restores the config. MSVC environment must be imported by the caller BAT.

  ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#>
param(
    [string]$Repo   = 'E:\clash-verge',
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path -LiteralPath $Repo).Path
Set-Location -LiteralPath $Repo

$conf    = Join-Path $Repo 'src-tauri\tauri.conf.json'
$backup  = $conf + '.fastbuild.bak'
$sidecar = Join-Path $Repo ("src-tauri\sidecar\verge-throne-core-$Target.exe")
$tauriJs = Join-Path $Repo 'node_modules\@tauri-apps\cli\tauri.js'
$nodeCmd = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $sidecar)) {
    throw "speed test sidecar missing: $sidecar (run menu 2 first)"
}
if (-not (Test-Path -LiteralPath $tauriJs)) {
    throw "tauri CLI missing: $tauriJs"
}
$link = Get-Command link.exe -ErrorAction SilentlyContinue
if (-not $link) {
    throw 'link.exe unavailable - import vcvars64.bat before calling this script'
}

# Self-heal: an interrupted run may have left the config patched.
if (Test-Path -LiteralPath $backup) {
    Write-Host '[fast] recovering config from an interrupted run'
    Copy-Item -LiteralPath $backup -Destination $conf -Force
    Remove-Item -LiteralPath $backup -Force
}

Write-Host '[fast] sidecar and toolchain ready, starting incremental tauri build'
Copy-Item -LiteralPath $conf -Destination $backup -Force
try {
    $raw = [IO.File]::ReadAllText($conf)
    # Idempotent: the config may already be patched by an interrupted build.
    $patched = [Regex]::Replace($raw, '"createUpdaterArtifacts"\s*:\s*(?:true|false)', '"createUpdaterArtifacts": false')
    $patched = [Regex]::Replace($patched, '"beforeBuildCommand"\s*:\s*"[^"]*"', '"beforeBuildCommand": "node node_modules/vite/bin/vite.js build"')
    [IO.File]::WriteAllText($conf, $patched, (New-Object Text.UTF8Encoding $false))

    & $nodeCmd $tauriJs build --target $Target
    if ($LASTEXITCODE -ne 0) {
        throw "tauri build failed with exit code $LASTEXITCODE"
    }
} finally {
    if (Test-Path -LiteralPath $backup) {
        Copy-Item -LiteralPath $backup -Destination $conf -Force
        Remove-Item -LiteralPath $backup -Force
        Write-Host '[fast] tauri.conf.json restored'
    }
}

$bundle = Join-Path $Repo ("target\$Target\release\bundle\nsis")
Write-Host ("[fast] artifacts: " + $bundle)
Get-ChildItem -LiteralPath $bundle -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ('  ' + $_.FullName) }
exit 0
