@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Build speed test sidecar only
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

echo ==================================================
echo   Build sing-box speed test sidecar only
echo   (no installer, no tauri build)
echo ==================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\build-speedtest-sidecar.ps1" -Repo "%REPO%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   SPEED TEST SIDECAR OK
) else (
    echo   SPEED TEST SIDECAR FAILED  rc=%RC%
)
echo.
pause
exit /b %RC%
