@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Clash Verge dev (tauri + vite HMR)
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" (
    echo [FATAL] package.json not found - put this BAT in the source folder.
    pause
    exit /b 1
)

echo ==================================================
echo   pnpm dev  (vite http://localhost:3000 + Tauri window)
echo   repo: %REPO%
echo ==================================================
echo.

REM Rust needs the MSVC linker on PATH; a normal CMD/PowerShell does not have it.
set "VCVARS=E:\VS2022BT\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
    echo [INFO] importing MSVC environment: %VCVARS%
    call "%VCVARS%" >nul
) else (
    echo [WARN] %VCVARS% not found - assuming a Developer shell
)

where link.exe >nul 2>&1
if errorlevel 1 (
    echo [FATAL] link.exe unavailable. Install "Visual Studio Build Tools" with the C++ workload,
    echo         or edit VCVARS in this BAT to point at your vcvars64.bat.
    pause
    exit /b 1
)
echo [OK]   MSVC linker ready

if not exist "%REPO%\src-tauri\sidecar\verge-throne-core-x86_64-pc-windows-msvc.exe" (
    echo [WARN] speed test sidecar missing - run build-speedtest.bat first
)

set "RUST_BACKTRACE=full"
set "HUSKY=0"

echo [INFO] first Rust dev build takes several minutes; frontend edits hot-reload.
echo.
call pnpm dev
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   DEV EXIT OK
) else (
    echo   DEV EXIT  rc=%RC%
)
echo.
pause
exit /b %RC%
