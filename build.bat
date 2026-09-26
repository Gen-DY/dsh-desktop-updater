@echo off
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

rem ================= [0/7] 解析路径 =================
echo [0/7] 解析路径
for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" repo`) do set "REPO=%%p"
for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" feed`) do set "FEED=%%p"
if not exist "%REPO%\package.json" goto :norepo
if not exist "%FEED%" mkdir "%FEED%" >nul 2>nul
rem 本次要构建的版本号 —— 后面校验产物、投放产物都靠它精确匹配文件名
for /f "usebackq delims=" %%p in (`node "%TOOL%scripts\paths.cjs" version`) do set "VER=%%p"
if not defined VER goto :nover
echo   源码仓库: %REPO%
echo   本次版本: %VER%
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

rem ================= [1/7] 环境预检 =================
echo [1/7] 环境预检   校验工具链 / 磁盘 / 源码工作区
echo.
node "%TOOL%scripts\preflight-env.cjs" "%REPO%"
set "PRC=%errorlevel%"
rem 注意：这里刻意不用 if (... ) 括号块。括号块内的 %GO% 会在块开始解析时就展开，
rem 而 set /p 是在块执行时才赋值的 —— 那会让判断永远成立，直接跳去失败分支。
rem 用 goto 展开成线性结构，避开批处理的变量延迟展开陷阱。
if not "%PRC%"=="1" goto :pf_block2
echo.
echo   ^>^> 预检存在【阻断项】。现在构建很可能白跑 30-60 分钟。
echo.
set /p GO="仍要继续吗？(Y/N) "
if /i not "%GO%"=="Y" goto :fail
:pf_block2
if not "%PRC%"=="2" goto :pf_done
echo   ^>^> 预检未能完成（当前会话不能派生子进程，通常是杀软拦截或受限会话）。
echo      这不代表构建环境有问题 - 继续构建。
echo      若构建失败，请改用普通命令行窗口重跑本脚本。
echo.
:pf_done
echo.

rem ================= [2/7] 构建前准备 =================
echo [2/7] 构建前准备   SDK补丁 / 清残留 / 清坏链接 / 更新通道 / 校验壳页面协议
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

rem ================= [3/7] 安装依赖 =================
if not exist "apps\desktop\.env.windows" copy /y "apps\desktop\.env.windows.example" "apps\desktop\.env.windows" >nul

set "npm_config_registry=https://registry.npmjs.org"
set "npm_config_trust_lockfile=true"
set "npm_config_confirm_modules_purge=false"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if exist "D:\Program Files\Python313\python.exe" set "PYTHON=D:\Program Files\Python313\python.exe"

echo [3/7] pnpm install --force   重建 node_modules，首次约 10-30 分钟
echo.
call pnpm install --force
if errorlevel 1 goto :fail
echo.

rem ================= [4/7] 构建 =================
rem 这一步不能省。打包脚本(package-target.ts)在【模块加载阶段】就会 import
rem   @deepseek-ai/node-addon-system/lib/flock.js
rem 而那个 lib/ 是 tsc 的输出。源码升级时 lib/ 被清掉的话，打包会直接
rem ERR_MODULE_NOT_FOUND —— 典型的先有鸡还是先有蛋。
echo [4/7] 构建   全量编译（native-system + lib）  首次约 10-25 分钟
echo.
call pnpm run build
if errorlevel 1 goto :fail
echo.

rem ================= [5/7] 打包 =================
echo [5/7] 打包未签名安装包   约 20-40 分钟
echo.
set "ART=%REPO%\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts"
call pnpm run package:desktop:win:x64:unsigned
if not errorlevel 1 goto :pack_ok

rem 打包返回非 0，要区分两种情况：
rem   (a) 冒烟验证失败但产物已生成 -> 本机几乎必然发生，产物可用，问用户
rem   (b) 真的失败，没有 exe       -> 必须中止
rem 同样用 goto 展开成线性结构，避开括号块内的变量延迟展开陷阱。
rem 必须按【本次版本号】精确匹配。只看 *.exe 会把上次构建残留的旧版本
rem 误判成「本次产物已生成」—— 升级到 rc.1 那次真的踩到了（差点把 alpha.2 的包当成功）。
if not exist "%ART%\deepseek-harness-%VER%-win-x64-unsigned.exe" goto :fail
echo.
echo   ^>^> 打包流程返回失败，但【安装包已经生成】。
echo.
echo      产物目录: %ART%
echo.
echo      本机已知情况：打包末尾的「打包后冒烟验证」中，Office 文件转 PDF
echo      一项必然失败（LibreOffice 被本机安全软件拦截）。已实测核实：连
echo      已安装版的 DSH 在本机也完不成转 PDF，属环境问题，与本工具无关。
echo.
echo      请打开下面目录里【最新那个文件夹】的 stdout.log 确认失败项：
echo        apps\desktop\.desktop-build\packaging-runs\
echo      失败项若只是 Office 转 PDF，可以继续；否则请选 N 中止。
echo.
set /p GO2="仍要投放产物吗？(Y/N) "
if /i not "%GO2%"=="Y" goto :fail
echo.
:pack_ok
echo.

rem ================= [6/7] 投放到本地 feed =================
echo [6/7] 投放产物到本地 feed 目录（供应用内「本地构建更新」使用）
if not exist "%ART%\deepseek-harness-%VER%-win-x64-unsigned.exe" goto :noartifact
copy /y "%ART%\deepseek-harness-%VER%-win-x64-unsigned.exe" "%FEED%\" >nul
rem 只投 electron-updater 认的清单文件。不要用 *.yml 通配 ——
rem 那会把 electron-builder 的调试产物 builder-debug.yml 也拷进来。
if exist "%ART%\nightly.yml" copy /y "%ART%\nightly.yml" "%FEED%\" >nul
if exist "%ART%\latest.yml" copy /y "%ART%\latest.yml" "%FEED%\" >nul
echo   已投放: %FEED%
dir /b "%FEED%"
echo.
if not exist "%FEED%\nightly.yml" (
  echo   [提示] feed 里没有 nightly.yml —— 自动更新源尚未启用。
  echo          构建产物本身可用（下一步会启动安装程序），
  echo          但应用内「检查更新 / 本地构建更新」要等 P2 配置完成。
  echo.
)

rem ================= [7/7] 完成 =================
echo [7/7] 完成
echo.
echo 安装包目录:
echo   %ART%
echo.
echo 接下来三选一：
echo   1) 把 feed 里的产物发到 GitHub Release，再用应用内「检查更新」验证方式一
echo   2) 应用内点「本地构建更新」自动安装（方式二）
echo   3) 直接运行 %FEED% 目录里的安装程序
echo.
set /p GO3="现在就启动安装程序吗？(Y/N) "
if /i not "%GO3%"=="Y" goto :no_start
for %%F in ("%FEED%\*.exe") do start "" "%%~fF"
echo 已尝试启动安装程序；若没弹出，请手动打开上面的目录。
goto :start_done
:no_start
echo 已跳过启动安装程序。安装包在: %FEED%
:start_done
echo.
echo 装好后：桌面端使用 %USERPROFILE%\.dsh\profiles\desktop
echo 旧的 pnpm dsh web 用法不受影响，可随时回退。
echo.
pause
exit /b 0

:nover
echo [错误] 读不到源码仓库的版本号（package.json 的 version）
echo        当前解析结果: %REPO%
echo        请确认源码仓库完整，或用 build.bat ^<源码仓库路径^> 指定
pause
exit /b 1

:norepo
echo [错误] 源码仓库路径无效或缺少 package.json
echo        当前解析结果: %REPO%
echo        指定方式：build.bat ^<源码仓库路径^>
echo                 或设置环境变量 DSH_SOURCE_REPO
echo                 或在工具根目录 config.json 里写 "sourceRepo"
pause
exit /b 1

:noartifact
echo [错误] 未找到本次版本的构建产物: deepseek-harness-%VER%-win-x64-unsigned.exe
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
