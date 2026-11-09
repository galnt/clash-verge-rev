@echo off
setlocal EnableExtensions
chcp 936 >nul
title 增量快速出包
cd /d "%~dp0"

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
if not exist "%REPO%\package.json" set "REPO=E:\clash-verge"

echo ==================================================
echo   增量快速出包（跳过依赖、资源、测速组件重建）
echo   仓库: %REPO%
echo ==================================================
echo.

set "VCVARS=E:\VS2022BT\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
    echo [信息] 正在导入 MSVC 环境
    call "%VCVARS%" >nul
) else (
    echo [警告] 未找到 vcvars64.bat，假定当前已是开发者命令行
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\build-fast-installer.ps1" -Repo "%REPO%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   增量出包完成
) else (
    echo   增量出包失败  rc=%RC%
)
echo.
pause
exit /b %RC%
