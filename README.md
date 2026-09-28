# dsh-desktop-updater

> ## ⚠️ 项目状态：方式一已退役（2026-09-28）
>
> **官方已有生产桌面端安装包，方式一（自建 feed 分发）不再需要。**
>
> 官方产物已上生产 CDN（`https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`）：
>
> | 项 | 实测值 |
> |---|---|
> | 版本 | `0.1.7-rc.2`（npm 上同样是 `latest`） |
> | 签名 | **EV 代码签名**（Hangzhou DeepSeek）→ 安装不弹 SmartScreen |
> | 速度 | CDN 直连 **17.7 MB/s** |
> | 更新能力 | **安装包自带 `app-update.yml`**，指向官方 feed —— 装完即有自动更新 |
>
> 而且官方包的 `app-update.yml` 带 `publisherName`（签名校验），
> **会拒绝我们的 unsigned 自建包** —— 自建分发这条路技术上已走不通。
>
> **本仓库现在的定位：本地构建工具。** 用途变为「想改代码 / 内网部署 / 固定版本 /
> 构建可审计的版本」。真正有价值的部分是**环境预检**、**构建补丁的幂等托管**、
> **兼容性校验**——而不是分发。
>
> 详见 [docs/research/评估-官方安装包实测.md](docs/research/评估-官方安装包实测.md)。

给 **DeepSeek Harness 桌面端**（`deepseek-ai/deepseek-harness`）做**双模式更新**的工具集，
同时作为更新包的分发点（feed 托管在本仓库的 Release）。

> ⚠️ 上游处于 developer preview，官方 README 原文写着 *THERE WILL BE COMPATIBILITY-BREAKING CHANGES.*
> 本工具用「接触面分层」把跟随上游的成本压到最小，详见 [设计文档](docs/design/总方案.md)。

---

## 两个更新方式（⚠️ 方式一已退役，见上方项目状态）

用户自己选，界面显式分流：

| | 方式一 · 从我发布的构建更新 | 方式二 · 本地构建更新 |
|---|---|---|
| 谁构建 | 本仓库的维护者 | 用户自己的机器 |
| 需要什么 | 只要网络 | 完整工具链（VS / SDK / pnpm / 20 GB 空间） |
| 拿到哪个版本 | 维护者最近发布的构建 | 官方最新源码构建出来的 |
| 内核改动 | **零** | 需 3 处追加改动 |

两种方式**共用同一条安装链路**（官方 `electron-updater` 的 check → download → `quitAndInstall`）。

---

## 快速开始

### 只是要用更新（普通用户）

1. 打开本仓库的 [Releases](../../releases) 页面
2. 下载最新的 `.exe` 安装包，直接运行覆盖安装
3. 或者：在应用「设置 → 软件更新」里选择「从我发布的构建更新」

### 本地构建（需要完整工具链）

```
双击 build.bat
```

脚本会依次做：环境预检 → 构建前准备 → 安装依赖 → 打包 → 投放产物到本地 feed。

**首次构建约 40~70 分钟**（依赖安装 10~30 分钟 + 打包 20~40 分钟）。

指定源码仓库位置（三选一）：

```bat
build.bat D:\codes\deepseek-harness           :: 命令行参数
set DSH_SOURCE_REPO=D:\codes\deepseek-harness :: 环境变量
:: 或在 config.json 里写 { "sourceRepo": "..." }
```

**配置自托管更新源**（决定 unsigned 包是否带更新能力）：

```json
{
  "sourceRepo": "D:\\codes\\deepseek-harness",
  "selfUpdateUrl": "https://github.com/<你>/dsh-desktop-updater/releases/latest/download/"
}
```

未配置 `selfUpdateUrl` 时**不会生成 `app-update.yml`**，「检查更新」保持不可用（与现状一致）——
这是安全的默认值。

---

## 目录结构

```
dsh-desktop-updater/
├── build.bat                     一键本地构建（预检 → 构建 → 投放）
├── close-dsh.bat                 关闭所有 DSH 实例（安装前用）
├── config.json.example           本地配置样例
├── scripts/
│   ├── paths.cjs                 共用路径解析（源码仓库 / feed 目录 / DSH home）
│   ├── check-official.cjs        查官方最新版本（npm dist-tags + semver 判定）
│   ├── preflight-env.cjs         构建环境预检（13 项）
│   ├── hold-blocked-ports.cjs    占住 Node fetch 封禁端口（规避冒烟验证 bad port）
│   ├── prepare-build.cjs         构建前准备（幂等，5 步修补 + 1 步校验）
│   ├── verify-compat.cjs         兼容性校验 + 诊断包（待实现）
│   └── serve-feed.cjs            本地 feed 服务（待实现）
├── patches/                      内核补丁说明与锚点
└── docs/
    ├── 安装与排障说明.md          完整安装文档与排障锚点
    ├── 发布Release.md             产物如何发到 GitHub Release（方式一）
    ├── design/总方案.md           架构、界面信息结构、实施计划
    ├── design/内核改动清单.md      方式二的精确 diff 与校验锚点
    ├── design/更新面板-demo.html   界面 demo（浏览器直接打开可交互）
    └── research/                 前期可行性调研（含源码级证据）
```

**本地 feed 目录**：`~/.dsh/desktop-updates/`（跟随 `$DSH_HOME`）。
构建产物会投放至此，供应用内「本地构建更新」读取。

---

## 官方版本怎么判定

界面里那个常驻的「官方版本」区块，数据来自 **npm registry 的 dist-tags**。
实现在 `scripts/check-official.cjs`：

```bat
node scripts\check-official.cjs                          :: 当前版本自动取自源码仓库
node scripts\check-official.cjs --json                   :: 机器可读
node scripts\check-official.cjs --current 0.1.7-alpha.2
node scripts\check-official.cjs --registry https://registry.npmmirror.com
```

**判定规则：不绑定任何渠道，取官方所有已发布版本里 semver 最高的那个。**

```
0.1.7-rc.1   >   0.1.7-alpha.2   >   0.1.5-rc.3
   ↑ next           ↑ alpha           ↑ latest
```

⚠️ **不要"跟随当前构建线"。** 早先按"我构建的是 alpha，就只比 alpha 线"实现过一版，
结果官方推进到 `0.1.7-rc.1`（渠道 `next`）后**完全漏报** —— `alpha` 这条线的最新
还停在 `0.1.7-alpha.2`，界面会一直显示"已是最新"。

**渠道是官方的发布策略，会新增、会变**（`next` 这个标签就是 2026-09-23 发 `0.1.7-rc.1`
时才出现的），**semver 才是客观顺序**。所以也不要把渠道列表写死。

判定结果是**四态**，不是布尔：

| relation | 含义 |
|---|---|
| `outdated` | 官方有更新（当前落后） |
| `current` | 与官方 semver 最高相同 |
| `ahead` | 当前比官方还新（本地改过版本号，或官方回退了渠道指向） |
| `unknown` | 当前版本不是合法 semver，无法比较 |

> 「已是最新」和「比官方还新」必须分开 —— 用一个布尔表达会把两者混同。
> 这个坑是实测 `--current 0.1.7-rc.2` 时发现的。

---

## 前置要求（方式二）

| 项 | 要求 | 缺失时 |
|---|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` | 预检阻断 |
| pnpm | `11.7.0`（与源码仓库声明一致） | 预检阻断 |
| Visual Studio | 含 `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` | 预检阻断 |
| Windows SDK | ≥ `10.0.19041`（< 20348 需兼容补丁，工具会自动打） | 预检阻断 |
| 磁盘空间 | 建议 ≥ 15 GB 可用 | 预检阻断 + 询问是否继续 |
| 源码工作区 | 完整源码树 + 可安装依赖 | 预检阻断 |

预检项分三类处置：

- **可自动修复** —— 工具直接处理（如生成 `.env.windows`）
- **需要你处理** —— 仅告警并给出清理目标（如磁盘空间）
- **仅供指引** —— 检测 + 版本要求 + 官方下载地址（如 VS / SDK）

**Visual Studio 与 Windows SDK 不做自动安装** —— 需要管理员权限、数十 GB 下载、可能重启，
属于不可逆重操作，交给用户确认。

**可调项**：

```bat
set DSH_PREFLIGHT_MIN_FREE_GB=10    :: 磁盘空间的阻断阈值（默认 15 GB）
set DSH_SOURCE_REPO=D:\codes\...    :: 源码仓库位置
set DSH_NPM_REGISTRY=https://registry.npmjs.org  :: npm 源（默认 npmmirror，见「已知限制」）
```

**退出码**：

| 码 | 含义 | `build.bat` 的行为 |
|---|---|---|
| 0 | 全部通过 | 直接继续 |
| 1 | 存在阻断项 | 询问「仍要继续吗？(Y/N)」 |
| 2 | 探测能力不可用（当前会话无法派生子进程，与构建环境无关） | 提示后继续构建 |

> 退出码 2 的设计意图：**不能因为"测不了"就报成"没装"**。早先版本会在无法派生子进程时
> 误报「你没装 Node」，把人引向重装环境——那是假警报。现在会明确说明是执行环境受限，
> 并建议改到普通命令行窗口运行。

---

## 文档

| 文档 | 内容 |
|---|---|
| [总方案](docs/design/总方案.md) | 架构、三层界面信息结构、P0~P8 实施计划、风险清单 |
| [内核改动清单](docs/design/内核改动清单.md) | 方式二 3 处改动的完整 diff、校验锚点、安全设计、已知限制 |
| [安装与排障说明](docs/安装与排障说明.md) | 完整安装流程与全部排障锚点 |
| [发布 Release](docs/发布Release.md) | 产物如何发到 GitHub Release；三个前置条件与常见失败 |
| [研究报告](docs/research/) | 插件兼容性根因、可行性评估（含源码级证据与行号） |

---

## 为什么会有这个工具

上游 DSH 处于 developer preview，官方明示会有破坏性变更；而其桌面端在**未签名本地构建**下的
「检查更新」是死的——`electron-builder-config.mjs:92` 在 unsigned 时不生成 `app-update.yml`，
运行时 `update-coordinator.ts:53` 因此判定「没有更新源」。

本工具的第一件事就是补上这一环，让官方整套更新链路（check → download → 停任务 → 退出 → 装 → 重启）
真正跑起来；方式二则在此之上加了「本机从源码构建」这条路。

---

## 已知限制

### 冒烟验证会随机撞上 Node fetch 的「封禁端口」（已内置规避）

打包末尾的冒烟验证（`smoke-runtime.ts`）会起一个本地 web 服务
（`host: 127.0.0.1, port: 0` —— 让系统随机分配端口），再用 **Node 内置 fetch** 请求它。
但 undici（Node 的 fetch 实现）有一份**封禁端口黑名单**（PPTP / H323 / NFS 等协议端口），
对名单里的端口直接抛：

```
TypeError: fetch failed
  cause: bad port
```

请求**根本发不出去**，冒烟失败、整个产物作废。

**本机尤其容易撞上**：动态端口范围被某个"优化"工具改成了 **1024~15000**
（Windows 默认是 `49152~65535`），与黑名单的重叠面大了许多。

实测（本机 Node v22.22.2）：

| 端口 | fetch 的结果 |
|---|---|
| 1719 / 1720 / **1723** / 6666 / 10080 | `fetch failed` + **`bad port`** ← 封禁 |
| 17321 / 49153 | `ECONNREFUSED`（合法端口，只是没服务） |

2026-09-27 就撞上 **1723** 白失败了一次 —— 而且那次其它环节**全部通过**，
包括此前一直失败的 Office→PDF。

**已内置规避**：`build.bat` 在打包前用 `scripts/hold-blocked-ports.cjs`
把这些端口先 `listen` 起来 —— 系统的 `listen(0)` 选端口时会跳过已占用的，
自然分不到黑名单里的端口。**不修改官方任何代码**；占端口进程 120 分钟后自动退出
（`DSH_HOLD_PORTS_MINUTES` 可调）。

实测：占住 19 个端口后，`listen(0)` 连续分配 60 次，**0 次**落入封禁区间。

> 想从根上解决，可以把动态端口范围改回默认（**需要管理员**）：
> `netsh int ipv4 set dynamicport tcp start=49152 num=16384`

### npm 源太慢会让 LibreOffice 引擎"下载失败"（已内置规避）

构建时若碰到这个错，**根因几乎一定是 npm 源太慢，而不是源码或工具链有问题**：

```
Error: desktop runtime: missing required LibreOffice engine win32-x64
```

链路已经在源码里逐行核实过：

1. `@deepseek-ai/dsh-office-to-pdf` 声明 `"@deepseek-ai/libreoffice-kit": "^0.1.0"`
2. 打包时的临时运行时 install 会**重新解析**这个 range（`pnpm install --lockfile-only`），
   拿到当时最新的 `0.1.2` —— 而**不是**工作区 lockfile 里钉住的 `0.1.0`
3. 这个包 tarball 有 **68 MB**，且装在一个**全新的空 store**（`mkdtemp` 出来的临时目录，
   用不上你已经攒下的 pnpm 缓存），必须现下
4. 官方 registry 在本机实测只有 **0.07~0.22 MB/s** → 68 MB 要下 5~15 分钟
5. pnpm 中途超时，报 `error (23)`
6. **而它是 optionalDependency** —— pnpm 静默跳过，install 照样显示 `Done`
7. 直到后面检查引擎时才报错，**错误信息完全不提「下载慢」**

实测对照：

| 源 | 实测速度 | 下完 68 MB |
|---|---|---|
| `registry.npmjs.org`（含走代理） | 0.07~0.22 MB/s | 5~15 分钟 → pnpm 中途超时 |
| **`registry.npmmirror.com`** | **1.6~4.6 MB/s** | **15 秒** |

**已内置规避**：`build.bat` 默认把两个 npm 源变量都指向 npmmirror
（`npm_config_registry` 给根 install，`DSH_DESKTOP_NPM_REGISTRY` 给打包内部的临时 install），
且已校验两边的包 **integrity 与官方逐字一致**。

预检里也加了「**npm 源速度**」一项：实下 2 MB 测吞吐，低于 0.3 MB/s 直接判为阻断。
（这次就是靠它提前发现，而不是白跑 40 分钟才看到「缺引擎」。）

要换回官方源：`set DSH_NPM_REGISTRY=https://registry.npmjs.org` 再跑。

### 打包末尾的 Office→PDF 冒烟项，在本构建机上必然失败

官方打包流程末尾有一步「打包后冒烟验证」：启动打包产物、建一个临时 profile、
装一个测试插件，然后真实地把 docx / xlsx / pptx 转成 PDF。**在本机上这一步必然失败**：

```
{"ok":false,"code":"failed","error":"loadComponentFromURL returned an empty reference"}
```

为定位它做过的对照实验：

| 检查项 | 结果 |
|---|---|
| 打包产物里的 LibreOffice | ✗ 同样失败 |
| 源码仓库 `node_modules` 里的 LibreOffice | ✗ 同样失败（排除路径长度因素） |
| **已安装版的 DSH**（日常在用那份） | **✗ 同样失败** ← 关键 |
| VC++ 运行时 / 217 个 DLL / `swlo`·`sclo`·`sdlo` | ✓ 齐全 |
| `share/registry` 配置（含 1.98 MB `main.xcd`） | ✓ 完整 |
| Windows 错误报告（WER） | 无崩溃记录 |

→ 结论：**这是机器的环境问题，不是构建问题**。本机装有安全软件（火绒 HIPS 常驻），
最可能是它拦截了 LibreOffice 的初始化。**打包产物本身完整可用** ——
其余冒烟项（Host 启动、打包后的前端加载、外部插件 HTTP 路由）全部通过。

因此 `build.bat` 对这一项做了容错：打包返回失败时，**先检查产物是否已生成**——
有产物就问你要不要继续投放，没有才中止。这不会掩盖真正的失败，
因为"真的失败"时连 exe 都不会有。

其他机器上如果冒烟项能过，这条限制自然不适用。

---

## 开发状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | UI 确认 | ✅ |
| P1 | 仓库搭建 + 旧代码整理 | ✅ |
| P2 | unsigned 构建产出 feed | ✅ 已实测（产物含 `app-update.yml` + `nightly.yml`） |
| P3 | 方式一端到端打通 | ✅ 产物已发布 Release 且匿名可下载（待装包点一次「检查更新」） |
| P4 | 环境预检接入 | ✅ `preflight-env.cjs` 已可用（接入 UI 待 P7） |
| P4.5 | 官方版本判定 | ✅ `check-official.cjs`（semver 四态判定，已测） |
| P5 | 兼容性校验 + 诊断包 | ⏳ |
| P6 | 方式二本地 feed 打通 | ⏳ |
| P7 | 更新面板 UI | ⏳ |
| P8 | 引导式修复闭环 | ⏳ |

详见 [总方案 §5](docs/design/总方案.md)。
