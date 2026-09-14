/**
 * 一键部署：在任意一台机器上把插件装好。
 *
 * 换电脑时不需要手工拷 `~/.dsh` 下的任何东西——那份目录是机器本地的。真正要带走的
 * 只有这个仓库目录（或它的一个压缩包），然后在新机器上跑这一条命令：
 *
 *   node tools/bootstrap.mjs
 *
 * 它会依次：检查前置条件 → 构建产物 → 部署到本机 DSH → 体检并打印结论。
 * 全程幂等，重复跑不会留下重复的 loader 行或多余目录。
 *
 * 用法: node tools/bootstrap.mjs [--home <DSH_HOME>] [--profile <name>] [--skip-doctor]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: undefined, skipDoctor: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') args.home = argv[++i]
    else if (argv[i] === '--profile') args.profile = argv[++i]
    else if (argv[i] === '--skip-doctor') args.skipDoctor = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home)

/** 按顺序执行一个子脚本，失败即中止。 */
function run(label, script, extra = []) {
  process.stdout.write(`\n▶ ${label}\n`)
  try {
    execFileSync(process.execPath, [join(here, script), ...extra], { stdio: 'inherit' })
  } catch {
    console.error(`\n✗ 步骤失败：${label}`)
    process.exit(1)
  }
}

console.log('dsh-pixel-dashboard 一键部署')
console.log(`  仓库目录：${root}`)
console.log(`  DSH_HOME：${home}`)

// ── 前置检查：把「装不上」的原因提前说清楚，别等构建到一半才报错 ──
const problems = []
const major = Number(process.versions.node.split('.')[0])
if (!Number.isFinite(major) || major < 18) {
  problems.push(`Node 版本过低（当前 ${process.versions.node}），需要 Node 18 以上`)
}
if (!existsSync(join(root, 'package.json'))) {
  problems.push(`仓库目录不完整，找不到 package.json：${root}`)
}
if (!existsSync(home)) {
  problems.push(`找不到 DSH 主目录：${home}。请先安装并至少启动过一次 DSH，或用 --home 指定`)
} else if (!existsSync(join(home, 'profiles'))) {
  problems.push(`${home} 下没有 profiles 目录，看起来不是有效的 DSH 主目录`)
}
if (args.profile !== undefined && !existsSync(join(home, 'profiles', args.profile))) {
  problems.push(`找不到 profile：${join(home, 'profiles', args.profile)}`)
}
// 装了 DSH 的另一台机器上，agent-presets 一定存在；缺失通常说明 DSH 还没跑起来过
const hasDshCli = existsSync(join(root, '..', 'deepseek-harness'))
  || existsSync(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'))
if (!hasDshCli) {
  problems.push('没检测到 DSH 安装（既没有 profiles/node_modules/@deepseek-ai/dsh，也没有相邻的 deepseek-harness 检出）')
}
if (problems.length > 0) {
  console.error('\n✗ 前置检查未通过：')
  for (const problem of problems) console.error(`   - ${problem}`)
  console.error('\n修好后重新运行：node tools/bootstrap.mjs')
  process.exit(1)
}
console.log('\n✓ 前置检查通过')

// ── 构建与部署 ────────────────────────────────────────────────
run('构建产物（tools/build-deploy.mjs）', 'build-deploy.mjs')

const installArgs = ['--home', home]
if (args.profile !== undefined) installArgs.push('--profile', args.profile)
// 部署前先在沙箱里跑一遍自检，避免把坏产物推上去
run('自检（tools/test.mjs）', 'test.mjs')
run('自检补丁层（tools/test-patch-layer.mjs）', 'test-patch-layer.mjs')
run('宿主预检（tools/preflight.mjs）', 'preflight.mjs')
run('部署到本机（tools/install.mjs）', 'install.mjs', installArgs)

if (!args.skipDoctor) {
  const doctorArgs = ['--home', home]
  if (args.profile !== undefined) doctorArgs.push('--profile', args.profile)
  run('体检（tools/doctor.mjs）', 'doctor.mjs', doctorArgs)
}

// ── 顺手报一下本机原先有多少用量历史 ───────────────────────────
const sessionsRoot = join(home, 'sessions')
if (existsSync(sessionsRoot)) {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) {
        files += 1
        try {
          bytes += readFileSync(full).length
        } catch {
          // 读不到就只计数
        }
      }
    }
  }
  try {
    walk(sessionsRoot)
  } catch {
    // 目录结构异常不影响部署结果
  }
  console.log(`\n本机会话日志：${files} 个文件、${(bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log('首次打开看板时，会对这些历史做一次扫描并写入本机用量账本。')
}

console.log('\n完成。刷新浏览器页面即可使用。')
console.log('若界面没变化，重启一次 dsh web（宿主侧改动必须重启才生效）。')
