<#
  Single-purpose entry: build only the sing-box speed test sidecar.

  This is the shared implementation for:
    - build-speedtest.bat          (standalone speed test component build)
    - oneclick-build.ps1  [5.5]   (full installer build)
    - build-local.ps1     [2b]    (CI-style build)

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as
  ANSI, and non-ASCII comments can break parsing.
#>
param(
    [string]$Repo   = 'E:\clash-verge',
    [string]$Target = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path -LiteralPath $Repo).Path
Set-Location -LiteralPath $Repo

$buildScript = Join-Path $Repo 'scripts\build-speedtest.mjs'
$sidecarDir  = Join-Path $Repo 'src-tauri\sidecar'

$goCmd   = Get-Command 'go'   -ErrorAction SilentlyContinue
$nodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue

if (-not $buildScript -or -not (Test-Path -LiteralPath $buildScript)) {
    throw "missing build script: $buildScript"
}
if (-not $goCmd)   { throw 'go not found - needed to build the speed test sidecar' }
if (-not $nodeCmd) { throw 'node not found - needed to run build-speedtest.mjs' }

Write-Host ('[speedtest] go   : ' + $goCmd.Source)
Write-Host ('[speedtest] node : ' + $nodeCmd.Source)
Write-Host ('[speedtest] building target ' + $Target)

& $nodeCmd.Source $buildScript
if ($LASTEXITCODE -ne 0) {
    throw "build-speedtest.mjs failed with exit code $LASTEXITCODE"
}

$built = Get-ChildItem -LiteralPath $sidecarDir -File -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -like "verge-throne-core-$Target*" } |
         Select-Object -First 1
if (-not $built) {
    throw "speed test sidecar was not produced under $sidecarDir for $Target"
}

Write-Host ('[speedtest] OK  {0:N1} MB  {1}' -f ($built.Length / 1MB), $built.FullName)
exit 0
