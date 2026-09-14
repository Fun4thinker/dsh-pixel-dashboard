/**
 * 用官方方式安装：`dsh plugin --profile <profile> add <组合包>`。
 *
 * 「官方方式」在这里是字面意思——插件做成 profile 组合包（声明 `dsh.bundle.patch`），
 * 由 dsh CLI 转发给 pnpm 安装，并自动把它加进该 profile 的 `dsh.profile.bundles`
 * 层列表。因此卸载是 `dsh plugin --profile <profile> remove <包名>`，不残留补丁行；
 * dsh 升级后重新启动即加载新版本，不需要重新部署文件。
 *
 * 两条安装路径：
 *   1) **已发布到 npm**（或 `github:user/repo`）：只装组合包即可。组合包在
 *      `dependencies` 里声明插件包，pnpm 会一并装上；patch 里的
 *      `name: 'dsh-pixel-dashboard'` 由 profile 的 node_modules 解析。
 *   2) **本地源码验证**：pnpm 对本地目录用 `link:` 规格，而 **link: 不解析目标包的
 *      dependencies**，插件包不会被装上，patch 的行会解析失败。这时必须把插件包
 *      也作为 profile 的直接依赖装一次。本脚本自动处理这一点。
 *
 * 用法:
 *   node tools/install-official.mjs --profile web           # 本地源码（两个包都装）
 *   node tools/install-official.mjs --profile web --npm     # 已发布，只装组合包
 *   node tools/install-official.mjs --profile web --spec github:me/repo
 *   node tools/install-official.mjs --profile web --dry-run
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDsh, runDsh } from './dsh-cli.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = {
    profile: 'web',
    spec: undefined,
    home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    dryRun: false,
    npm: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') args.profile = argv[++i]
    else if (argv[i] === '--spec') args.spec = argv[++i]
    else if (argv[i] === '--home') args.home = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--npm') args.npm = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const home = resolve(args.home)
const bundleDir = join(root, 'packages', 'bundle')
const pluginDir = join(root, 'packages', 'plugin')

if (!existsSync(join(bundleDir, 'cordis.patch.yml'))) {
  console.error(`找不到组合包：${bundleDir}`)
  process.exit(1)
}
if (!existsSync(join(pluginDir, 'package.json'))) {
  console.error(`找不到插件包：${pluginDir}`)
  process.exit(1)
}

// 本地源码路径下组合包与插件包都要装：pnpm 对本地目录用 link: 规格，
// 而 link: 不解析目标包的 dependencies，插件包不会被装上，patch 的行会解析失败。
// 判断写成「显式给了 --spec 或 --npm 才走已发布路径」，避免 undefined 击穿条件。
const publishedPath = args.spec !== undefined || args.npm === true
const specs = publishedPath ? [args.spec ?? 'dsh-pixel-dashboard-bundle'] : [bundleDir, pluginDir]

const command = ['plugin', '--profile', args.profile, 'add', ...specs]
const resolved = resolveDsh(command, root)
if (resolved === undefined) {
  console.error('找不到可用的 dsh 命令。请手动执行：')
  console.error(`  dsh ${command.join(' ')}`)
  console.error('（或设置 DSH_CHECKOUT 指向源码检出后重试）')
  process.exit(1)
}

console.log(`通过${resolved.via}执行：`)
console.log(`  dsh ${command.join(' ')}`)
if (args.dryRun) process.exit(0)

if (runDsh(resolved) !== 0) {
  console.error('\ndsh 安装失败，请查看上面的 pnpm 输出。')
  process.exit(1)
}

console.log('\n安装完成。核对：')
console.log(`  node tools/doctor.mjs --profile ${args.profile}`)
console.log('然后重启一次 dsh（宿主侧改动需要重启），再刷新浏览器页面。')
