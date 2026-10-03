/**
 * 卸载脚本的自检：**它绝不能删掉用量数据**。
 *
 * ## 为什么要单独一关
 *
 * `<home>/plugins/dsh-pixel-dashboard` 这个目录身兼两职：早期安装方式把插件代码放在这里，
 * 而用量账本与开关（lib/host.js 的 resolveLedgerPath、lib/prefs.js）也一直落在这里。
 * 早先 uninstall.mjs 是整目录 rmSync——于是「按体检提示清掉旧目录」会把**全部用量历史**
 * 一起删掉：没有报错、没有提示，历史没了就是没了，而账本正是这个插件唯一的长期数据。
 *
 * 这一关真的**在临时目录里跑一遍** uninstall.mjs，再断言账本与开关一字不差地还在。
 * 只查源码字符串是不够的：那种断言会在有人把删目录的写法绕个弯加回来时照样通过。
 * 用法: node tools/test-uninstall.mjs
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let passed = 0
/** 极简用例包装。 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}

/**
 * 造一份仿真的 DSH home：插件目录里既有代码，也有两种数据文件。
 * @param {string} tag - 用例标签，避免并发/重跑时互相污染。
 * @returns {{home:string,pluginDir:string,ledger:string,cwd:string}} 关键路径。
 */
function fixture(tag) {
  const home = join(tmpdir(), `dsh-pixel-uninstall-${process.pid}-${tag}`)
  rmSync(home, { recursive: true, force: true })
  const pluginDir = join(home, 'plugins', 'dsh-pixel-dashboard')
  mkdirSync(join(pluginDir, 'lib', 'client'), { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  // 代码：假装是装进来的那一份
  writeFileSync(join(pluginDir, 'package.json'), '{"name":"dsh-pixel-dashboard"}')
  writeFileSync(join(pluginDir, 'README.md'), '# readme')
  writeFileSync(join(pluginDir, 'lib', 'index.js'), 'export default {}')
  writeFileSync(join(pluginDir, 'lib', 'client', 'x.js'), '// client')
  // 数据：账本与开关。账本内容要能逐字比对，因此写死一段。
  const ledger = '{"k":"s1:1","t":1}\n{"k":"s1:2","t":2}\n'
  writeFileSync(join(pluginDir, 'usage-ledger.jsonl'), ledger)
  writeFileSync(join(pluginDir, 'balance-prefs.json'), '{"balanceEnabled":false}')
  // 补丁层：让卸载有行可删
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'),
    '- id: pixel-dashboard\n  name: \'dsh-pixel-dashboard\'\n')
  return { home, pluginDir, ledger }
}

/** 在给定 home 下跑一次卸载脚本。 */
function runUninstall(home, extra = []) {
  return execFileSync(process.execPath, [
    join(here, 'uninstall.mjs'), '--profile', 'web', '--home', home, ...extra,
  ], { cwd: root, encoding: 'utf8' })
}

console.log('uninstall：只删代码，不删数据')

check('dry-run 只报告、不落盘（代码与数据都还在）', () => {
  const { home, pluginDir, ledger } = fixture('dry')
  const out = runUninstall(home, ['--dry-run'])
  assert.ok(existsSync(join(pluginDir, 'lib', 'index.js')), 'dry-run 不得删代码')
  assert.ok(existsSync(join(pluginDir, 'package.json')), 'dry-run 不得删 package.json')
  assert.equal(readFileSync(join(pluginDir, 'usage-ledger.jsonl'), 'utf8'), ledger, 'dry-run 不得动账本')
  assert.ok(out.includes('usage-ledger.jsonl'), `dry-run 应报告账本会保留：${out}`)
  rmSync(home, { recursive: true, force: true })
})

check('真正卸载：代码删掉、账本与开关一字不差地保留', () => {
  const { home, pluginDir, ledger } = fixture('real')
  runUninstall(home)
  assert.equal(existsSync(join(pluginDir, 'lib')), false, 'lib/ 是代码，应被删除')
  assert.equal(existsSync(join(pluginDir, 'package.json')), false, 'package.json 是代码，应被删除')
  assert.equal(existsSync(join(pluginDir, 'README.md')), false, 'README.md 是代码，应被删除')
  // 两条**数据**断言：这是整关的核心
  assert.ok(existsSync(join(pluginDir, 'usage-ledger.jsonl')), '用量账本必须保留——它是唯一的长期数据')
  assert.ok(existsSync(join(pluginDir, 'balance-prefs.json')), '开关文件必须保留')
  assert.equal(
    readFileSync(join(pluginDir, 'usage-ledger.jsonl'), 'utf8'),
    ledger,
    '账本内容必须一字不差（删了目录就等于删了历史）',
  )
  rmSync(home, { recursive: true, force: true })
})

check('账本留在原路径：重装后仍能读到旧历史', () => {
  const { home, pluginDir } = fixture('reload')
  runUninstall(home)
  // 重装会把 lib/ 放回来；这里模拟「重装后宿主去读账本」这一步。
  const ledgerPath = join(pluginDir, 'usage-ledger.jsonl')
  assert.ok(existsSync(ledgerPath), '账本路径必须仍是默认的那一个，否则重装读不到历史')
  const records = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(records.length, 2, '旧记录应仍可解析')
  rmSync(home, { recursive: true, force: true })
})

check('历史版本目录也按同一规则清理（只删代码）', () => {
  const { home, pluginDir } = fixture('legacy')
  // 早期安装方式会留下带版本后缀的目录；它的数据同样不该动。
  const legacy = join(home, 'plugins', 'dsh-pixel-dashboard-1.0.0')
  mkdirSync(join(legacy, 'lib'), { recursive: true })
  writeFileSync(join(legacy, 'lib', 'index.js'), 'old')
  writeFileSync(join(legacy, 'usage-ledger.jsonl'), '{"k":"old:1","t":9}\n')
  runUninstall(home)
  assert.equal(existsSync(join(legacy, 'lib')), false, '历史目录里的代码也应清掉')
  assert.ok(existsSync(join(legacy, 'usage-ledger.jsonl')), '历史目录里的账本同样不得删除')
  assert.ok(existsSync(join(pluginDir, 'usage-ledger.jsonl')), '正式目录的账本也不得受影响')
  rmSync(home, { recursive: true, force: true })
})

console.log(`\n${passed} 项检查通过`)