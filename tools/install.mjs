/**
 * 安装脚本：把插件装进当前 DSH 部署，不需要重启 dsh。
 *
 * 关键设计（都是踩过的坑）：
 *   1) **行 id 固定**。Loader 按行做增量更新；换成随版本变化的 id，会让新旧两行
 *      同时占用同一个 HTTP 路由，注册冲突导致整体回滚——而旧代码继续应答，
 *      表面上没有任何报错。
 *   2) **实现版本由源码哈希派生**，写在入口的动态 import 上，因此重新构建即可
 *      热更新，不存在「忘了加版本号」这种失败模式。
 *   3) **写入补丁层前先做 YAML 校验**：补丁层写坏会重挂整棵插件树，
 *      浏览器端却只表现为 “Failed to fetch”。
 *
 * 用法: node tools/install.mjs [--source dist] [--profile <name>] [--home <DSH_HOME>] [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPatchLayer, readCleaned } from './patch-layer.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 固定的 loader 行 id：换 id 会引发路由冲突与整体回滚。 */
const ENTRY_ID = 'pixel-dashboard'

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = {
    profile: undefined,
    home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    source: 'dist',
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--profile') args.profile = argv[++i]
    else if (token === '--home') args.home = argv[++i]
    else if (token === '--source') args.source = argv[++i]
    else if (token === '--dry-run') args.dryRun = true
  }
  return args
}

/** 安全列目录，不存在时返回空数组。 */
function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home)
const patchFile = args.profile === undefined
  ? join(home, 'cordis.patch.yml')
  : join(home, 'profiles', args.profile, 'cordis.patch.yml')
const sourceDir = join(root, args.source)
const targetDir = join(home, 'plugins', pkg.name)
const entryPath = join(targetDir, 'lib', 'index.js').split(sep).join('/')

if (!existsSync(sourceDir)) {
  console.error(`找不到构建产物 ${sourceDir}`)
  console.error('先运行：node tools/build-deploy.mjs')
  process.exit(1)
}
if (args.profile !== undefined && !existsSync(join(home, 'profiles', args.profile))) {
  console.error(`找不到 profile：${join(home, 'profiles', args.profile)}`)
  process.exit(1)
}

/**
 * 部署目录的内容指纹。
 *
 * 让补丁层文本在「实现变了」时也真的变化：Loader 只按行做增量更新，而 Node 不会
 * 重新 import 已 import 过的模块 specifier。补丁内容一字不改的重装不会让运行中的
 * 进程换实现（只会看到旧数据），把指纹写进注释就能一变即触发重载。
 * @param {string} dir - 部署目录。
 * @returns {string} 8 位十六进制指纹。
 */
function distFingerprint(dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 8)
}

const fingerprint = distFingerprint(sourceDir)

const yamlBlock = [
  '# ── 用户插件：像素风皮肤与用量看板（由 dsh-pixel-plugin/tools/install.mjs 写入）──',
  '# 卸载：node tools/uninstall.mjs；或删掉下面这个 insert 块。',
  `# 实现：${args.source}/lib/index.js · 构建指纹 ${fingerprint}`,
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  `      name: '${entryPath}'`,
].join('\n')

const cleaned = readCleaned(patchFile)
const merged = `${cleaned === '' ? '' : `${cleaned}\n\n`}${yamlBlock}\n`
try {
  assertPatchLayer(merged, patchFile)
} catch (error) {
  console.error(`补丁层校验失败，已中止（未写入任何内容）：\n  ${error.message}`)
  process.exit(1)
}

if (args.dryRun) {
  console.log('--- 将写入 cordis.patch.yml（已通过 YAML 校验）---')
  console.log(merged)
} else {
  writeFileSync(patchFile, merged, 'utf8')
  mkdirSync(join(home, 'plugins'), { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
  writeFileSync(
    join(targetDir, 'README.md'),
    `# ${pkg.name}\n\n由 ${root} 安装（源码与脚本见该目录）。\n\n${pkg.description}\n\n`
    + '更新：`node tools/build-deploy.mjs` 后 `node tools/install.mjs`。\n'
    + '卸载：`node tools/uninstall.mjs`。\n',
    'utf8',
  )
  // 清理早期「一版一目录」留下的残留
  for (const dir of readdirSafe(join(home, 'plugins'))) {
    if (dir.startsWith(`${pkg.name}-`)) {
      rmSync(join(home, 'plugins', dir), { recursive: true, force: true })
      console.log(`已清理历史版本目录：${dir}`)
    }
  }
}

console.log(`\n插件包：${targetDir}`)
console.log(`装载入口：${entryPath}`)
console.log(`补丁层：${patchFile}`)
console.log(`构建指纹：${fingerprint}`)

if (args.dryRun) {
  console.log('\n（--dry-run：未写入任何内容）')
  process.exit(0)
}

/**
 * 核对运行中的宿主是否已经换成这次部署的实现。
 *
 * 这一步很有必要：Loader 不会重新 import 已 import 过的 specifier，热重载失败时
 * 表现是「数据照常返回、只是内容陈旧」，光看有没有报错根本发现不了。
 * @returns {Promise<void>}
 */
async function verifyRunning() {
  const expected = /IMPL_VERSION = '([^']+)'/.exec(readFileSync(join(sourceDir, 'lib', 'host.js'), 'utf8'))?.[1]
  const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 8000)
  try {
    const response = await fetch(`${base}/dsh-pixel/version`, { signal: controller.signal })
    const info = await response.json()
    if (info.version === expected) {
      console.log('\n运行中的宿主已是本次构建，刷新浏览器页面即可看到新界面。')
    } else {
      console.log(`\n⚠ 运行中的宿主仍是旧实现（在线 ${info.version} / 本次 ${expected}）。`)
      console.log('  热重载没生效，请重启一次 dsh web —— 这是唯一可靠的办法。')
    }
  } catch {
    console.log('\n（没连上正在运行的 dsh，跳过在线核对；刷新浏览器页面即可。）')
  } finally {
    clearTimeout(timer)
  }
}

await verifyRunning()
