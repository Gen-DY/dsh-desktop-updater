# 发布 Release（方式一的产物托管）

方式一（应用内「检查更新」**从我发布的构建更新**）依赖本仓库的 GitHub Release。
应用 side 写死了一个固定地址，由打包时的 `app-update.yml` 提供：

```
https://github.com/Gen-DY/dsh-desktop-updater/releases/latest/download/
```

`latest` 是 GitHub 的固定重定向 —— 它指向**最新一个正式 Release**。所以这个地址
**永远不用改**，每次发新版本只要新建 Release，应用自动就指向新的了。

---

## 一、Release 必须满足的三个条件

漏掉任何一个，应用内「检查更新」都会失败，而且**报错信息不一定会指出原因**。

| # | 条件 | 为什么 |
|---|---|---|
| 1 | **不是 prerelease** | `releases/latest` 只解析正式 Release。勾了 "pre-release" 就解析不到，返回 404 |
| 2 | **资产名与 `nightly.yml` 里的 `path` 逐字一致** | electron-updater 把 `feedUrl` + `path` 拼成下载地址。差一个字符就是 404 |
| 3 | **三个文件齐全** | `nightly.yml`（清单）/ `.exe`（安装包）/ `.exe.blockmap`（差分索引）。缺 blockmap 时 electron-updater 会退回全新下载，可以接受；缺前两个直接失败 |

> 另外：**不要**把 `builder-debug.yml` 传上来 —— 那是 electron-builder 的调试输出，与应用无关。

### `nightly.yml` 长什么样

```yaml
version: 0.1.7-alpha.2
files:
  - url: deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe
    sha512: r5OTrq+awQ/phTuxgJ0MN7mOmEkOfzIa2gi19MvvqEoGd+oZK04Leh9SVuPEWqqogf8Txyfidv0mF557Ymn1OA==
    size: 312850520
path: deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe
sha512: r5OTrq+awQ/phTuxgJ0MN7mOmEkOfzIa2gi19MvvqEoGd+oZK04Leh9SVuPEWqqogf8Txyfidv0mF557Ymn1OA==
releaseDate: '2026-09-24T03:03:35.839Z'
```

`path` 就是资产名，`sha512` 是校验值 —— 下载后 electron-updater 会比对，
不匹配会拒绝安装。所以**不能手工改 exe**（改了就得同步改 yml）。

---

## 二、发布流程

### 前置：产物已经生成

跑完 `build.bat` 后，产物在：

```
<源码仓库>\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\
    nightly.yml
    deepseek-harness-<版本>-win-x64-unsigned.exe
    deepseek-harness-<版本>-win-x64-unsigned.exe.blockmap
```

同时 `build.bat` 会把这三个文件投放到
`%USERPROFILE%\.dsh\desktop-updates\`（本地 feed，供方式二使用）。

**下面两种方式任选一种，用同一批文件。**

### 方式 A：用 gh CLI（推荐）

`gh` 是 GitHub 官方命令行工具。本机在 `D:\code-tool\GitHubCLI\gh`。

```bat
set GH_TOKEN=<你的令牌>
cd /d %USERPROFILE%\.dsh\desktop-updates

rem 首次：新建 Release（tag 用 v<版本号>）
gh release create v0.1.7-alpha.2 ^
  --repo Gen-DY/dsh-desktop-updater ^
  --title "DSH 桌面端 0.1.7-alpha.2（本地构建 / 未签名）" ^
  --notes "本地构建产物，供应用内更新使用。" ^
  nightly.yml ^
  deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe ^
  deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe.blockmap
```

```bat
rem 已有 Release 想替换资产（比如同版本重出包）
gh release upload v0.1.7-alpha.2 ^
  --repo Gen-DY/dsh-desktop-updater --clobber ^
  nightly.yml ^
  deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe ^
  deepseek-harness-0.1.7-alpha.2-win-x64-unsigned.exe.blockmap
```

> ⚠️ `--clobber` 会覆盖同名资产。**只在确认要替换时用**。

### 方式 B：网页上传

1. 打开 https://github.com/Gen-DY/dsh-desktop-updater/releases/new
2. **Choose a tag** 填 `v0.1.7-alpha.2`（新版本号就换），点 "Create new tag"
3. Title 随便写，Notes 可选
4. **不要勾** "Set as a pre-release"
5. 把下面三个文件拖进 "Attach binaries" 区域
6. Publish release

> 298 MB 的文件网页上传可能较慢，也可能中途失败。失败就重试，或换方式 A。

---

## 三、发完之后怎么验证

### 验证 1：`latest` 是否指对了

```bat
curl -sI https://github.com/Gen-DY/dsh-desktop-updater/releases/latest/download/nightly.yml
```

预期看到 `HTTP/1.1 302 Found`，且 `Location` 里的 tag 是你刚发的那个：

```
Location: https://github.com/Gen-DY/dsh-desktop-updater/releases/download/v0.1.7-alpha.2/nightly.yml
```

如果 tag 不是刚发的那个 → 说明有更新的正式 Release，或者这个被标成了 pre-release。

### 验证 2：资产名逐字对得上

把 Release 页面的资产名，与 `nightly.yml` 里的 `path` 逐字比对一次。
**这一步别省** —— 不一致时应用只会报「下载失败」，不会告诉你名字错了。

### 验证 3：应用内实测

装好应用 → 打开更新面板 → 走「方式一」→ 点「检查更新」。

预期：

```
检查更新 → 发现新版本 → 「下载并安装」→ 进度 → 停任务 → 退出 → 安装 → 重启
```

---

## 四、常见失败

| 现象 | 多半是 |
|---|---|
| 「检查更新」报 404 / 无法获取更新源 | Release 被标成了 pre-release，或者压根没发 |
| 能查到新版本，下载开始后立刻失败 | 资产名与 `nightly.yml` 的 `path` 不一致 |
| 下载完成但拒绝安装 / 校验失败 | exe 被改过，与 `nightly.yml` 的 `sha512` 不匹配 |
| 「已是最新」（但你明明发了新版） | 版本号没变。electron-updater 按 semver 比较，**同版本永远判定为「已是最新」** |
| 一直提示「暂无可用构建」 | 应用读的是 `nightly.yml`，但 channel 对不上（`app-update.yml` 里是 `channel: nightly`） |

> **同版本无法重装**是 electron-updater 的固有行为，不是 bug。要靠它更新，
> 就必须让版本号真的变大。如果只是自己反复测试同一版本，直接用
> `%USERPROFILE%\.dsh\desktop-updates\` 里的安装包手工装。

---

## 五、为什么要独立一个公开仓库

因为**私有仓库的 Release 资产下载需要凭据**。

如果产物发在私有仓库，同事机器上没有 token 就下不到包 —— 而 token 打进安装包
等于公开。所以产物托管必须在**公开**仓库。

本仓库的定位就是"公开的产物 + 工具脚本"，构建用的源码仓库保持私有。
