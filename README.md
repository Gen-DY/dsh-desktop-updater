# dsh-desktop-updater

给 **DeepSeek Harness 桌面端**（`deepseek-ai/deepseek-harness`）做**双模式更新**的工具集，
同时作为更新包的分发点（feed 托管在本仓库的 Release）。

> ⚠️ 上游处于 developer preview，官方 README 原文写着 *THERE WILL BE COMPATIBILITY-BREAKING CHANGES.*
> 本工具用「接触面分层」把跟随上游的成本压到最小，详见 [设计文档](docs/design/总方案.md)。

---

## 两个更新方式

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
│   ├── preflight-env.cjs         构建环境预检（12 项）
│   ├── prepare-build.cjs         构建前准备（幂等，5 步修补 + 1 步校验）
│   ├── verify-compat.cjs         兼容性校验 + 诊断包（待实现）
│   └── serve-feed.cjs            本地 feed 服务（待实现）
├── patches/                      内核补丁说明与锚点
└── docs/
    ├── 安装与排障说明.md          完整安装文档与排障锚点
    ├── design/总方案.md           架构、界面信息结构、实施计划
    ├── design/内核改动清单.md      方式二的精确 diff 与校验锚点
    └── research/                 前期可行性调研（含源码级证据）
```

**本地 feed 目录**：`~/.dsh/desktop-updates/`（跟随 `$DSH_HOME`）。
构建产物会投放至此，供应用内「本地构建更新」读取。

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
| [研究报告](docs/research/) | 插件兼容性根因、可行性评估（含源码级证据与行号） |

---

## 为什么会有这个工具

上游 DSH 处于 developer preview，官方明示会有破坏性变更；而其桌面端在**未签名本地构建**下的
「检查更新」是死的——`electron-builder-config.mjs:92` 在 unsigned 时不生成 `app-update.yml`，
运行时 `update-coordinator.ts:53` 因此判定「没有更新源」。

本工具的第一件事就是补上这一环，让官方整套更新链路（check → download → 停任务 → 退出 → 装 → 重启）
真正跑起来；方式二则在此之上加了「本机从源码构建」这条路。

---

## 开发状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | UI 确认 | ✅ |
| P1 | 仓库搭建 + 旧代码整理 | ✅ |
| P2 | unsigned 构建产出 feed | ✅ 机制完成（待一次完整构建实测） |
| P3 | 方式一端到端打通 | ⏳ |
| P4 | 环境预检接入 | ⏳ |
| P5 | 兼容性校验 + 诊断包 | ⏳ |
| P6 | 方式二本地 feed 打通 | ⏳ |
| P7 | 更新面板 UI | ⏳ |
| P8 | 引导式修复闭环 | ⏳ |

详见 [总方案 §5](docs/design/总方案.md)。
