#!/usr/bin/env node
/**
 * 把本机 desktop（或其他）profile 里的插件同步到上游最新提交。
 *
 * ## 为什么需要这个脚本
 *
 * 桌面端 profile 是 Electron 独占管理的：`dsh plugin --profile desktop add ...`
 * 会被 CLI 外壳的 `rejectElectronProfile()` 直接拒掉（"managed exclusively by the
 * Electron application"）。但桌面端的插件管理器本身就是在 profile 目录里跑 pnpm，
 * 所以**绕开 CLI、直接用 pnpm 重解析**是可行且与桌面端同构的路径。
 *
 * 另外：npm 上没有 2.12.4 之后的版本（本机也没有发布凭据），因此这条插件实际只走
 * GitHub。而 pnpm 会把 github 依赖钉在**确切 commit** 上，意味着「上游更新了」不会
 * 自动生效——必须显式 `pnpm update`。这个脚本就是把那一步做成可重复、可报告的。
 *
 * ## 用法
 *
 *   node tools/sync-desktop.mjs --check          # 只报告，不动任何文件
 *   node tools/sync-desktop.mjs                  # 落后就更新到上游 main
 *   node tools/sync-desktop.mjs --profile web    # 换 profile
 *
 * 更新后需要**重启 dsh**（宿主模块只在启动时加载）；客户端半边刷新页面即可。
 *
 * @module tools/sync-desktop
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { profile: 'desktop', check: false, home: process.env.DSH_HOME ?? join(homedir(), '.dsh') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') args.profile = argv[++i]
    else if (argv[i] === '--home') args.home = argv[++i]
    else if (argv[i] === '--check') args.check = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const profileDir = join(args.home, 'profiles', args.profile)
/**
 * 从 lock 文本里取出本插件被钉住的 commit。
 *
 * pnpm 对 github 依赖有两种写法，**必须都认**——只认一种就会把「解析成功」
 * 误报成「lock 里没有钉点」：
 *   - SSH 形态：git+ssh://git@github.com/o/r.git#<commit>
 *   - tarball 形态：https://codeload.github.com/o/r/tar.gz/<commit>
 */
function pinnedCommitOf(text) {
  const match = /dsh-pixel-dashboard:[\s\S]{0,300}?version:\s*(\S+)/.exec(text)
  const spec = match === null ? '' : match[1]
  // SSH 形态：...#<commit>；tarball 形态：.../tar.gz/<commit>
  const viaHash = /#([0-9a-f]{40})/.exec(spec)
  if (viaHash !== null) return viaHash[1]
  const viaTar = /tar\.gz\/([0-9a-f]{40})/.exec(spec)
  return viaTar === null ? undefined : viaTar[1]
}


/** 跑一条命令并取输出；失败返回 undefined（调用方负责说明原因，绝不假装成功）。 */
function capture(command, cmdArgs, options = {}) {
  try {
    return execFileSync(command, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
  } catch {
    return undefined
  }
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

if (!existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}`)

// ── 1. 这个 profile 挂的是什么 ─────────────────────────────────────
const pkgPath = join(profileDir, 'package.json')
if (!existsSync(pkgPath)) fail(`${profileDir} 下没有 package.json，不像一个 profile`)
const profilePkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const spec = profilePkg.dependencies?.['dsh-pixel-dashboard']
if (spec === undefined) fail(`profile ${args.profile} 里没有 dsh-pixel-dashboard 依赖`)

const installedPkg = join(profileDir, 'node_modules', 'dsh-pixel-dashboard', 'package.json')
const installedVersion = existsSync(installedPkg)
  ? JSON.parse(readFileSync(installedPkg, 'utf8')).version
  : undefined

const lockPath = join(profileDir, 'pnpm-lock.yaml')
const lockText = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
// lock 里这一行的形状有两种（SSH 的 #<commit> 与 codeload 的 tar.gz/<commit>），
// 统一交给 pinnedCommitOf 解析——只认一种会把「解析成功」误报成「没有钉点」。
const lockedCommit = pinnedCommitOf(lockText)
// ── 2. 上游最新提交 ────────────────────────────────────────────────
// 用仓库自己的 origin（本机是 SSH；https 在这里不通）。
const remoteUrl = capture('git', ['remote', 'get-url', 'origin'], { cwd: root })
if (remoteUrl === undefined) fail('本仓库没有 origin remote，无法判断上游')
const lsRemote = capture('git', ['ls-remote', remoteUrl, 'refs/heads/main'])
if (lsRemote === undefined) {
  fail(
    '读不到上游（git ls-remote 失败）。\n'
    + '  网络不通时**不要**把它当成「已是最新」——先解决连通性再重试。',
  )
}
const upstreamCommit = lsRemote.split(/\s+/)[0] ?? ''

console.log(`profile     : ${args.profile}`)
console.log(`挂载方式    : ${spec}`)
console.log(`已装版本    : ${installedVersion ?? '(未安装)'}`)
console.log(`已装提交    : ${lockedCommit ?? '(lock 里没有 github 解析结果)'}`)
console.log(`上游 main   : ${upstreamCommit}`)

if (lockedCommit === undefined) {
  fail(
    'lock 里找不到本插件的 commit 钉点。若这个 profile 用的是 `link:`（指向本地工作树），\n'
    + '  那它的更新方式是 `git pull` + `node tools/build.mjs`，不需要也不应该走 pnpm。',
  )
}

// ── 3. 判定 ────────────────────────────────────────────────────────
if (lockedCommit === upstreamCommit) {
  console.log('\n✓ 已是最新：安装的提交就是上游 main。')
  console.log('  （宿主侧改动需重启 dsh 才生效；客户端半边刷新页面即可。）')
  process.exit(0)
}

console.log(`\n! 落后于上游：${lockedCommit.slice(0, 8)} → ${upstreamCommit.slice(0, 8)}`)
if (args.check) {
  console.log('  --check 模式：没有改动任何文件。去掉 --check 即可更新。')
  process.exit(0)
}

// ── 4. 更新 ────────────────────────────────────────────────────────
const pnpm = capture('pnpm', ['--version']) === undefined
  ? undefined
  : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
if (pnpm === undefined) fail('找不到 pnpm。桌面端的插件管理器用它，但当前 PATH 上没有。')

console.log(`\n$ ${pnpm} update dsh-pixel-dashboard   (cwd: ${profileDir})`)
const updated = capture(pnpm, ['update', 'dsh-pixel-dashboard'], { cwd: profileDir, stdio: ['ignore', 'pipe', 'inherit'] })
if (updated === undefined) fail('pnpm update 失败，profile 未被改动（或改动不完整）。')

// ── 5. 复核：绝不只信 pnpm 的退出码 ────────────────────────────────
const afterLock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
const afterCommit = pinnedCommitOf(afterLock)
const afterVersion = existsSync(installedPkg)
  ? JSON.parse(readFileSync(installedPkg, 'utf8')).version
  : undefined

console.log(`\n已装版本    : ${afterVersion ?? '(未知)'}`)
console.log(`已装提交    : ${afterCommit ?? '(未知)'}`)
if (afterCommit !== upstreamCommit) {
  fail(
    'pnpm 跑完了，但 lock 里的提交仍不是上游 main。\n'
    + '  可能原因：上游把该分支重写了、或 pnpm 用了缓存的解析结果（试 `pnpm update --force`）。',
  )
}
console.log('\n✓ 已更新到上游 main。接下来：重启 dsh（宿主侧改动只在启动时加载），再刷新页面。')
