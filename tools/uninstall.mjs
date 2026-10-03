/**
 * 卸载脚本：撤销 install.mjs 的全部改动——删掉本插件的 loader 行与所有版本的插件目录。
 * 写入前同样过 YAML 校验，避免留下坏掉的补丁层。
 *
 * ## 只删代码，不删数据
 *
 * <home>/plugins/dsh-pixel-dashboard 这个目录**身兼两职**：早期安装方式把插件代码放在这里，
 * 而用量账本与开关（lib/host.js 的 resolveLedgerPath、lib/prefs.js 的 resolvePrefsPath）也
 * 一直落在这里。早先的写法是整目录 rmSync——于是「按体检提示清掉旧目录」会把**全部用量
 * 历史**一起删掉，而且没有任何提示：历史没了就是没了，账本本来就是这个插件唯一的长期数据。
 *
 * 因此这里改成**只删本包安装进去的代码文件**（见 PACKAGE_PAYLOAD），其余一律原样保留，
 * 并把留下来的东西打出来。数据文件必须留在原地：换路径会让重装后的插件读不到旧历史。
 * 用法: node tools/uninstall.mjs [--profile <name>] [--home <DSH_HOME>] [--keep-files] [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPatchLayer, dropFamilyRows } from './patch-layer.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const args = { profile: undefined, home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), keepFiles: false, dryRun: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--profile') args.profile = argv[++i]
  else if (argv[i] === '--home') args.home = argv[++i]
  else if (argv[i] === '--keep-files') args.keepFiles = true
  else if (argv[i] === '--dry-run') args.dryRun = true
}

/**
 * 包安装进去的代码负载：卸载时只该删这些。
 *
 * 这是一份**白名单**而不是黑名单：新版本若多出一个数据文件（比如将来又添一种本地状态），
 * 忘了往黑名单里加就会把它删掉；而白名单的失败方向是「少删一个代码文件」，
 * 那只是留下几个字节，远好过删掉用量历史。`lib/` 整个目录都是代码，可以放心删。
 */
const PACKAGE_PAYLOAD = ['lib', 'package.json', 'README.md']

/**
 * 删掉一个插件目录里**属于包的代码**，保留其中的数据文件。
 *
 * 目录若只剩数据文件就不删目录本身：账本与开关就住在里面，删了目录等于删了数据。
 *
 * `dryRun` 只分类不落盘——预览与真删共用同一段分类逻辑，两套写法必然漂移。
 * @param {string} dir - 插件目录绝对路径。
 * @param {boolean} [dryRun] - 为真时只报告、不删。
 * @returns {{removed:string[],kept:string[]}} 删掉的（或将删的）与保留下来的条目名。
 */
function removeCodeOnly(dir, dryRun = false) {
  const removed = []
  const kept = []
  for (const entry of readdirSync(dir)) {
    const target = join(dir, entry)
    if (PACKAGE_PAYLOAD.includes(entry)) {
      if (!dryRun) rmSync(target, { recursive: true, force: true })
      removed.push(entry)
    } else {
      // 目录形式的保留项标出它是不是目录：账本是一个文件，将来可能有别的目录
      kept.push(statSync(target).isDirectory() ? `${entry}/` : entry)
    }
  }
  return { removed, kept }
}

const home = resolve(args.home)
const patchFile = args.profile === undefined
  ? join(home, 'cordis.patch.yml')
  : join(home, 'profiles', args.profile, 'cordis.patch.yml')
const pluginsDir = join(home, 'plugins')

if (existsSync(patchFile)) {
  const raw = readFileSync(patchFile, 'utf8')
  const cleaned = dropFamilyRows(raw)
  // 清干净后若什么都不剩，就还原成 Loader 期望的空序列，保证补丁层依然合法。
  const next = cleaned === '' ? '[]\n' : `${cleaned}\n`
  try {
    assertPatchLayer(next, patchFile)
  } catch (error) {
    console.error(`补丁层校验失败，已中止（未写入任何内容）：\n  ${error.message}`)
    process.exit(1)
  }
  if (next === raw) {
    console.log(`${patchFile} 里没有本插件的行，无需改动。`)
  } else if (args.dryRun) {
    console.log('--- 将写入 cordis.patch.yml ---')
    console.log(next)
  } else {
    writeFileSync(patchFile, next, 'utf8')
    console.log(`已从 ${patchFile} 移除本插件的 loader 行与说明注释`)
  }
} else {
  console.log(`未找到 ${patchFile}，跳过补丁清理。`)
}

if (!args.keepFiles && existsSync(pluginsDir)) {
  const prefix = `${pkg.name}-`
  for (const name of readdirSync(pluginsDir)) {
    if (name !== pkg.name && !name.startsWith(prefix)) continue
    const dir = join(pluginsDir, name)
    if (args.dryRun) {
      const { removed, kept } = removeCodeOnly(dir, true)
      console.log(`--- 将清理 ${dir} ---`)
      console.log(`  删除代码：${removed.join('、') || '（无）'}`)
      console.log(`  保留数据：${kept.join('、') || '（无）'}`)
      continue
    }
    const { removed, kept } = removeCodeOnly(dir)
    console.log(`已清理插件代码 ${dir}（删除 ${removed.join('、') || '无'}）`)
    // 数据文件必须点名：用户据此知道用量历史还在、下次重装会接着用。
    if (kept.length > 0) {
      console.log(`  保留：${kept.join('、')}（用量账本与开关住在这里，卸载不删数据）`)
    }
  }
}

console.log('刷新浏览器页面即可恢复原界面。')
console.log('（用量账本与开关仍留在原处；重装后会自动接着用。）')
