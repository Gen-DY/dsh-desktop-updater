// DSH 桌面端「构建环境预检」原型
//
// 用途：在跑一次 30~60 分钟的构建之前，先把「会失败的条件」全部查出来。
// 设计取向照搬官方 desktop-toolchain-preflight.ts：关键探针「实跑一次真实行为」，
// 而不是只看命令能不能解析到。
//
// 用法：node preflight-build-env.cjs [仓库路径]
// 退出码：0 = 可以构建；1 = 有阻断项；2 = 只有警告

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { execFileSync, execSync } = require('node:child_process')

const { resolveSourceRepo } = require('./paths.cjs')

// 源码仓库位置：命令行参数 > DSH_SOURCE_REPO > config.json > 内置默认
const { repo: REPO, source: REPO_SOURCE } = resolveSourceRepo(process.argv[2])

const OK = 'OK', WARN = 'WARN', FAIL = 'FAIL'
const results = []
const add = (level, name, detail, fix) => results.push({ level, name, detail, fix: fix || '' })

// Windows 上 pnpm / npm 是 .cmd 包装，execFileSync 不做 PATHEXT 解析，必须过 shell。
// 而 vswhere 这类带空格与括号的绝对路径反过来必须不过 shell，否则引号会被吃掉。
function run (cmd, args, options = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, ...options }).trim(),
    }
  } catch (error) {
    return { ok: false, out: (error.stdout || '').toString().trim(), err: error.message }
  }
}

// 需要过 shell 的命令（Windows 上 `pnpm` / `npm` 是 .cmd 包装，execFileSync 解析不到）。
//
// ⚠️ 不要写成 execFileSync('pnpm', ['-v'], { shell: true })：
//    Node 自 22 起对「shell: true + args 数组」发出 DEP0190 弃用警告——
//    该组合下参数只做拼接不做转义，存在注入风险。传完整命令字符串即可绕开。
function runShell (command) {
  try {
    return {
      ok: true,
      out: execSync(command, {
        encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    }
  } catch (error) {
    return { ok: false, out: '', err: error.message }
  }
}

const gb = bytes => bytes / 2 ** 30

function probePort (port, timeout = 2000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
    socket.on('timeout', () => done(false))
  })
}

async function main () {
  // ---- 0. 探测能力自检 ---------------------------------------------------
  // 若当前会话连 node 都派生不出来（EBUSY / EPERM / 受限沙箱 / 杀软拦截），
  // 后面所有基于外部命令的探测都会失败。此时绝不能报成「你没装 Node」——
  // 那是假警报，会误导用户去重装环境。直接报「探测不可用」并停下。
  const selfProbe = run(process.execPath, ['-v'])
  if (!selfProbe.ok || selfProbe.out.length === 0) {
    console.log('')
    console.log('='.repeat(64))
    console.log(' DSH 桌面端构建环境预检')
    console.log('='.repeat(64))
    console.log('')
    console.log(' ✗ 预检无法进行：当前会话不能派生子进程。')
    console.log('')
    console.log('   底层错误: ' + String(selfProbe.err || 'unknown').slice(0, 120))
    console.log('')
    console.log('   这不是构建环境不足，而是执行环境受限。常见原因：')
    console.log('     · 杀毒软件 / 终端防护拦截了子进程创建')
    console.log('     · 在受限沙箱或受限用户下运行')
    console.log('     · 系统资源暂时不可用（EBUSY）')
    console.log('')
    console.log('   请在普通命令行窗口（cmd 或 Windows Terminal）里直接运行本脚本。')
    console.log('')
    process.exit(2)
  }

  // ---- 1. Node ----------------------------------------------------------
  // 阈值来自仓库 package.json 的 engines: "^22.19.0 || >=24.0.0"
  {
    // 用 process.execPath 而非 'node'：不依赖 PATH —— 当前进程能跑，就一定能再调起来
    const v = run(process.execPath, ['-v'])
    const version = v.out.replace(/^v/, '')
    const [maj, min] = version.split('.').map(Number)
    const inRange = (maj === 22 && min >= 19) || maj >= 24
    if (!inRange) {
      add(FAIL, 'Node.js 版本', `v${version} 不满足 engines "^22.19.0 || >=24.0.0"`,
        '安装 Node.js 22.19+ 或 24+')
    } else {
      add(OK, 'Node.js 版本', `v${version}`)
    }
  }

  // ---- 2. pnpm ----------------------------------------------------------
  // 仓库 packageManager 字段钉的是 pnpm@11.7.0
  {
    const v = runShell('pnpm -v')
    if (!v.ok || v.out === '') {
      add(FAIL, 'pnpm', '未找到 pnpm（或不在 PATH）', 'npm i -g pnpm@11.7.0')
    } else if (v.out !== '11.7.0') {
      add(WARN, 'pnpm 版本', `${v.out}（仓库 packageManager 钉的是 11.7.0）`,
        '版本不一致可能改变依赖树，建议 npm i -g pnpm@11.7.0')
    } else {
      add(OK, 'pnpm', v.out)
    }
  }

  // ---- 3. git -----------------------------------------------------------
  // 不是硬依赖：.bat 里有占位 hash 兜底，只影响构建信息里的版本号显示
  {
    const v = run('git', ['--version'])
    const hasDotGit = fs.existsSync(path.join(REPO, '.git'))
    if (!v.ok) add(WARN, 'git', '未找到 git（构建会写入占位 commit hash）', '可选；不影响出包')
    else if (!hasDotGit) add(WARN, 'git 仓库', '仓库根没有 .git（将使用占位 hash）', '可选；不影响出包')
    else add(OK, 'git', `${v.out} + 仓库带 .git`)
  }

  // ---- 4. Visual Studio C++ 工具链（硬依赖）------------------------------
  // 与官方 probeWindowsInstallerToolchain 同一判据：vswhere -requires VC.Tools.x86.x64
  // 原生安装器 UI（window-frame.cpp 等）必须用 MSVC 编译，缺了必然失败
  {
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (!fs.existsSync(vswhere)) {
      add(FAIL, 'Visual Studio', '未找到 vswhere.exe，无法定位 VS',
        '安装 Visual Studio 2019/2022 并勾选「使用 C++ 的桌面开发」')
    } else {
      const located = run(vswhere, ['-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])
      if (!located.ok || located.out === '') {
        add(FAIL, 'Visual Studio C++ 工具链', 'vswhere 找不到 VC.Tools.x86.x64 组件',
          '在 VS 安装器里勾选「使用 C++ 的桌面开发」工作负载')
      } else {
        const ver = run(vswhere, ['-latest', '-products', '*', '-property', 'catalog_productDisplayVersion'])
        add(OK, 'Visual Studio C++ 工具链', `${located.out} (${ver.out})`)
      }
    }
  }

  // ---- 5. Windows SDK ---------------------------------------------------
  // >= 10.0.19041 是可构建下限；19041 本身会让 GDI+ 头文件报 C3861/C4458，
  // 需要 prepare-build.cjs 第 1 步的补丁。20348 起微软已修复，补丁可退役。
  {
    const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\Include'
    let versions = []
    try { versions = fs.readdirSync(kits).filter(v => /^10\./.test(v)).sort() } catch {}
    if (versions.length === 0) {
      add(FAIL, 'Windows SDK', '未找到任何 10.x SDK', '随 VS 安装「Windows 10/11 SDK」组件')
    } else {
      const newest = versions.at(-1)
      const build = Number(newest.split('.')[2])
      if (build < 19041) {
        add(FAIL, 'Windows SDK', `最高 ${newest}，低于构建下限 10.0.19041`,
          '安装 10.0.20348.0（VS2019 支持的最后一个）或更新')
      } else if (build < 20348) {
        add(WARN, 'Windows SDK', `最高 ${newest}（需 prepare-build.cjs 的 GDI+ 兼容补丁）`,
          '可选：装 10.0.20348.0 可免补丁；不装则保持补丁在位')
      } else {
        add(OK, 'Windows SDK', `${newest}（已含 GDI+ 修复，补丁可退役）`)
      }
    }
  }

  // ---- 6. 磁盘空间（最容易被忽略、也最容易白跑）---------------------------
  // 一次完整构建的占用：node_modules 重建 + electron + 内嵌 runtime
  // （node/pnpm/python/libreoffice）+ win-unpacked + 安装包 + zip
  {
    // 阈值可覆盖：实际需要多少取决于产物规模（13.7 GB 也曾成功构建过）。
    // 想按自己机器调整就设 DSH_PREFLIGHT_MIN_FREE_GB=<GB>。
    const configured = Number(process.env.DSH_PREFLIGHT_MIN_FREE_GB)
    const NEED_FAIL = Number.isFinite(configured) && configured > 0 ? configured : 15
    const NEED_WARN = Math.max(NEED_FAIL + 10, 25)
    let worst = null
    for (const drive of ['C:\\', 'D:\\']) {
      let free = null
      try {
        const st = fs.statfsSync(drive)
        free = gb(Number(st.bavail) * Number(st.bsize))
      } catch {}
      if (free === null) continue
      if (worst === null || free < worst.free) worst = { drive, free }
    }
    if (worst === null) {
      add(WARN, '磁盘空间', '无法读取', '')
    } else if (worst.free < NEED_FAIL) {
      add(FAIL, '磁盘空间', `${worst.drive} 仅剩 ${worst.free.toFixed(1)} GB（构建需 ≥ ${NEED_FAIL} GB）`,
        `清理 ${worst.drive}，或把仓库与 pnpm store 迁到空间更大的盘。注意：删到回收站不会释放空间，需清空回收站`)
    } else if (worst.free < NEED_WARN) {
      add(WARN, '磁盘空间', `${worst.drive} 剩 ${worst.free.toFixed(1)} GB（建议 ≥ ${NEED_WARN} GB）`,
        '构建中途可能耗尽')
    } else {
      add(OK, '磁盘空间', `${worst.drive} 剩 ${worst.free.toFixed(1)} GB`)
    }
  }

  // ---- 7. 源码工作区 ----------------------------------------------------
  {
    const missing = []
    for (const rel of ['package.json', 'pnpm-workspace.yaml', 'apps/desktop', 'apps/desktop/src/main.ts']) {
      if (!fs.existsSync(path.join(REPO, rel))) missing.push(rel)
    }
    if (missing.length > 0) {
      add(FAIL, '源码工作区', `${REPO} 缺少 ${missing.join('、')}`, '拉取完整源码树')
    } else {
      let version = '?'
      try { version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version } catch {}
      add(OK, '源码工作区', `${REPO} @ ${version}`)
    }
  }

  // ---- 8. 依赖与本地配置 --------------------------------------------------
  {
    const nm = path.join(REPO, 'node_modules')
    if (!fs.existsSync(nm)) {
      add(WARN, 'node_modules', '不存在（需 pnpm install --force，首次 10~30 分钟）', '可由安装流程自动完成')
    } else {
      add(OK, 'node_modules', `存在，顶层 ${fs.readdirSync(nm).length} 项`)
    }
    const envFile = path.join(REPO, 'apps', 'desktop', '.env.windows')
    if (!fs.existsSync(envFile)) {
      add(WARN, '.env.windows', '不存在（prepare-build.cjs 会自动生成）', '可由 prepare-build.cjs 自动完成')
    } else {
      add(OK, '.env.windows', '存在')
    }
  }

  // ---- 9. pnpm store ----------------------------------------------------
  {
    const store = path.join(path.parse(REPO).root, '.pnpm-store')
    if (!fs.existsSync(store)) add(WARN, 'pnpm store', '不存在（首次安装会全量下载）', '可选；网络快可忽略')
    else add(OK, 'pnpm store', store)
  }

  // ---- 10. 代理（本机特定，可删）------------------------------------------
  {
    const ports = [17890, 9260]
    const open = []
    for (const port of ports) if (await probePort(port)) open.push(port)
    if (open.includes(17890)) add(OK, '代理', `127.0.0.1:17890 可连`)
    else add(WARN, '代理', '127.0.0.1:17890 未监听', '拉取/推送 GitHub 需要它；直连会超时')
  }

  // ---- 11. tar 行为（照官方做法：实跑，不只看命令是否存在）------------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tar-probe-'))
    try {
      fs.writeFileSync(path.join(dir, 'probe.txt'), 'probe\n')
      // 关键：在临时目录里用相对名，绕开 GNU tar 把 "D:" 当远程主机的坑
      const packed = run('tar', ['-czf', 'probe.tar.gz', 'probe.txt'], { cwd: dir })
      if (!packed.ok) {
        add(WARN, 'tar（归档）', `打包探测失败：${(packed.err || '').slice(0, 80)}`,
          '打包阶段会用到 tar；确认用的是 bsdtar（C:\\Windows\\System32\\tar.exe）')
      } else {
        const listed = run('tar', ['-tzf', 'probe.tar.gz'], { cwd: dir })
        if (listed.ok && listed.out.includes('probe.txt')) add(OK, 'tar（归档）', '可正常打包/解包')
        else add(WARN, 'tar（归档）', `解包结果异常：${listed.out.slice(0, 80)}`, '')
      }
    } catch (error) {
      add(WARN, 'tar（归档）', String(error.message).slice(0, 80), '')
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }

  // ---- 12. 管理员权限 ---------------------------------------------------
  // VS / Windows SDK 的安装必须管理员；构建本身不需要
  {
    // powershell.exe 是真正的 PE 可执行文件，用绝对名直调即可，无需过 shell
    const out = run('powershell.exe', ['-NoProfile', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'])
    if (/^true$/i.test(out.out)) add(OK, '管理员权限', '当前具备')
    else add(WARN, '管理员权限', '当前为普通用户', '仅影响「安装 VS/SDK」这类修复动作；构建本身不需要')
  }

  report()
}

function report () {
  const order = { FAIL: 0, WARN: 1, OK: 2 }
  results.sort((a, b) => order[a.level] - order[b.level])
  const icon = { OK: '✓', WARN: '!', FAIL: '✗' }
  const fails = results.filter(r => r.level === FAIL)
  const warns = results.filter(r => r.level === WARN)

  console.log('')
  console.log('='.repeat(64))
  console.log(' DSH 桌面端构建环境预检')
  console.log('='.repeat(64))
  for (const r of results) {
    console.log(` ${icon[r.level]} [${r.level.padEnd(4)}] ${r.name}`)
    console.log(`          ${r.detail}`)
    if (r.fix) console.log(`          → ${r.fix}`)
  }
  console.log('-'.repeat(64))
  console.log(` 通过 ${results.filter(r => r.level === OK).length} / 警告 ${warns.length} / 阻断 ${fails.length}`)
  console.log('')
  if (fails.length > 0) {
    console.log(' 结论：环境不满足，现在开始构建会白跑（30~60 分钟）。先解决上面的阻断项。')
  } else if (warns.length > 0) {
    console.log(' 结论：可以构建，但有警告项。')
  } else {
    console.log(' 结论：环境完整，可以构建。')
  }
  console.log('')
  process.exit(fails.length > 0 ? 1 : warns.length > 0 ? 2 : 0)
}

main().catch(error => {
  console.error('预检脚本自身出错：', error)
  process.exit(3)
})
