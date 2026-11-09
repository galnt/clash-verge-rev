@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Clash Verge quick compile check
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" set "REPO=E:\clash-verge"

echo ==================================================
echo   Quick compile check (no installer, no window)
echo   1/3 Go sidecar  2/3 TypeScript  3/3 Rust
echo ==================================================
echo.

set "VCVARS=E:\VS2022BT\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
    echo [INFO] importing MSVC environment
    call "%VCVARS%" >nul
)

echo [1/3] Go speed test sidecar
call node "%REPO%\scripts\build-speedtest.mjs"
if errorlevel 1 goto FAIL

echo [2/3] TypeScript tsc --noEmit
call node "%REPO%\node_modules\typescript\bin\tsc" --noEmit
if errorlevel 1 goto FAIL

echo [3/3] Rust cargo check
cargo check --manifest-path "%REPO%\src-tauri\Cargo.toml" --quiet
if errorlevel 1 goto FAIL

echo.
echo   COMPILE CHECK OK
echo   To see the UI: dev.bat / pnpm dev
echo   To build an installer: build-menu.bat -^> 3
echo.
pause
exit /b 0

:FAIL
echo.
echo   COMPILE CHECK FAILED
echo.
pause
exit /b 1
