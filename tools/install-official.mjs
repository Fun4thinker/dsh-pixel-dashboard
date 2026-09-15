/**
 * 用官方方式安装：`dsh plugin --profile <profile> add <包>`。
 *
 * 「官方方式」在这里是字面意思——本仓库根就是一个声明了 `dsh.bundle.patch` 的包，
 * 由 dsh CLI 转发给 pnpm 安装，并自动把它加进该 profile 的 `dsh.profile.bundles`
 * 层列表。因此卸载是 `dsh plugin --profile <profile> remove dsh-pixel-dashboard`，
 * 不残留补丁行；dsh 升级后重新启动即加载新版本，不需要重新部署文件。
 *
 * 单包形态的关键好处：**一条 `add` 就够**。早先拆成「插件包 + 组合包」两个包时，
 * 命令行上只能给一个规格，而组合包 `dependencies` 里声明的插件包若不在 npm 上，
 * pnpm 会卡在解析它；指向仓库根又会装到没有 `dsh.bundle` 的开发清单。
 *
 * 两条安装路径：
 *   1) **本仓库源码**（默认）：直接 add 仓库根目录，pnpm 建 `link:` 软链。
 *      改完 `src/` 重新构建后，**客户端半边刷新页面即可**（浏览器产物被按需重读），
 *      而**宿主半边必须重启 dsh**——宿主模块只在启动时加载，且 dsh-base 默认
 *      关掉了 HMR 的模块重载（`hmr` 行 `disabled: true`），`patchReload: live`
 *      只重挂配置层、不会重新 import 宿主实现。
 *   2) **已发布 / GitHub**：`--spec github:Fun4thinker/dsh-pixel-dashboard`
 *      或 `--npm dsh-pixel-dashboard`。
 *
 * 用法:
 *   node tools/install-official.mjs --profile web
 *   node tools/install-official.mjs --profile web --spec github:Fun4thinker/dsh-pixel-dashboard
 *   node tools/install-official.mjs --profile web --npm
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

if (!existsSync(join(root, 'cordis.patch.yml')) || !existsSync(join(root, 'package.json'))) {
  console.error(`仓库根不像一个插件包（缺 cordis.patch.yml 或 package.json）：${root}`)
  process.exit(1)
}
// 产物必须已构建：GitHub / npm 直装都不会跑构建，而 DSH 加载的正是 lib/client.js。
// 本地源码安装尤其要先构建，否则装上一份过期的浏览器半边。
if (!existsSync(join(root, 'lib', 'client.js'))) {
  console.error('根目录缺少 lib/client.js，请先运行：node tools/build.mjs')
  process.exit(1)
}

// 默认装本地源码根；给了 --spec / --npm 才走已发布路径。
const spec = args.spec ?? (args.npm ? 'dsh-pixel-dashboard' : root)
const command = ['plugin', '--profile', args.profile, 'add', spec]
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
