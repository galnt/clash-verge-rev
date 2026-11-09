@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Clash Verge environment check
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

echo ==================================================
echo   Environment check only (prebuild + speed test sidecar)
echo   No installer is produced.
echo ==================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\oneclick-build.ps1" -Repo "%REPO%" -SkipBuild
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   CHECK OK
) else (
    echo   CHECK FAILED  rc=%RC%
)
echo.
pause
exit /b %RC%
