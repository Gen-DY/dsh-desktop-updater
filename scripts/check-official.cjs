#!/usr/bin/env node
/**
 * 查询 DeepSeek Harness 官方版本，并按 semver 判断是否比"当前版本"新。
 *
 * 数据源：npm registry 的 dist-tags。
 *   - 直连可用，无需代理
 *   - 国内可用 npmmirror 镜像（--registry 覆盖）
 *   - 不依赖 GitHub（同事环境未必有代理）
 *
 * 判定规则（重要）：
 *   取官方**所有**已发布版本里 semver 最高的那个，**不绑定任何渠道**。
 *   渠道（latest / next / alpha …）是官方的发布策略，会新增、会变
 *   —— 比如 `next` 这个标签是 2026-09-23 发 0.1.7-rc.1 时才出现的。
 *   早期版本按"跟随当前构建线"（只比 alpha）实现，结果官方推进到
 *   0.1.7-rc.1 后完全漏报。所以这里只认 semver 顺序。
 *
 * 用法：
 *   node check-official.cjs                     # 当前版本取自源码仓库 package.json
 *   node check-official.cjs --current 0.1.7-alpha.2
 *   node check-official.cjs --json              # 机器可读输出
 *   node check-official.cjs --registry https://registry.npmmirror.com
 *
 * 退出码：0 = 探测成功（不看有无更新）；2 = 探测失败。
 */

'use strict'

const https = require('node:https')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

// ---------------------------------------------------------------- semver ---

/**
 * 解析 semver 为可比较的结构。只处理本场景需要的子集：
 * `major.minor.patch` 加可选的 `-prerelease`。不处理 build metadata（`+`）。
 * @param {string} value - 版本字符串。
 * @returns {{core: number[], pre: (string|number)[]}|undefined} 解析结果；无效时 undefined。
 */
function parseSemver (value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim())
  if (match === null) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (
    /^\d+$/.test(part) ? Number(part) : part
  ))
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre }
}

/**
 * 按 semver 规范比较两个版本。prerelease 优先级：alpha < beta < rc < 正式版，
 * 由字符串字典序自然给出（数字标识符永远低于字母标识符）。
 * @param {string} left - 左值。
 * @param {string} right - 右值。
 * @returns {number} 负数表示 left 更旧，正数表示更新，0 表示相同。
 */
function compareSemver (left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === undefined || b === undefined) return String(left).localeCompare(String(right))
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1 // 有 prerelease 的更低
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) return x - y
    if (xNum) return -1 // 数字标识符低于字母
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

// ------------------------------------------------------------------ HTTP ---

/**
 * 发起 GET 并按 JSON 解析。
 * @param {string} url - 完整地址。
 * @returns {Promise<object>} 解析后的 JSON。
 */
function fetchJson (url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, { headers: { accept: 'application/json' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        response.resume()
        resolve(fetchJson(response.headers.location))
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`registry returned HTTP ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`registry returned invalid JSON: ${error.message}`))
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('registry request timed out')))
  })
}

// ------------------------------------------------------------------ main ---

/**
 * 解析命令行参数。
 * @param {string[]} argv - 参数列表（不含 node 与脚本名）。
 * @returns {{current?: string, json: boolean, registry: string}} 解析结果。
 */
function parseArguments (argv) {
  const options = { json: false, registry: DEFAULT_REGISTRY }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') options.json = true
    else if (token === '--current') options.current = argv[++i]
    else if (token === '--registry') options.registry = (argv[++i] ?? '').replace(/\/+$/, '')
    else if (token === '--help' || token === '-h') options.help = true
  }
  return options
}

/**
 * 当前安装版本：优先命令行参数，其次源码仓库的 package.json。
 * @returns {{version?: string, source: string}} 版本与来源说明。
 */
function resolveCurrentVersion () {
  try {
    const { resolveSourceRepo } = require(path.join(__dirname, 'paths.cjs'))
    const { repo } = resolveSourceRepo()
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    return { version: manifest.version, source: `源码仓库 ${repo}` }
  } catch (error) {
    return { source: `无法读取源码仓库版本（${error.message}）` }
  }
}

/**
 * 入口。
 * @returns {Promise<number>} 进程退出码。
 */
async function main () {
  const options = parseArguments(process.argv.slice(2))
  if (options.help === true) {
    console.log('用法: node check-official.cjs [--current <版本>] [--json] [--registry <地址>]')
    return 0
  }

  const url = `${options.registry}/${PACKAGE.replace('/', '%2F')}`
  let metadata
  try {
    metadata = await fetchJson(url)
  } catch (error) {
    console.error(`[错误] 无法查询 npm registry: ${error.message}`)
    console.error(`       地址: ${url}`)
    console.error('       可换镜像重试: --registry https://registry.npmmirror.com')
    return 2
  }

  const tags = metadata['dist-tags'] ?? {}
  const versions = Object.keys(metadata.time ?? {}).filter((key) => key !== 'created' && key !== 'modified')
  if (versions.length === 0) {
    console.error('[错误] registry 返回的版本列表为空')
    return 2
  }

  const ranked = [...versions].sort(compareSemver)
  const newest = ranked[ranked.length - 1]
  const newestChannels = Object.entries(tags).filter(([, value]) => value === newest).map(([key]) => key)

  if (options.current === undefined) {
    const resolved = resolveCurrentVersion()
    options.current = resolved.version
    options.currentSource = resolved.source
  }

  // 三态判定。布尔表达不了"无法比较"，而"当前比官方还新"也不该与"已是最新"混同。
  //   outdated = 官方有更新（当前落后）
  //   current  = 与官方 semver 最高相同
  //   ahead    = 当前比官方 semver 最高还新（本地改过版本号，或官方回退了渠道指向）
  //   unknown  = 当前版本不是合法 semver，无法比较
  const currentParseable = options.current !== undefined && parseSemver(options.current) !== undefined
  let relation = 'unknown'
  if (currentParseable) {
    const comparison = compareSemver(newest, options.current)
    relation = comparison > 0 ? 'outdated' : (comparison === 0 ? 'current' : 'ahead')
  }
  const updateAvailable = relation === 'unknown' ? null : relation === 'outdated'

  if (options.json) {
    console.log(JSON.stringify({
      package: PACKAGE,
      registry: options.registry,
      channels: tags,
      newest,
      newestChannels,
      current: options.current ?? null,
      currentSource: options.currentSource ?? null,
      currentParseable,
      relation,
      updateAvailable,
    }, null, 2))
    return 0
  }

  console.log('='.repeat(62))
  console.log(`官方渠道  @deepseek-ai/dsh · ${options.registry}`)
  console.log('='.repeat(62))
  const width = Math.max(...Object.keys(tags).map((key) => key.length), 6)
  for (const [channel, version] of Object.entries(tags).sort((a, b) => compareSemver(b[1], a[1]))) {
    const marker = version === newest ? '  ← semver 最高' : ''
    console.log(`  ${channel.padEnd(width)}  ${version}${marker}`)
  }

  console.log('\n' + '-'.repeat(62))
  console.log(`  semver 最高   ${newest}${newestChannels.length ? `  （渠道 ${newestChannels.join(', ')}）` : ''}`)
  if (options.current === undefined) {
    console.log('  当前版本      （未知 —— 请用 --current 指定，或确认源码仓库路径）')
    console.log(`               ${options.currentSource ?? ''}`)
    console.log('\n结论：无法比较（缺当前版本）')
    return 0
  }
  console.log(`  当前版本      ${options.current}`)
  if (options.currentSource !== undefined) console.log(`               （来源：${options.currentSource}）`)
  console.log('-'.repeat(62))

  if (relation === 'outdated') {
    console.log(`\n结论：**有更新** → ${newest}`)
    console.log(`      （当前 ${options.current} → ${newest}）`)
  } else if (relation === 'current') {
    console.log('\n结论：已是最新')
  } else if (relation === 'ahead') {
    console.log(`\n结论：当前版本比官方 semver 最高还新（${options.current} > ${newest}）`)
    console.log('      多半是本地构建时改过版本号，或官方回退了渠道指向。')
  } else {
    console.log(`\n结论：无法比较 —— 当前版本 "${options.current}" 不是合法 semver`)
    console.log('      正常形如 0.1.7-alpha.2 / 0.1.7-rc.1 / 0.1.7')
  }

  return 0
}

module.exports = { compareSemver, parseSemver, PACKAGE }

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error('[错误] 未预期的失败:', error)
    process.exit(2)
  })
}
