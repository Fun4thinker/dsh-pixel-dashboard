/**
 * 体检工具：一眼看清这台机器上的插件是否装好、跑的是哪个版本、本机账本在哪里。
 *
 * 存在的理由：这套插件的失败模式大多**不报错**——宿主没换成新实现时，数据照常返回
 * 只是内容陈旧；组合包没被解析到时，patch 的行静默不激活。靠肉眼翻文件很难发现，
 * 所以把判断都收敛到这里。
 *
 * 用法: node tools/doctor.mjs [--profile <name>] [--home <DSH_HOME>] [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePatchLayer } from './patch-layer.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: undefined, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = argv[++i]
    else if (argv[i] === '--profile') args.profile = argv[++i]
    else if (argv[i] === '--json') args.json = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home)
const patchFile = args.profile === undefined
  ? join(home, 'cordis.patch.yml')
  : join(home, 'profiles', args.profile, 'cordis.patch.yml')
const pluginDir = join(home, 'plugins', 'dsh-pixel-dashboard')
const flags = []
/** 记录一条检查结论。 */
const note = (level, message, detail) => flags.push({ level, message, detail })

// ── 1. 构建产物 ────────────────────────────────────────────────
const builtEntry = join(root, 'packages', 'plugin', 'lib', 'index.js')
let builtVersion
if (!existsSync(builtEntry)) {
  note('error', '仓库里还没有构建产物', '先运行：node tools/build.mjs')
} else {
  builtVersion = /IMPL_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'packages', 'plugin', 'lib', 'host.js'), 'utf8'))?.[1]
  note('ok', `构建产物就绪（实现版本 ${builtVersion ?? '未知'}）`, root)
}

// ── 2. 安装登记 ────────────────────────────────────────────────
// 官方方式：组合包进 profile 的 bundles 层；早期方式：手写 loader 行。
// 两者都不算错，但要知道这个 profile 到底走的是哪条。
const profileManifest = args.profile === undefined
  ? undefined
  : join(home, 'profiles', args.profile, 'package.json')
if (profileManifest !== undefined) {
  if (!existsSync(profileManifest)) {
    note('warn', `找不到 profile：${args.profile}`, profileManifest)
  } else {
    const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    if (bundles.includes('dsh-pixel-dashboard-bundle')) {
      note('ok', '官方组合包已登记为该 profile 的配置层', `bundles: ${bundles.join(', ')}`)
    } else {
      note('info', '该 profile 的 bundles 里没有本插件', `bundles: ${bundles.join(', ')}`)
    }
    if (dependencies.includes('dsh-pixel-dashboard')) {
      note('ok', '插件包已是该 profile 的依赖', dependencies.join(', '))
    } else if (bundles.includes('dsh-pixel-dashboard-bundle')) {
      note('warn', '组合包在层列表里，但插件包不是 profile 依赖——patch 的行可能解析失败',
        '本地路径安装时 link: 不解析依赖，需要把插件包也装一次')
    }
  }
}

// 手写 loader 行：只在存在时提示，避免与官方方式重复
if (existsSync(patchFile)) {
  try {
    const entries = parsePatchLayer(readFileSync(patchFile, 'utf8'), patchFile)
    const rows = entries.flatMap((entry) => (Array.isArray(entry.insert) ? entry.insert : []))
    const own = rows.filter((row) => /^pixel-dashboard(-[a-z0-9]+)?$/i.test(String(row.id ?? '')))
    if (own.length > 1) {
      note('warn', `配置层里有 ${own.length} 条本插件的行，应只保留一条`, own.map((row) => row.id).join(', '))
    } else if (own.length === 1) {
      note('info', '配置层里有手写的 loader 行（与官方组合包二选一即可）', `${own[0].id} → ${own[0].name}`)
    }
  } catch (error) {
    note('error', '配置层不是合法 YAML（会让整棵插件树重挂）', error.message)
  }
}

// ── 3. 旧的整机部署目录（早期方式）─────────────────────────────
let deployedVersion
if (existsSync(pluginDir)) {
  const hostFile = join(pluginDir, 'lib', 'host.js')
  deployedVersion = existsSync(hostFile)
    ? /IMPL_VERSION = '([^']+)'/.exec(readFileSync(hostFile, 'utf8'))?.[1]
    : undefined
  note('info', `检测到整机部署目录（早期安装方式，实现版本 ${deployedVersion ?? '未知'}）`,
    `${pluginDir}\n      官方方式不需要它，可用 node tools/uninstall.mjs 清掉`)
  const stale = readdirSync(join(home, 'plugins')).filter((name) => name.startsWith('dsh-pixel-dashboard-'))
  if (stale.length > 0) note('warn', '存在历史版本目录（可删）', stale.join(', '))
}

// ── 4. 运行中的宿主 ────────────────────────────────────────────
const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
let liveVersion
let livePayload
try {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 8000)
  try {
    const response = await fetch(`${base}/dsh-pixel/version`, { signal: controller.signal })
    liveVersion = (await response.json()).version
    const dataResponse = await fetch(`${base}/dsh-pixel/data`, { signal: controller.signal })
    livePayload = await dataResponse.json()
  } finally {
    clearTimeout(timer)
  }
  const expected = existsSync(builtEntry) ? builtVersion : undefined
  if (expected !== undefined && liveVersion === expected) {
    note('ok', `运行中的宿主正是本次构建（${liveVersion}）`, base)
  } else {
    note('warn', '运行中的宿主与仓库构建不一致，需要重启一次 dsh web', `在线 ${liveVersion} / 构建 ${expected}`)
  }
} catch {
  note('info', '没连上正在运行的 dsh，跳过在线核对', base)
}

// ── 5. 用量账本（本机记录）─────────────────────────────────────
const ledgerFromEnv = process.env.DSH_PIXEL_LEDGER
const ledgerPath = livePayload?.ledger?.path
  ?? ledgerFromEnv
  ?? join(home, 'plugins', 'dsh-pixel-dashboard', 'usage-ledger.jsonl')
/** 直接读文件数行：这是账本自身的真实内容。 */
const fileLines = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length
  : 0
if (fileLines > 0) {
  note('ok', `本机用量账本：${fileLines} 条记录、${(statSync(ledgerPath).size / 1024).toFixed(0)} KB`, ledgerPath)
} else {
  note('info', '用量账本还是空的（第一次打开看板时会扫描历史会话并写入）', ledgerPath)
}
if (ledgerFromEnv !== undefined && ledgerFromEnv.trim() !== '') {
  note('info', '账本路径被 DSH_PIXEL_LEDGER 覆盖', ledgerFromEnv)
}
if (livePayload !== undefined) {
  const machine = livePayload.machine ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '未识别'
  const source = livePayload.ledger === undefined ? '（旧实现，统计来自会话日志）' : ''
  note('info',
    `当前统计：${livePayload.overview.sessions} 个会话、${livePayload.overview.totals.requests} 次请求、本机标识 ${machine}${source}`)
}
note('info', '换电脑只需两件事：拷这个仓库 → 运行 node tools/install-official.mjs --profile <profile>',
  '若要连用量历史一起带走，额外复制 usage-ledger.jsonl')

// ── 输出 ───────────────────────────────────────────────────────
if (args.json) {
  console.log(JSON.stringify({ ok: !flags.some((flag) => flag.level === 'error'), flags }, null, 2))
} else {
  const mark = { ok: '✓', warn: '!', error: '✗', info: '·' }
  console.log(`\ndsh-pixel-dashboard 体检（DSH_HOME=${home}${args.profile === undefined ? '' : `，profile=${args.profile}`}）\n`)
  for (const flag of flags) {
    console.log(`  ${mark[flag.level]} ${flag.message}`)
    if (flag.detail !== undefined) console.log(`      ${flag.detail}`)
  }
  const errors = flags.filter((flag) => flag.level === 'error').length
  const warns = flags.filter((flag) => flag.level === 'warn').length
  console.log(`\n结论：${errors === 0 ? '可以正常使用' : '有错误需处理'}${warns > 0 ? `（另有 ${warns} 项提醒）` : ''}`)
  if (errors > 0) process.exitCode = 1
}
