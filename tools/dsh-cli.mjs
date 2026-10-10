/**
 * 定位可用的 `dsh` 命令。
 *
 * 两种部署形态都要支持，否则脚本在某台机器上会直接跑不起来：
 *   1) 全局安装：PATH 上有 `dsh`，直接用它；
 *   2) 源码检出：本机是在检出目录里用 tsx 跑 `apps/cli/src/bin.ts`，
 *      没有全局命令。这时必须显式给出 tsx 的**绝对 file:// URL**——
 *      裸名 `tsx/esm` 以 cwd 为基准解析，而调用方在插件仓库里跑（没有 node_modules）；
 *      而且 cwd 必须落在检出目录，否则 cordis 的导出解析会失败
 *      （表现为 `does not provide an export named 'FiberState'`）。
 * @module tools/dsh-cli
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 默认的源码检出位置候选（按顺序探测，取第一个真的有 CLI 入口的）。 */
const CHECKOUT_CANDIDATES = [
  process.env.DSH_CHECKOUT,
  'D:\\deepseek-harness',
  'E:\\deepseek-harness',
  'C:\\deepseek-harness',
].filter((value) => typeof value === 'string' && value.trim() !== '')

/**
 * 找一个可用的源码检出。
 *
 * **不能写死一个路径。** 早先只认 `D:\deepseek-harness`，而那台机器上检出其实在
 * `E:\deepseek-harness`：`dsh` 又不在 PATH 上，两条路同时落空，于是
 * `install-official.mjs` 直接报「找不到可用的 dsh 命令」——恰好是用户最需要它
 * 的那一刻。这里改成逐个探测**存在 CLI 入口**的目录。
 * @returns {string|undefined} 检出根目录。
 */
function findCheckout() {
  for (const candidate of CHECKOUT_CANDIDATES) {
    const dir = resolve(candidate)
    if (existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))) return dir
  }
  return undefined
}

/**
 * 解析 dsh 调用方式。
 * @param {string[]} extraArgs - 传给 dsh 的参数（例如 ['plugin','--profile','web','add','x']）。
 * @param {string} fallbackCwd - 用 PATH 上的 dsh 时的工作目录。
 * @returns {{cmd: string, argv: string[], cwd: string, via: string}|undefined} 调用方式；找不到时为 undefined。
 */
export function resolveDsh(extraArgs, fallbackCwd) {
  const probe = spawnSync('dsh', ['--version'], {
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
  if (probe.error === undefined && probe.status === 0) {
    return { cmd: 'dsh', argv: extraArgs, cwd: fallbackCwd, via: 'PATH 上的 dsh' }
  }

  const checkout = findCheckout()
  if (checkout === undefined) return undefined
  const binTs = join(checkout, 'apps', 'cli', 'src', 'bin.ts')

  const store = join(checkout, 'node_modules', '.pnpm')
  const packageDir = existsSync(store)
    ? readdirSync(store).find((name) => name.startsWith('tsx@'))
    : undefined
  const loader = packageDir === undefined
    ? 'tsx/esm'
    : pathToFileURL(join(store, packageDir, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href

  return {
    cmd: process.execPath,
    argv: ['--import', loader, binTs, ...extraArgs],
    // cwd 必须在检出目录：tsx 与 cordis 都按 cwd 解析
    cwd: checkout,
    via: `源码检出（${binTs}）`,
  }
}

/**
 * 执行 dsh 并透传标准输入输出。
 * @param {{cmd: string, argv: string[], cwd: string}} resolved - resolveDsh 的结果。
 * @returns {number} 退出码。
 */
export function runDsh(resolved) {
  const result = spawnSync(resolved.cmd, resolved.argv, {
    stdio: 'inherit',
    shell: process.platform === 'win32' ? resolved.cmd === 'dsh' : false,
    cwd: resolved.cwd,
  })
  if (result.error !== undefined) {
    console.error(`无法执行 dsh：${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}
