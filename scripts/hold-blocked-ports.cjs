#!/usr/bin/env node
/**
 * 占住 Node fetch（undici）封禁的端口，避免系统把随机端口分配给它。
 *
 * 背景：打包末尾的冒烟验证会起一个本地 web 服务（`host: 127.0.0.1, port: 0`，
 * 即让系统随机分配端口），然后用 Node 内置 fetch 去请求它。
 * 但 undici 有一份「封禁端口」黑名单（PPTP/H323/NFS 等协议端口），
 * 对黑名单里的端口直接抛 `TypeError: fetch failed` + `cause: bad port` ——
 * 请求根本发不出去。冒烟于是报 `bad port` 而失败，产物作废。
 *
 * 本机尤其容易撞上：动态端口范围被改成了 1024~15000
 * （Windows 默认 49152~65535），与黑名单的重叠面更大。
 *
 * 做法：把这些端口先 listen 起来。系统的 `listen(0)` 选端口时会跳过已占用的，
 * 自然不会分到黑名单里的端口。**不改官方任何代码。**
 *
 * 用法：build.bat 在打包阶段前后台启动；到期自动退出（默认 120 分钟）。
 *       DSH_HOLD_PORTS_MINUTES 可覆盖时长。
 */

const net = require('node:net')

// undici 封禁端口里 >= 1024 的那些（< 1024 需要管理员，且通常不在动态范围内）
const BLOCKED = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]

const minutes = Number(process.env.DSH_HOLD_PORTS_MINUTES || 120)

/** @type {import('node:net').Server[]} */
const servers = []
let held = 0
let busy = 0

for (const port of BLOCKED) {
  const server = net.createServer(() => {})
  server.on('error', () => { busy += 1 })   // 已被别的程序占用 —— 不冲突，忽略
  try {
    server.listen(port, '127.0.0.1', () => { held += 1 })
  } catch {
    busy += 1
  }
  servers.push(server)
}

// 给 listen 一点时间落地，再汇报
setTimeout(() => {
  console.log(`[hold-ports] 已占住 ${held} 个端口（另有 ${busy} 个已被其他程序占用）`)
  console.log(`[hold-ports] 名单: ${BLOCKED.join(', ')}`)
  console.log(`[hold-ports] ${minutes} 分钟后自动退出`)
}, 300)

// 兜底：到期自动释放，避免构建异常结束时残留
const timer = setTimeout(() => {
  for (const server of servers) {
    try { server.close() } catch {}
  }
  process.exit(0)
}, minutes * 60_000)
timer.unref()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
