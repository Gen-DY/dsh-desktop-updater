// 构建前的本地准备（幂等，可重复运行）。build.bat 第 3 步会调用它。
//
//  1) 给 apps/desktop/installer/window-frame.cpp 打 Windows SDK 10.0.19041.0 兼容补丁
//     —— 该 SDK 的 GDI+ 头文件用裸 min/max（被 NOMINMAX 关掉）→ error C3861（16 处），
//        且系统头文件里有 C4458，被 /WX 提升为错误（7 处）。VS2019 只配得到 19041，新版 SDK 已修。
//        ⚠️ 上游 0.1.7-alpha.2 仍未处理：它把 <algorithm> 放在 <gdiplus.h> 之后，
//           此时头文件里的非限定查找已经结束，对 C3861 无效。所以本补丁继续保留。
//  2) 删除根目录陈旧的 *.tsbuildinfo —— 否则 tsc -b 的增量状态会骗过重建，lib/ 不重新生成
//  3) 删除 packages/*/* 下没有 package.json 的“孤儿包目录”残留 ——
//     跨版本升级时旧包被删、但被 gitignore 的 lib/node_modules 还在，
//     里面过时的编译产物会让打包器报出误导性的 MISSING_EXPORT 错误。
//     判据：该位置没有 package.json 就一定是残留（上游已删该包），整体删除。
//  4) 清除 node_modules/.pnpm/node_modules 里的坏链接（空目录 / 死链 / 指向残留）
//     —— 否则 dev:desktop 会在 realpathSync 处 ENOENT，dsh web 会报 native binding 找不到
//  5) 把 apps/desktop/.env.windows 的更新通道从 test 纠正为 production
//     —— test 会强制飞书 SSO，本地未签名构建永远卡在登录遮罩上
//  6) 校验 dsh-app://shell/* 协议分支 —— 上游 0.1.7-alpha.2 起已自带（与本地旧补丁逐字一致）。
//     现在这里是「校验 + 兜底补丁」：上游若回退，自动补回；两边都不成立时 exit 1 让 .bat 停下。
//
// 用法：node prepare-build.cjs [源码仓库路径]
//       源码仓库也可用环境变量 DSH_SOURCE_REPO 或工具根目录的 config.json 指定。

const fs = require('node:fs')
const path = require('node:path')
const { resolveSourceRepo } = require('./paths.cjs')

// ⚠️ 旧版这里写的是 `const root = __dirname`，依赖「脚本躺在源码仓库根目录」这个前提。
//    搬迁到工具仓库后必须显式解析源码仓库位置，否则所有路径都会指错。
const { repo: root, source: repoSource } = resolveSourceRepo(process.argv[2])
if (!fs.existsSync(path.join(root, 'package.json'))) {
  console.error('[prep] ❌ 源码仓库路径无效：' + root)
  console.error('[prep]    来源：' + repoSource)
  console.error('[prep]    用法：node prepare-build.cjs [源码仓库路径]')
  process.exit(1)
}

// 版本信息，便于日志中确认当前构建的是哪个版本
function projectVersion () {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  } catch { return 'unknown' }
}
console.log('[prep] 源码仓库: ' + root + '（来自' + repoSource + '）')
console.log('[prep] 仓库版本: ' + projectVersion())

// ---- 1. SDK 兼容补丁 ----------------------------------------------------
const MARK = 'Local compatibility patch for Windows SDK'
const cppPath = path.join(root, 'apps', 'desktop', 'installer', 'window-frame.cpp')
if (!fs.existsSync(cppPath)) {
  console.log('[prep] 未找到 window-frame.cpp，跳过 SDK 补丁')
} else {
  const src = fs.readFileSync(cppPath, 'utf8')
  const applied = src.includes(MARK)
  // 上游若自行修复，通常会引入 std::min/std::max 的限定调用或补回 min/max 宏
  const upstreamFixed = /using std::min|using std::max|#undef NOMINMAX/.test(src)
  if (applied) {
    console.log('[prep] window-frame.cpp 已含 SDK 兼容补丁，跳过')
  } else {
    const pattern = /#include <dwmapi\.h>[ \t]*\r?\n#include <gdiplus\.h>/
    if (!pattern.test(src)) {
      if (upstreamFixed) {
        console.log('[prep] window-frame.cpp 结构已变，但检测到上游自行修复的迹象（std::min/max 限定），跳过')
      } else {
        console.log('[prep] ⚠️ window-frame.cpp 结构与预期不符，未做修改')
        console.log('[prep]    若原生安装器编译报 C3861(min/max) 或 C4458，请人工检查本步（README §6b）')
      }
    } else {
      const nl = src.includes('\r\n') ? '\r\n' : '\n'
      const block = [
        '#include <dwmapi.h>',
        '// ' + MARK + ' 10.0.19041.0 (re-applied by install-deepseek-desktop.bat).',
        "// That SDK's GDI+ headers call the bare min/max macros (which NOMINMAX removed) and emit",
        '// C4458 inside the system headers, which /WX promotes to errors. Newer SDKs fixed both.',
        '#include <algorithm>',
        'using std::min;',
        'using std::max;',
        '#pragma warning(push)',
        '#pragma warning(disable: 4458)',
        '#include <gdiplus.h>',
        '#pragma warning(pop)',
      ].join(nl)
      fs.writeFileSync(cppPath, src.replace(pattern, block))
      console.log('[prep] 已为 window-frame.cpp 打上 Windows SDK 19041 兼容补丁')
    }
  }
}

// ---- 2. 根目录陈旧的 *.tsbuildinfo -------------------------------------
let removedStamps = 0
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
    try { fs.rmSync(path.join(root, entry.name), { force: true }); removedStamps++ } catch { /* ignore */ }
  }
}
console.log('[prep] 已删除根目录 *.tsbuildinfo：' + removedStamps + ' 个')

// ---- 3. 孤儿包目录 -----------------------------------------------------
function childDirs (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(dir, e.name))
  } catch { return [] }
}

const groups = childDirs(path.join(root, 'packages'))
const removedOrphans = []
for (const group of groups) {
  for (const pkg of childDirs(group)) {
    if (fs.existsSync(path.join(pkg, 'package.json'))) continue
    // 这个位置没有 package.json，只能是跨版本升级留下的旧包目录（上游已删该包）。
    // 里面通常还有旧的 lib/（含 tsbuildinfo）与 node_modules，会让打包器扫到过期编译产物。
    let entries = []
    try { entries = fs.readdirSync(pkg) } catch {}
    try {
      fs.rmSync(pkg, { recursive: true, force: true })
      removedOrphans.push(path.relative(root, pkg) + '   [' + entries.join(', ') + ']')
    } catch (e) {
      removedOrphans.push(path.relative(root, pkg) + '   -> 删除失败: ' + e.message)
    }
  }
}
console.log('[prep] 已删除孤儿包目录：' + removedOrphans.length + ' 个')
for (const p of removedOrphans) console.log('        ' + p)

// ---- 4. pnpm 隐藏提升目录里的坏链接 -------------------------------------
// 位置：node_modules/.pnpm/node_modules（注意也要查 @scope 子目录）
// 三种坏法，都源自「安装被打断」或「master 删掉了某个包」：
//   A. 空目录   —— 本该是 junction，被打断在"先 mkdir、后挂 reparse point"之间
//   B. 死链     —— 链接目标已被删除（多为 master 已移除的 workspace 包）
//   C. 指向残留 —— 目标目录还在，但里面没有 package.json（旧布局残留）
// 危害：Node 报误导性的 Cannot find module；而 realpathSync 遇死链直接 ENOENT，
//      会让 pnpm run dev:desktop 在 prepareDevelopmentProject 处直接失败。
// 处置：只删，不重建 —— 重建需知道"pnpm 会选哪个版本"，而该规则不可复现
//      （实测「被依赖最多/取高版」只命中 6/13），猜错会静默解析到错误版本。
const hoisted = path.join(root, 'node_modules', '.pnpm', 'node_modules')
const brokenLinks = []
if (fs.existsSync(hoisted)) {
  const inspect = (p, label) => {
    let st
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) {
      let real
      try { real = fs.realpathSync(p) } catch { brokenLinks.push([label, '死链']); return }
      if (!fs.existsSync(path.join(real, 'package.json'))) brokenLinks.push([label, '指向无 package.json 的残留'])
      return
    }
    if (st.isDirectory()) {
      let n = 0
      try { n = fs.readdirSync(p).length } catch {}
      if (n === 0) brokenLinks.push([label, '空目录'])
    }
  }
  for (const entry of fs.readdirSync(hoisted, { withFileTypes: true })) {
    if (entry.name.startsWith('.ignored_') || entry.name === '.bin') continue
    const p = path.join(hoisted, entry.name)
    if (entry.name.startsWith('@')) {
      let inner = []
      try { inner = fs.readdirSync(p, { withFileTypes: true }) } catch { continue }
      for (const s of inner) inspect(path.join(p, s.name), entry.name + '/' + s.name)
      continue
    }
    inspect(p, entry.name)
  }
}
let removedLinks = 0
for (const [label, kind] of brokenLinks) {
  try {
    fs.rmSync(path.join(hoisted, ...label.split('/')), { recursive: true, force: true })
    removedLinks++
    console.log('[prep] 已清除坏链接(' + kind + ')：' + label)
  } catch (e) {
    console.log('[prep] 清除失败：' + label + ' -> ' + e.message)
  }
}
console.log('[prep] 已清除提升目录坏链接：' + removedLinks + ' 个（共检出 ' + brokenLinks.length + ' 个）')

// ---- 5. 打包配置：禁止 test 更新通道 -----------------------------------
// desktop-policy-environment.mjs 里写死了：
//   authentication = deployment === 'test' ? 'feishu-test' : 'anonymous'
// 用 test 打出来的包，每次启动都会请求 harness-test.deepseek.com 的强制更新策略接口，
// 拿回 401（feishu auth required）→ queuePolicyAuthentication() → 在整窗口上盖一层
// dsh-app://shell/update-dialog.html 的「需要登录」遮罩 → 界面发白、点不动、关不掉。
// 本地未签名构建永远过不了飞书 SSO，所以这里直接纠正为 production（走 anonymous）。
//
// ⚠️ 0.1.7-alpha.2 起上游收紧了校验（desktop-policy-environment.mjs）：
//      production 必须能解析出 DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN；
//      production 不允许出现 allowedAuthOrigins（即 DSH_DESKTOP_MANDATORY_UPDATE_CONFIG 里不能带它）。
// .env.windows 不存在时就地从 example 生成一份 —— 0.1.7-alpha.2 的 example 里两个 origin
// 都是空值、通道是 test，照抄必然打不出可用的包（production 校验会直接失败）。
const envExample = path.join(root, 'apps', 'desktop', '.env.windows.example')
const envFile = path.join(root, 'apps', 'desktop', '.env.windows')
if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
  fs.writeFileSync(envFile, fs.readFileSync(envExample))
  console.log('[prep] 未找到 .env.windows，已从 .env.windows.example 生成一份')
}
if (!fs.existsSync(envFile)) {
  console.log('[prep] ❌ 既没有 apps/desktop/.env.windows，也没有 .env.windows.example')
  console.log('[prep]    请手工创建 .env.windows，至少包含：')
  console.log('[prep]      DSH_DESKTOP_APP_ID=com.deepseek.harness')
  console.log('[prep]      DSH_DESKTOP_AUTO_UPDATE_ENV=production')
  console.log('[prep]      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://harness.deepseek.com')
} else {
  const original = fs.readFileSync(envFile, 'utf8')
  let fixed = original.replace(/^(\s*DSH_DESKTOP_AUTO_UPDATE_ENV\s*=\s*)test\s*$/mu, '$1production')
  if (fixed !== original) {
    console.log('[prep] ⚠️ .env.windows 里是 AUTO_UPDATE_ENV=test，已自动改为 production')
    console.log('[prep]    （test 会强制飞书 SSO 登录，本地构建永远卡在登录遮罩上）')
  } else if (/^\s*DSH_DESKTOP_AUTO_UPDATE_ENV\s*=\s*production\s*$/mu.test(original)) {
    console.log('[prep] .env.windows 的更新通道已是 production，正常')
  } else {
    console.log('[prep] .env.windows 里没有 AUTO_UPDATE_ENV 行，保持不变')
  }
  // 新版校验：production 必须能解析出 PROD origin（example 里默认留空，这里自动补值）
  const prodOrigin = fixed.match(/^\s*DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN\s*=\s*(\S.*?)\s*$/mu)
  if (!prodOrigin || prodOrigin[1] === '') {
    if (/^\s*DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN\s*=\s*$/mu.test(fixed)) {
      fixed = fixed.replace(/^(\s*DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN\s*=\s*)$/mu, '$1https://harness.deepseek.com')
      console.log('[prep] ⚠️ .env.windows 的 PROD origin 为空（0.1.7-alpha.2 起必填），已自动填入 https://harness.deepseek.com')
    } else {
      fixed += '\nDSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://harness.deepseek.com\n'
      console.log('[prep] ⚠️ .env.windows 缺少 PROD origin，已自动追加 https://harness.deepseek.com')
    }
  }
  // 新版校验：production 不允许 allowedAuthOrigins（只认未注释的赋值行）
  if (/^\s*DSH_DESKTOP_MANDATORY_UPDATE_CONFIG\s*=.*allowedAuthOrigins/mu.test(fixed)) {
    console.log('[prep] ⚠️ .env.windows 的 DSH_DESKTOP_MANDATORY_UPDATE_CONFIG 里含 allowedAuthOrigins，')
    console.log('[prep]    production 通道不允许配置它，打包会直接报错。请删掉该字段。')
  }
  if (fixed !== original) fs.writeFileSync(envFile, fixed)
}

// ---- 6. 壳页面（update-dialog / mandatory-update）的协议分支 ------------
// 状态：✅ 上游 0.1.7-alpha.2 起已自行修复（main.ts 的 protocol.handle 自带 shell host 分支，
//       与本地 0.1.6 时期的补丁逐字一致）。本步现在只做「校验 + 兜底」：
//         · 上游已提供         → 跳过（正常路径）
//         · 上游回退且锚点可匹配 → 自动补回
//         · 两者都不成立        → exit 1，让 .bat 停下（宁可不出包）
//
// 背景（2026-09 在 0.1.6-alpha.2 上定位）：protocol.handle 曾只认 hostname === 'app'，
// 其余一律返回 404 + 空 body。而三种对话框都从 dsh-app://shell/ 加载：
//   update-dialog.ts         dsh-app://shell/update-dialog.html      （检查更新 / 安装确认）
//   mandatory-update-window  dsh-app://shell/mandatory-update.html   （强制更新）
//   policy-login-loading.html                                        （策略登录）
// 结果是 createUpdateOverlay() 开出一个"透明 + modal + skipTaskbar"的空窗口，
// 盖住父窗口（并且故意给父窗口注入 body{filter:blur(2px)}），页面里没有任何按钮，
// 于是：界面发白模糊、点不动、任务栏也关不掉，只能杀进程。
const shellMark = "url.hostname === 'shell'"
const mainTs = path.join(root, 'apps', 'desktop', 'src', 'main.ts')
if (!fs.existsSync(mainTs)) {
  console.log('[prep] 未找到 apps/desktop/src/main.ts，跳过壳页面协议校验')
} else {
  const src = fs.readFileSync(mainTs, 'utf8')
  if (src.includes(shellMark)) {
    console.log('[prep] main.ts 已含 shell 协议分支（上游 0.1.7-alpha.2 起自带），无需本地补丁 ✓')
  } else {
    const nl = src.includes('\r\n') ? '\r\n' : '\n'
    const anchor = "    const url = new URL(request.url)" + nl + "    if (url.hostname === 'app') {"
    const handlerAt = src.indexOf('protocol.handle(SCHEME')
    // 上游可能自己修了（换了常量名 / 别的写法），别误报成"结构不符"
    const region = handlerAt < 0 ? '' : src.slice(handlerAt, handlerAt + 1500)
    const handledUpstream = /hostname\s*===\s*['"]shell['"]/.test(region) || /SHELL_HOST|shellHost/.test(region)
    if (src.includes(anchor)) {
      const block = [
        '    const url = new URL(request.url)',
        '    // [LOCAL PATCH] Serve the shell-owned documents (update / mandatory-update dialogs).',
        '    // Upstream only served the `app` host, so `dsh-app://shell/*` fell through to the 404',
        '    // below: `updateDialog.show()` then opened a blank transparent modal that covered its',
        '    // parent (which it blurs) and could never be dismissed. Fixed upstream in 0.1.7-alpha.2.',
        "    if (url.hostname === 'shell') {",
        "      return serveWebDocument(request, join(app.getAppPath(), 'renderer'))",
        '    }',
        "    if (url.hostname === 'app') {",
      ].join(nl)
      fs.writeFileSync(mainTs, src.replace(anchor, block))
      if (!fs.readFileSync(mainTs, 'utf8').includes(shellMark)) {
        console.error('[prep] ✗ 写入后校验失败：shell 分支没有出现在 main.ts 里')
        process.exit(1)
      }
      console.log('[prep] ⚠️ 上游似乎回退了 shell 协议分支，已自动补回本地补丁')
      console.log('[prep]    请留意：这说明上游可能又引入了「点检查更新就发白卡死」的缺陷')
    } else if (handledUpstream) {
      console.log('[prep] 上游似乎已自行处理 shell host（检测到相关判断），未做修改')
      console.log('[prep]   请人工确认「检查更新」对话框能正常显示')
    } else {
      console.error('[prep] ✗ 无法确认 main.ts 提供 dsh-app://shell/* —— 上游结构已变，且未检测到 shell 分支。')
      if (handlerAt < 0) {
        console.error('[prep]   连 protocol.handle(SCHEME 都找不到了，协议处理很可能被重构。')
      } else {
        console.error('[prep]   protocol.handle 还在，但内层结构与预期不符（缺 anchor）。')
      }
      console.error('[prep]   影响：若不强修，打出来的包点「检查更新」会盖上一层空白遮罩，')
      console.error('[prep]        界面发白、点不动、任务栏也关不掉（详见 README §14）。')
      console.error('[prep]   处理：① 打开 apps/desktop/src/main.ts 的 protocol.handle，')
      console.error('[prep]        确认是否已处理 dsh-app://shell/*；')
      console.error('[prep]        ② 若没有，手工加上 shell 分支（见 README §3.3）；')
      console.error('[prep]        ③ 若上游已修，调整本步判断条件后跳过。')
      process.exit(1)
    }
  }
}

// ---- 7. unsigned 构建的更新源（self-hosted feed）-------------------------
// 背景：electron-builder-config.mjs 里写死了
//     const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(...)
//     publish: update === undefined ? null : [...]
// 于是 DSH_DESKTOP_UNSIGNED=1 时 publish 为 null —— 既不生成 app-update.yml，
// 也不生成 nightly.yml。而运行时 update-coordinator.ts 的 enabled() 要求
// resources/app-update.yml 存在，所以本地未签名包的「检查更新」永远是死的
// （报 "this application has no packaged update source"）。
//
// 本步给 unsigned 分支接上「自托管 feed」：地址来自 DSH_DESKTOP_SELF_UPDATE_URL
// （由 build.bat 从 config.json 注入）。官方 test/production 通道语义完全不动。
//
// ⚠️ 这行是 unsigned 更新源的唯一开关，且失配不会引发编译错误 ——
//    所以锚点找不到时必须 exit 1，绝不静默跳过。
const ebConfigPath = path.join(root, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs')
const SELF_MARK = '[LOCAL PATCH] self-hosted update for unsigned builds'
if (!fs.existsSync(ebConfigPath)) {
  console.error('[prep] ✗ 未找到 apps/desktop/scripts/electron-builder-config.mjs')
  console.error('[prep]   影响：unsigned 包不会生成 app-update.yml，「检查更新」将一直不可用')
  process.exit(1)
} else {
  const src = fs.readFileSync(ebConfigPath, 'utf8')
  if (src.includes(SELF_MARK)) {
    console.log('[prep] electron-builder-config.mjs 已含 unsigned 更新源补丁，跳过')
  } else {
    const updateAnchor = '  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)'
    const fnAnchor = 'export function createElectronBuilderConfig('
    const helper = [
      '/** Environment variable naming the generic feed an unsigned local build updates from. */',
      "export const DESKTOP_SELF_UPDATE_URL = 'DSH_DESKTOP_SELF_UPDATE_URL'",
      '',
      '/** ' + SELF_MARK + '. */',
      'function resolveSelfHostedUpdate (env) {',
      '  const value = env[DESKTOP_SELF_UPDATE_URL]?.trim()',
      "  if (value === undefined || value === '') return undefined",
      '  let parsed',
      '  try { parsed = new URL(value) }',
      "  catch { throw new Error('desktop package: DSH_DESKTOP_SELF_UPDATE_URL must be an absolute HTTPS URL') }",
      "  if (parsed.protocol !== 'https:') throw new Error('desktop package: DSH_DESKTOP_SELF_UPDATE_URL must use HTTPS')",
      "  return { publicUrl: value.endsWith('/') ? value : value + '/' }",
      '}',
      '',
    ].join('\n')

    if (!src.includes(updateAnchor) || !src.includes(fnAnchor)) {
      console.error('[prep] ✗ 无法定位 electron-builder-config.mjs 的 unsigned 更新源锚点，未做修改。')
      if (!src.includes(updateAnchor)) console.error('[prep]     · 缺失: const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(...)')
      if (!src.includes(fnAnchor)) console.error('[prep]     · 缺失: export function createElectronBuilderConfig(')
      console.error('[prep]   影响：unsigned 包不会生成 app-update.yml，「检查更新」将一直不可用。')
      console.error('[prep]   处理：打开 apps/desktop/scripts/electron-builder-config.mjs，')
      console.error('[prep]        ① 确认 update 赋值行是否已改名或重构；')
      console.error('[prep]        ② 若是，调整本步的 updateAnchor 后重跑；')
      console.error('[prep]        ③ 若否，手工把 unsigned 分支接到 resolveSelfHostedUpdate(env)。')
      process.exit(1)
    }

    const patched = src
      .replace(fnAnchor, helper + fnAnchor)
      .replace(updateAnchor, '  const update = unsigned ? resolveSelfHostedUpdate(env) : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)')
    fs.writeFileSync(ebConfigPath, patched)

    const check = fs.readFileSync(ebConfigPath, 'utf8')
    if (!check.includes(SELF_MARK) || !check.includes('unsigned ? resolveSelfHostedUpdate(env)')) {
      console.error('[prep] ✗ 写入后校验失败：unsigned 更新源补丁没有落到 electron-builder-config.mjs')
      process.exit(1)
    }
    console.log('[prep] 已为 electron-builder-config.mjs 接上 unsigned 更新源（self-hosted feed）')
    console.log('[prep]   地址取自 DSH_DESKTOP_SELF_UPDATE_URL；未设置时退回原行为（不生成 feed）')
  }
}
