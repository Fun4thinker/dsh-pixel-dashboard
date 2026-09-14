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
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 默认的源码检出位置。 */
const DEFAULT_CHECKOUT = 'D:\\deepseek-harness'

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

  const checkout = process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT
  const binTs = join(checkout, 'apps', 'cli', 'src', 'bin.ts')
  if (!existsSync(binTs)) return undefined

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
