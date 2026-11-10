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
const runner = pnpmRunner()
if (runner === undefined) {
  fail(
    '找不到 pnpm（Windows 上试过 `where.exe pnpm`，其余平台试过 `pnpm --version`）。\n'
    + '  桌面端的插件管理器用它，但当前 PATH 上确实没有可执行的 pnpm。',
  )
}

/**
 * 找到「怎么调用 pnpm」。
 *
 * ## Windows 上 npm 全局安装的 pnpm 没有 `.exe`
 *
 * 它只有 `pnpm.CMD` / `pnpm.ps1` / 一个 git-bash 用的无后缀垫片。而 Node 的
 * `execFileSync` **两边都不认**：
 *   - `execFileSync('pnpm')` 不按 PATHEXT 补后缀 → `ENOENT`；
 *   - `execFileSync('pnpm.cmd')` 不能直接 spawn `.cmd` → `EINVAL`。
 *
 * 早先的写法「先试 `pnpm`，再退回 `pnpm.cmd`」因此在**每台标准 Windows 机器上都必定
 * 失败**，并且把原因误报成「找不到 pnpm……当前 PATH 上没有」——这句话是**错的**
 * （它就在 PATH 上），错误归因会把用户支去重装 pnpm，而他重装十次也不会好。
 *
 * 所以先 `where.exe pnpm` 取真实路径：`.exe` 直接调，`.cmd` 交给 `cmd.exe`。
 * 刻意**不用** `shell: true`：那会触发 DEP0190（参数只拼接、不转义），而本脚本的
 * 参数是固定字面量；真要让 shell 介入，就给一条明确的命令，而不是放任它重切参数。
 * POSIX 上仍然是裸 `pnpm`。
 * @returns {{command:string,prefix:string[]}|undefined} 调用方式；undefined = 真的没有。
 */
function pnpmRunner() {
  if (process.platform !== 'win32') {
    return capture('pnpm', ['--version']) === undefined ? undefined : { command: 'pnpm', prefix: [] }
  }
  const found = capture('where.exe', ['pnpm'])
  if (found === undefined) return undefined
  const paths = found.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const exe = paths.find((item) => /\.exe$/i.test(item))
  if (exe !== undefined) return { command: exe, prefix: [] }
  const shim = paths.find((item) => /\.cmd$/i.test(item))
  if (shim === undefined) return undefined
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return { command: comspec, prefix: ['/d', '/s', '/c', shim] }
}

const how = [runner.command, ...runner.prefix].join(' ')
console.log(`\n$ ${how} update dsh-pixel-dashboard   (cwd: ${profileDir})`)
const updated = capture(runner.command, [...runner.prefix, 'update', 'dsh-pixel-dashboard'], {
  cwd: profileDir,
  stdio: ['ignore', 'pipe', 'inherit'],
})
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
