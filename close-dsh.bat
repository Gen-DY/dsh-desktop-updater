@echo off
chcp 65001 >nul
setlocal
title 关闭所有 DSH 实例

echo ============================================================
echo  关闭所有 DeepSeek Harness / DSH 实例
echo ============================================================
echo.

echo [1/3] 当前占用端口 19387 的进程：
netstat -ano | findstr ":19387" | findstr LISTENING
echo.

echo [2/3] 正在关闭...
rem 先按端口精准结束占用者（dev 模式的宿主也叫 electron.exe，按端口杀最准）
set "OWNER="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":19387" ^| findstr LISTENING') do set "OWNER=%%p"
if defined OWNER (
  echo   结束占用 19387 的进程 PID=%OWNER%
  taskkill /PID %OWNER% /T /F >nul 2>nul
)
rem 再关掉所有已安装桌面端实例
taskkill /IM "DeepSeek Harness.exe" /T >nul 2>nul
taskkill /IM "DeepSeek Harness.exe" /T /F >nul 2>nul
echo.

echo [3/3] 复查端口 19387：
netstat -ano | findstr ":19387" | findstr LISTENING
if errorlevel 1 echo   端口已释放，可以重新启动一个实例了
echo.
echo 提示：同一时间只能开一个 DSH（dev:desktop 和安装版都用 19387，会互相抢）。
echo.
pause
exit /b 0
