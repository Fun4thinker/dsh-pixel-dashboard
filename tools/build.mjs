/**
 * 构建可发布的插件包：把 `src/` 装配成标准的 npm 包根 `lib/`。
 *
 * 产出结构（`package.json` 的 main / exports / dsh.client 都指向这里）：
 *
 *   lib/index.js     装载入口。用「宿主源码哈希」做动态 import 的版本号，
 *                    于是改完实现重新构建即可热更新；哈希自动派生，
 *                    不存在「忘了加版本号」这种失败模式。
 *   lib/host.js      宿主半边（入口 import 的实现）
 *   lib/pricing.js   时段与价目（纯函数）
 *   lib/ledger.js    本机用量账本
 *   lib/client.js    浏览器半边产物（window.__ModuleLoader__ 容器格式）
 *
 * 仓库根就是发布包本身（单包形态），因此产物直接落在根的 lib/。
 * 客户端源码也一并放进 lib/client/，方便线上排查时对照。
 *
 * 用法: node tools/build.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const srcDir = join(root, 'src')
// 仓库根**就是**发布包（单包形态，见根 cordis.patch.yml 的说明），
// 因此产物直接落在根的 lib/ 下。
const outDir = join(root, 'lib')

/** 宿主侧的模块：改动这些会影响实现版本号。 */
const HOST_SOURCES = ['host.js', 'pricing.js', 'ledger.js', 'balance.js', 'plans.js', 'prefs.js']

/**
 * 由宿主源码内容算出的短哈希，用作实现版本号。
 * @returns {string} 8 位十六进制。
 */
function sourceHash() {
  const hash = createHash('sha256')
  for (const file of HOST_SOURCES) hash.update(readFileSync(join(srcDir, file)))
  return hash.digest('hex').slice(0, 8)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// 1) 宿主侧源码与客户端源码照抄
for (const file of HOST_SOURCES) cpSync(join(srcDir, file), join(outDir, file))
cpSync(join(srcDir, 'client'), join(outDir, 'client'), { recursive: true })

// 1b) LICENSE 只维护仓库根这一份，而它是发布包的一部分（package.json 的 files
//     里声明了它）。少了它 npm 只是静默跳过、不报错，发布出去就没有许可证信息。
if (!existsSync(join(root, 'LICENSE'))) throw new Error('仓库根缺少 LICENSE，无法随包发布')

// 2) 生成装载入口
const version = sourceHash()
writeFileSync(
  join(outDir, 'index.js'),
  `/**
 * dsh-pixel-dashboard 装载入口（由 tools/build.mjs 生成，勿手改）。
 *
 * 实现版本：${version}（宿主源码哈希）
 * 带版本号动态 import 是为了绕开「Loader 不重新 import 同一 specifier」，
 * 因此改完 src/host.js 重新构建即可热更新。
 * @module dsh-pixel-dashboard
 */
const { default: plugin } = await import('./host.js?v=${version}')

export default plugin
`,
  'utf8',
)

// 3) 客户端打包到 lib/client.js
execFileSync(process.execPath, [join(here, 'build-client.mjs')], { stdio: 'inherit' })

// 4) 把构建版本注入客户端源码与产物，供「宿主/页面版本不一致」的诊断使用
/** 替换文件里的版本占位符。 */
function injectVersion(file, required) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('__DSH_PIXEL_IMPL_VERSION__')) {
    if (required) throw new Error(`${file} 里没有版本占位符，无法绑定版本`)
    return
  }
  writeFileSync(file, text.replaceAll('__DSH_PIXEL_IMPL_VERSION__', version), 'utf8')
}
injectVersion(join(outDir, 'host.js'), true)
for (const file of readdirSync(join(outDir, 'client'))) {
  if (file.endsWith('.js')) injectVersion(join(outDir, 'client', file), file === 'usage.js')
}
injectVersion(join(outDir, 'client.js'), true)

// 5) 校验包根清单：仓库根就是发布包，产物只是它的 lib/。在 lib/ 里再放一份
//    package.json 会形成嵌套包根，让发布内容与解析路径都变得含糊；
//    这里只做一致性检查。
//
//    这几条不是形式主义：`github:` 直装与 npm 直装都直接加载 lib/，任何一条对不上
//    都会让插件在浏览器里静默不注册。尤其 dsh.bundle 缺了的话，`dsh plugin add`
//    只会把它当普通库装进 profile，**不进 dsh.profile.bundles，插件永不激活**。
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.main !== './lib/index.js') {
  throw new Error(`package.json 的 main 应为 ./lib/index.js，实际 ${manifest.main}`)
}
if (manifest.exports?.['./client'] !== './lib/client.js') {
  throw new Error(`package.json 的 exports["./client"] 应指向 ./lib/client.js`)
}
if (manifest.dsh?.client?.platform !== 'web') {
  throw new Error('package.json 必须声明 dsh.client.platform = "web"，否则浏览器半边不会被加载')
}
if (manifest.dsh?.bundle?.patch === undefined) {
  throw new Error('package.json 必须声明 dsh.bundle.patch——否则 dsh plugin add 不会把本包装进 dsh.profile.bundles，插件永不激活')
}
if (!Array.isArray(manifest.files) || !manifest.files.includes('lib')) {
  throw new Error('package.json 的 files 必须包含 lib，否则发布时产物会被漏掉')
}
if (!existsSync(join(root, 'cordis.patch.yml'))) {
  throw new Error('仓库根缺少 cordis.patch.yml（dsh.bundle.patch 指向它）')
}
// patch 的行名必须是**包名**，否则 profile 的 node_modules 解析不到
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`'${manifest.name}'`)) {
  throw new Error(`cordis.patch.yml 里没有以包名 '${manifest.name}' 引用的行，profile 会解析失败`)
}

console.log(`\n已生成 lib/（包 ${manifest.name}@${manifest.version}，实现版本 ${version}）`)
