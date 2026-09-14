/**
 * 卸载脚本：撤销 install.mjs 的全部改动——删掉本插件的 loader 行与所有版本的插件目录。
 * 写入前同样过 YAML 校验，避免留下坏掉的补丁层。
 * 用法: node tools/uninstall.mjs [--profile <name>] [--home <DSH_HOME>] [--keep-files] [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

if (!args.keepFiles && !args.dryRun && existsSync(pluginsDir)) {
  const prefix = `${pkg.name}-`
  for (const name of readdirSync(pluginsDir)) {
    if (name === pkg.name || name.startsWith(prefix)) {
      rmSync(join(pluginsDir, name), { recursive: true, force: true })
      console.log(`已删除插件包 ${join(pluginsDir, name)}`)
    }
  }
}

console.log('刷新浏览器页面即可恢复原界面。')
