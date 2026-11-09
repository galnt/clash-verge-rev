@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Clash Verge full build (unattended)
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" set "REPO=E:\clash-verge"

echo ==================================================
echo   Full installer build - no UAC, no pause
echo   repo: %REPO%
echo ==================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\oneclick-build.ps1" -Repo "%REPO%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   BUILD OK
) else (
    echo   BUILD FAILED  rc=%RC%
)
exit /b %RC%
