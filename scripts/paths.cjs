// 共用路径解析：源码仓库位置 与 本地 feed 目录。
//
// 为什么需要这个文件：旧版脚本依赖「脚本就躺在源码仓库根目录」这个前提
// （用 __dirname 当仓库根）。搬进本工具仓库后，脚本与源码仓库分离了，
// 必须显式解析源码仓库位置。
//
// 优先级（前者优先）：
//   1. 命令行参数        node xxx.cjs <源码仓库路径>
//   2. 环境变量          DSH_SOURCE_REPO
//   3. 配置文件          <工具根>/config.json 的 sourceRepo
//   4. 内置默认值        DEFAULT_SOURCE_REPO
//
// 也可当命令行工具用：
//   node paths.cjs repo [源码路径]   打印解析后的源码仓库路径
//   node paths.cjs feed              打印本地 feed 目录
//   node paths.cjs home              打印 DSH home

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

/** 工具仓库根目录（本文件在 scripts/ 下）。 */
const TOOL_ROOT = path.join(__dirname, '..')

/** 未配置时的兜底源码仓库位置。 */
const DEFAULT_SOURCE_REPO = 'D:\\codes\\deepseek-harness'

function readConfig () {
  try {
    return JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * DSH home，与官方 `@deepseek-ai/dsh-home-paths` 的优先级一致：
 * `$DSH_HOME`（非空白）> `~/.dsh`。
 */
function resolveDshHome () {
  const env = (process.env.DSH_HOME || '').trim()
  return env.length > 0 ? path.resolve(env) : path.join(os.homedir(), '.dsh')
}

/**
 * 本地构建产出的 feed 目录。放在 DSH home 下，跟随 $DSH_HOME 一起迁移，
 * 也与官方「harness keeps all user data under one root」的约定一致。
 */
function localFeedDirectory () {
  return path.join(resolveDshHome(), 'desktop-updates')
}

/**
 * 解析源码仓库位置。
 * @param {string|undefined} cliArg 命令行传入的路径。
 * @returns {{ repo: string, source: string }} 绝对路径与来源说明（便于日志排查）。
 */
function resolveSourceRepo (cliArg) {
  const candidates = [
    ['命令行参数', (cliArg || '').trim()],
    ['环境变量 DSH_SOURCE_REPO', (process.env.DSH_SOURCE_REPO || '').trim()],
    ['config.json', String(readConfig().sourceRepo || '').trim()],
    ['内置默认值', DEFAULT_SOURCE_REPO],
  ]
  for (const [source, value] of candidates) {
    if (value.length > 0) return { repo: path.resolve(value), source }
  }
  /* istanbul ignore next -- 第 4 项永远非空，这里不可达 */
  throw new Error('paths: no source repository configured')
}

/**
 * 自托管更新源地址（unsigned 构建的 generic feed）。
 * 来自 config.json 的 `selfUpdateUrl`；未配置时返回空串 ——
 * 此时不生成 app-update.yml，行为退回「unsigned 包没有更新源」。
 */
function resolveSelfUpdateUrl () {
  return String(readConfig().selfUpdateUrl || '').trim()
}

module.exports = {
  TOOL_ROOT, DEFAULT_SOURCE_REPO, readConfig,
  resolveDshHome, localFeedDirectory, resolveSourceRepo, resolveSelfUpdateUrl,
}

/**
 * 源码仓库当前的版本号（读它的 package.json）。
 *
 * 为什么需要：产物校验不能只看「产物目录里有没有 exe」—— 那会把**上次构建残留的旧版本**
 * 误判成「本次产物已生成」。必须先取到本次要构建的版本号，再精确匹配文件名。
 * @returns {string} 版本号；读不到时返回空串。
 */
function sourceVersion () {
  try {
    const { repo } = resolveSourceRepo()
    return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

if (require.main === module) {
  const what = process.argv[2]
  if (what === 'repo') console.log(resolveSourceRepo(process.argv[3]).repo)
  else if (what === 'feed') console.log(localFeedDirectory())
  else if (what === 'home') console.log(resolveDshHome())
  else if (what === 'feedurl') console.log(resolveSelfUpdateUrl())
  else if (what === 'version') console.log(sourceVersion())
  else {
    console.log('用法: node paths.cjs repo [源码路径] | feed | home | feedurl | version')
    process.exit(1)
  }
}
