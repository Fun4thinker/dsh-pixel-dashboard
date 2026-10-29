#!/usr/bin/env node
/**
 * 发布脚本：把「改版本号 → 构建 → 测试 → 预检 → 打包 → 发布 → 打 tag」这一串
 * 手工步骤收成一条命令，并在每一步失败时**停下**，不留下半发布状态。
 *
 * 为什么需要它：`npm publish` 自己会跑 `prepublishOnly`（构建 + 测试 + 预检），
 * 但那三步漏了两件事故率高的事：
 *   1) 版本号忘了改 → npm 直接以 E403 "cannot publish over" 拒绝，构建白跑；
 *   2) 发布成功但忘了 `git tag` → 下一个版本无从对齐 changelog 与源码。
 * 两者都是「已经跑完几分钟才失败」，所以先在这里挡住。
 *
 * 用法：
 *   node tools/release.mjs patch            # 2.12.2 → 2.12.3
 *   node tools/release.mjs minor            # 2.12.2 → 2.13.0
 *   node tools/release.mjs major            # 2.12.2 → 3.0.0
 *   node tools/release.mjs 2.13.0           # 指定版本
 *   node tools/release.mjs patch --dry-run  # 只演一遍，不写文件不发布
 *   node tools/release.mjs patch --tag-only # 已发布，只补 tag
 *
 * @module tools/release
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const dryRun = flags.has('--dry-run')
const tagOnly = flags.has('--tag-only')

/** 跑一条命令并把输出转给终端；失败直接抛，让进程以非零退出。 */
function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
}

/** 静默跑一条命令，只要输出。 */
function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  }).trim()
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** semver 的递增，只支持本仓库用到的三种。 */
function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (m === null) fail(`当前版本 ${version} 不是 x.y.z 形式，无法自动递增；请直接传目标版本号`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version

if (positional.length === 0 && !tagOnly) {
  fail('用法: node tools/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--tag-only]')
}

// ── 1. 决定目标版本 ────────────────────────────────────────────────
let target = current
if (!tagOnly) {
  const spec = positional[0]
  if (/^\d+\.\d+\.\d+$/.test(spec)) {
    target = spec
  } else if (['patch', 'minor', 'major'].includes(spec)) {
    target = bump(current, spec)
  } else {
    fail(`无法理解的版本参数 ${JSON.stringify(spec)}；用 patch / minor / major 或 x.y.z`)
  }
  if (target === current) fail(`目标版本与当前版本相同（${current}）`)
}

// ── 2. 发布前检查：这个版本是不是已经在 npm 上了 ──────────────────
// 跳过它的唯一理由是 tag-only（那时版本本来就已经发布）。
if (!tagOnly) {
  // 包还不存在时 `npm view` 以 E404 退出，这是**正常**的首次发布路径，
  // 不是错误。把 stderr 收进变量，免得一屏 404 吓到人。
  let published = ''
  try {
    published = capture('npm', ['view', pkg.name, 'versions', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    console.log(`\n… ${pkg.name} 尚未发布过，这是首次发布`)
    published = '[]'
  }
  let versions = []
  try {
    versions = JSON.parse(published)
  } catch {
    versions = []
  }
  if (Array.isArray(versions) && versions.includes(target)) {
    fail(`${pkg.name}@${target} 已经发布过了；改一个版本号再试`)
  }
}

// ── 3. 工作区必须是干净的，否则构建产物会混进无关改动 ─────────────
let dirty = ''
let isRepo = true
try {
  dirty = capture('git', ['status', '--porcelain'])
} catch {
  isRepo = false
}
if (!isRepo) {
  fail('当前目录不是 git 仓库；发布脚本要打 tag，请在仓库根运行')
}
if (dirty !== '' && !dryRun) {
  fail(`工作区有未提交的改动：\n${dirty}\n\n先提交或 stash，再发布——否则「哪个提交对应哪个版本」就说不清了`)
}
// 打 tag 需要作者身份；没有的话会在「已经发布成功之后」才失败，
// 那时版本号已经占用、没法回头，所以提前问 git 要一次。
try {
  capture('git', ['var', 'GIT_COMMITTER_IDENT'])
} catch {
  fail('git 没有配置提交身份，发布会在最后打 tag 时失败。先运行：\ngit config user.name "你的名字"\ngit config user.email "你的邮箱"')
}

// ── 4. 写版本号（构建脚本会把实现版本注入产物） ───────────────────
if (!tagOnly) {
  console.log(`\n版本: ${current} → ${target}`)
  if (!dryRun) {
    pkg.version = target
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
}

// ── 5. 构建 → 测试 → 预检（与 prepublishOnly 同一套，但提前跑） ───
// prepublishOnly 也会跑一遍；这里先跑是为了在动工作区之前就发现问题。
// DSH_HOME 让 patch-layer 能找到随 DSH 安装的 js-yaml。
const env = { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh') }
if (!tagOnly) {
  run('node', ['tools/build.mjs'], { env })
  run('node', ['tools/test.mjs'], { env })
  run('node', ['tools/preflight.mjs'], { env })
}

// ── 6. 发布 ────────────────────────────────────────────────────────
if (dryRun) {
  console.log('\n[dry-run] 到此为止：没有写 package.json，也没有发布。')
  console.log(`[dry-run] 真正发布会在 npm 上出现 ${pkg.name}@${target}`)
  process.exit(0)
}

if (!tagOnly) {
  // 先提交再发布：tag 必须指向「含新版本号与对应产物」的那个提交。
  // 顺序颠倒过一版，结果是 tag 打在递增之前的提交上——tag 说 v2.12.3，
  // 里面 package.json 还写着 2.12.2，事后对不上账。
  run('git', ['add', 'package.json', 'lib'])
  run('git', ['commit', '-m', `release: ${pkg.name}@${target}`])
  // 发布放在提交之后：万一提交失败，npm 上还没出现这个版本，仍可重来。
  // npm publish 会再跑一遍 prepublishOnly（构建+测试+预检），是最后一道闸。
  run('npm', ['publish', '--access', 'public'])
}

// ── 7. 打 tag 并推送（tag 名带 v 前缀，与 changelog 对齐） ────────
const tag = `v${target}`
try {
  capture('git', ['rev-parse', '--verify', tag])
  console.log(`\n… tag ${tag} 已存在，跳过创建`)
} catch {
  run('git', ['tag', '-a', tag, '-m', `${pkg.name} ${tag}`])
}

console.log(`\n✓ 已发布 ${pkg.name}@${target}`)
console.log('\n接下来：')
console.log(`  git push && git push origin ${tag}`)
console.log('  在 DSH 桌面版「设置 → 插件」里卸载重装，或在插件市场点更新')
console.log('\n注意：pnpm 的 minimumReleaseAge 可能让刚发布的版本在一段时间内装不上；')
console.log('     桌面端会提示「新发布版本的风险」，那时用卸载后安装精确版本 name@x.y.z，')
console.log(`     或者等过了发布冷却期（默认策略）再装。`)
