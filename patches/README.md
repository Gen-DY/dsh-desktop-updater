# 内核补丁说明

本目录记录对上游 `deepseek-ai/deepseek-harness` 源码的补丁**内容、锚点与退役条件**。

> **补丁不存成 `.patch` 文件**，而是由 `scripts/prepare-build.cjs` 在每次构建前**幂等施加**。
> 这样做的好处：上游若自行修复，脚本能识别并跳过；上游若回退，脚本能自动补回。

---

## 补丁清单

### ① `apps/desktop/installer/window-frame.cpp` — Windows SDK 10.0.19041 兼容（**仍然需要**）

**问题**：SDK 10.0.19041.0 的 GDI+ 头文件里调用裸 `min`/`max`（已被 `NOMINMAX` 关掉），
且系统头文件内部有 `C4458`。仓库用 `/WX` 编译，全部升级为错误（C3861 × 16、C4458 × 7）。

**修法**：在 `#include <dwmapi.h>` 与 `#include <gdiplus.h>` 之间插入 `#include <algorithm>` +
`using std::min; using std::max;` + `#pragma warning(disable: 4458)` 包裹。

**上游状态**：0.1.7-alpha.2 把 `<algorithm>` 放在 `<gdiplus.h>` **之后**——此时头文件里的
非限定查找已经结束，对 C3861 无效。**所以补丁必须保留。**

**退役条件**：本机 SDK 升到 ≥ `10.0.20348.0`（微软在该版本修复）后，补丁可退役。

| 项 | 值 |
|---|---|
| 锚点 | `#include <dwmapi.h>` 换行后紧跟 `#include <gdiplus.h>` |
| 已判定的上游修复迹象 | 源码出现 `using std::min` / `using std::max` / `#undef NOMINMAX` |
| 失配处置 | 打警告，提示人工检查（**不阻断**——此补丁失配会引发编译错误，天然 loud） |

### ② `apps/desktop/src/main.ts` — `dsh-app://shell/*` 协议分支（**已退役**）

**问题**（2026-09 在 0.1.6-alpha.2 上定位）：`protocol.handle` 只认 `hostname === 'app'`，
而三种对话框都从 `dsh-app://shell/` 加载 → 返回 404 + 空 body → 弹出一个透明 modal 盖住父窗口
（并给父窗口注入 `filter: blur(2px)`）→ 界面发白、点不动、任务栏关不掉，只能杀进程。

**上游状态**：**0.1.7-alpha.2 已自行修复**，写法与本地补丁逐字一致（`main.ts:554`）。
`prepare-build.cjs` 第 6 步现在只做「校验 + 兜底」。

| 项 | 值 |
|---|---|
| 锚点 | `protocol.handle(SCHEME` 区域内存在 `url.hostname === 'shell'` |
| 上游已修判断 | 同区域内出现 `hostname === 'shell'` 或 `SHELL_HOST`/`shellHost` |
| 失配处置 | **`exit 1`** —— 这类补丁失效**不会引发编译错误**，静默跳过会产出坏包 |

### ③ `apps/desktop/scripts/electron-builder-config.mjs` — unsigned 构建的更新源（**P2 新增**）

**问题**：该文件里写死了

```js
const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
// ...
publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }],
```

于是 `DSH_DESKTOP_UNSIGNED=1` 时 `publish` 为 `null` —— **既不生成 `app-update.yml`，也不生成 `nightly.yml`**。
而运行时 `update-coordinator.ts:53` 的 `enabled()` 要求 `resources/app-update.yml` 存在，
所以本地未签名包的「检查更新」永远是死的（报 *this application has no packaged update source*）。

**修法**：给 unsigned 分支接上「自托管 feed」——注入 `resolveSelfHostedUpdate(env)`，
地址取自环境变量 `DSH_DESKTOP_SELF_UPDATE_URL`（由 `build.bat` 从 `config.json` 注入）。
**官方 test/production 通道语义完全不动。**

**注意 `publish` 那一行不需要改** —— 它本来就按 `update === undefined` 判断，
只要 unsigned 分支不再返回 `undefined`，feed 就自然产出。

| 项 | 值 |
|---|---|
| 锚点 A | `  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)` |
| 锚点 B | `export function createElectronBuilderConfig(` |
| 补丁标记 | `[LOCAL PATCH] self-hosted update for unsigned builds` |
| 失配处置 | **`exit 1`** —— 这行失配**不会引发编译错误**，静默跳过就会产出没有更新源的包 |
| 未配置 URL 时 | 退回原行为（不生成 feed）—— 安全的默认 |

---

## 校验锚点（供 `scripts/verify-compat.cjs`）

除上述两处，方式二的内核改动（见 [内核改动清单](../docs/design/内核改动清单.md)）还有 6 个锚点：

| # | 目标 | 锚点 |
|---|---|---|
| 3 | `apps/desktop/src/ipc.ts` | `updatesOpen: 'dsh-desktop:updates-open'` |
| 4 | `apps/desktop/src/ipc.ts` | `readonly updates: {` + `status(): Promise<DesktopUpdatePresentation>` |
| 5 | `apps/desktop/src/preload-app.ts` | `open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen)` |
| 6 | `apps/desktop/src/main.ts` | `ipcMain.handle(DESKTOP_IPC.updatesOpen` |
| 7 | `apps/desktop/src/main.ts` | `const openUpdatePrompt = (` |
| 8 | `apps/desktop/src/main.ts` | `new DesktopUpdateCoordinator(` |

**全部 fail loudly**：这些锚点失配时**不一定编译报错**（例如官方把 handler 注册挪进某个注册表，
代码仍编译通过但通道根本没生效），必须主动发现。

---

## 原则

> **失效后不报错的补丁，必须 fail loudly。**

上游重构导致锚点失配时，宁可停下不出包，也不要静默跳过产出坏包。
校验失败时 `verify-compat.cjs` 会输出**诊断包**（文件 / 期望锚点 / 实际 / 影响 / 上游 diff / 上下文 / 建议），
可直接交给 AI 处理。
