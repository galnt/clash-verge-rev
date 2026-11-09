@echo off
setlocal EnableExtensions
chcp 936 >nul
title Clash Verge 构建菜单
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" set "REPO=E:\clash-verge"
if not exist "%REPO%\package.json" (
    echo [错误] 未找到 package.json，请把本文件放在源码目录。
    pause
    exit /b 1
)

powershell -NoProfile -Command "if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 1}else{exit 0}" >nul 2>&1
if errorlevel 1 (
    echo [信息] 正在申请管理员权限，请在 UAC 提示中点击"是"
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b 0
)

REM 上次打包被强行中断时，tauri.conf.json 可能停留在临时补丁状态。
for %%B in ("tauri.conf.json.oneclick.bak" "tauri.conf.json.localbuild.bak" "tauri.conf.json.fastbuild.bak") do (
    if exist "%REPO%\src-tauri\%%~B" (
        echo [提示] 检测到残留配置备份 %%~B，正在还原 tauri.conf.json
        copy /y "%REPO%\src-tauri\%%~B" "%REPO%\src-tauri\tauri.conf.json" >nul
        del "%REPO%\src-tauri\%%~B" >nul
    )
)

:MENU
echo.
echo ==================================================
echo   Clash Verge Rev 2.5.2 构建菜单
echo   仓库: %REPO%
echo ==================================================
echo   1  完整安装包（交互，保留 build.bat 行为）
echo   2  仅构建测速组件（不打包）
echo   3  完整安装包（无人值守，无 UAC / 无暂停）
echo   4  环境自检（prebuild + 测速组件，不打包）
echo   5  快速编译检查（Go + TS + Rust，不打包）
echo   6  代码改动后增量出包（最快出包）
echo   7  调试运行（pnpm dev，热更新 + 调试日志）
echo   0  退出
echo.
set "CHOICE="
set /p "CHOICE=请选择 [0-7]: "
if "%CHOICE%"=="1" goto M1
if "%CHOICE%"=="2" goto M2
if "%CHOICE%"=="3" goto M3
if "%CHOICE%"=="4" goto M4
if "%CHOICE%"=="5" goto M5
if "%CHOICE%"=="6" goto M6
if "%CHOICE%"=="7" goto M7
if "%CHOICE%"=="0" exit /b 0
echo [警告] 无效选择: %CHOICE%
goto MENU

:M1
call "%REPO%\build.bat"
goto MENU
:M2
call "%REPO%\build-speedtest.bat"
goto MENU
:M3
call "%REPO%\build-unattended.bat"
goto MENU
:M4
call "%REPO%\build-check.bat"
goto MENU
:M5
call "%REPO%\build-compile.bat"
goto MENU
:M6
call "%REPO%\build-fast.bat"
goto MENU
:M7
echo [提示] 调试窗口退出后会自动返回菜单。
call "%REPO%\dev.bat"
goto MENU
