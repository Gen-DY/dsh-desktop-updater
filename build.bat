@echo off
chcp 65001 >nul
setlocal
title DeepSeek Harness 桌面端 - 本地构建

set "TOOL=%~dp0"

rem ---- 源码仓库位置：命令行参数 > DSH_SOURCE_REPO > config.json > 内置默认 ----
if not "%~1"=="" set "DSH_SOURCE_REPO=%~1"

echo ============================================================
echo  DeepSeek Harness 桌面端 - 本地构建
echo  Windows x64 / 未签名
echo ============================================================
echo.

rem ================= [0/6] 解析路径 =================
echo [0/6] 解析路径
for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" repo`) do set "REPO=%%p"
for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" feed`) do set "FEED=%%p"
if not exist "%REPO%\package.json" goto :norepo
if not exist "%FEED%" mkdir "%FEED%" >nul 2>nul
echo   源码仓库: %REPO%
echo    feed 目录: %FEED%

rem ---- 自托管更新源（unsigned 构建的 feed 地址）；留空则不生成 app-update.yml ----
if not defined DSH_DESKTOP_SELF_UPDATE_URL (
  for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" feedurl`) do set "DSH_DESKTOP_SELF_UPDATE_URL=%%p"
)
if defined DSH_DESKTOP_SELF_UPDATE_URL (
  echo    更新源: %DSH_DESKTOP_SELF_UPDATE_URL%
) else (
  echo    更新源: （未配置 - 本次构建不会生成 app-update.yml，「检查更新」不可用）
)
echo.

cd /d "%REPO%"

rem ================= [1/6] 环境预检 =================
echo [1/6] 环境预检   校验工具链 / 磁盘 / 源码工作区
echo.
node "%TOOL%scripts\preflight-env.cjs" "%REPO%"
set "PRC=%errorlevel%"
if "%PRC%"=="1" (
  echo.
  echo   ^>^> 预检存在【阻断项】。现在构建很可能白跑 30-60 分钟。
  echo.
  set /p GO="仍要继续吗？(Y/N) "
  if /i not "%GO%"=="Y" goto :fail
)
if "%PRC%"=="2" (
  echo   ^>^> 预检未能完成（当前会话无法派生子进程，通常是杀软拦截或受限会话）。
  echo      这不代表构建环境有问题 —— 继续构建。
  echo      若构建失败，请改用普通命令行窗口重跑本脚本。
  echo.
)
echo.

rem ================= [2/6] 构建前准备 =================
echo [2/6] 构建前准备   SDK补丁 / 清残留 / 清坏链接 / 更新通道 / 校验壳页面协议
echo.
node "%TOOL%scripts\prepare-build.cjs" "%REPO%"
if errorlevel 1 goto :fail
echo.

rem ---- git 兜底：构建里的 repositoryCommitHash 会执行 git rev-parse HEAD ----
rem ---- 若 PATH 无 git 或仓库根无 .git，会直接抛错，这里用占位 hash 保证可继续 ----
where git >nul 2>nul
if errorlevel 1 goto :nofallback
if not exist ".git" goto :nofallback
echo git 可用，仓库带 .git，将写入真实 commit hash
goto :gitok
:nofallback
if defined DSH_CLIENT_COMMIT_HASH goto :gitok
set "DSH_CLIENT_COMMIT_HASH=0000000000000000000000000000000000000000"
echo [提示] 未检测到可用 git 或仓库根缺少 .git
echo         已设置占位 commit hash，构建照常进行（仅构建信息里的版本号会显示为占位）
:gitok
echo.

rem ================= [3/6] 安装依赖 =================
if not exist "apps\desktop\.env.windows" copy /y "apps\desktop\.env.windows.example" "apps\desktop\.env.windows" >nul

set "npm_config_registry=https://registry.npmjs.org"
set "npm_config_trust_lockfile=true"
set "npm_config_confirm_modules_purge=false"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if exist "D:\Program Files\Python313\python.exe" set "PYTHON=D:\Program Files\Python313\python.exe"

echo [3/6] pnpm install --force   重建 node_modules，首次约 10-30 分钟
echo.
call pnpm install --force
if errorlevel 1 goto :fail
echo.

rem ================= [4/6] 打包 =================
echo [4/6] 打包未签名安装包   约 20-40 分钟
echo.
call pnpm run package:desktop:win:x64:unsigned
if errorlevel 1 goto :fail
echo.

rem ================= [5/6] 投放到本地 feed =================
echo [5/6] 投放产物到本地 feed 目录（供应用内「本地构建更新」使用）
set "ART=%REPO%\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts"
if not exist "%ART%\*.exe" goto :noartifact
copy /y "%ART%\*.exe" "%FEED%\" >nul
if exist "%ART%\*.yml" copy /y "%ART%\*.yml" "%FEED%\" >nul
echo   已投放: %FEED%
dir /b "%FEED%"
echo.
if not exist "%FEED%\nightly.yml" (
  echo   [提示] feed 里没有 nightly.yml —— 自动更新源尚未启用。
  echo          构建产物本身可用（下一步会启动安装程序），
  echo          但应用内「检查更新 / 本地构建更新」要等 P2 配置完成。
  echo.
)

rem ================= [6/6] 完成 =================
echo [6/6] 完成
echo.
echo 安装包目录:
echo   %ART%
echo.
echo 接下来二选一：
echo   1) 应用内点「本地构建更新」自动安装（需 P2 配置完成）
echo   2) 直接运行 %FEED% 目录里的安装程序
echo.
for %%F in ("%FEED%\*.exe") do start "" "%%~fF"
echo 已尝试启动安装程序；若没弹出，请手动打开上面的目录。
echo.
echo 装好后：桌面端使用 %USERPROFILE%\.dsh\profiles\desktop
echo 旧的 pnpm dsh web 用法不受影响，可随时回退。
echo.
pause
exit /b 0

:norepo
echo [错误] 源码仓库路径无效或缺少 package.json
echo        当前解析结果: %REPO%
echo        指定方式：build.bat ^<源码仓库路径^>
echo                 或设置环境变量 DSH_SOURCE_REPO
echo                 或在工具根目录 config.json 里写 "sourceRepo"
pause
exit /b 1

:noartifact
echo [错误] 未找到构建产物: %ART%\*.exe
pause
exit /b 1

:fail
echo.
echo [错误] 上一步失败，构建中止。
echo        请把本窗口的完整输出发出来；另外附上这个目录里最新那个文件夹的内容：
echo        apps\desktop\.desktop-build\packaging-runs\
echo        详细说明见 docs\安装与排障说明.md
pause
exit /b 1
