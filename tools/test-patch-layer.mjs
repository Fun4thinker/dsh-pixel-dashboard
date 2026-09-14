/**
 * 补丁层工具的自检：验证清理与校验逻辑能拦住「空 insert」这类致命写入，
 * 并保证本插件写出的每一种注释在重装后都不会重复出现。
 * 用法: node tools/test-patch-layer.mjs
 */
import { strict as assert } from 'node:assert'
import { assertPatchLayer, collapseEmptyInserts, dropFamilyRows, parsePatchLayer } from './patch-layer.mjs'

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

/** 与 install.mjs 完全一致的写法：先整段清掉本插件痕迹，再追加一个新块。 */
const HEADER = '# ── 用户插件：像素风皮肤与用量看板（由 dsh-pixel-plugin/tools/install.mjs 写入）──'
const blockOf = (id, comment = '# 实现：lib/index.js · 构建指纹 1a2b3c4d') =>
  `${HEADER}\n# 卸载：node tools/uninstall.mjs；或删掉下面这个 insert 块。\n${comment}\n`
  + `- insert:\n    - id: ${id}\n      name: 'C:/x/lib/index.js'\n`

const oldBlock = blockOf('pixel-dashboard-libv2', '# 版本目录：lib-v2')
const newBlock = blockOf('pixel-dashboard')
/** 清空后重新写入的结果。 */
const rewrite = (existing) => `${collapseEmptyInserts(dropFamilyRows(existing))}\n\n${newBlock}`

console.log('patch-layer：清理')

check('清掉旧块后文件里不再有本插件痕迹', () => {
  const cleaned = collapseEmptyInserts(dropFamilyRows(oldBlock))
  assert.equal(cleaned, '', `应清空，实际 ${JSON.stringify(cleaned)}`)
})

check('重装只留一个块、一行', () => {
  const merged = rewrite(newBlock)
  const entries = parsePatchLayer(merged, 'test')
  assert.equal(entries.length, 1, '应只有一个补丁条目')
  assert.equal(entries[0].insert.length, 1, 'insert 里应只有一行')
  assert.equal(entries[0].insert[0].id, 'pixel-dashboard')
})

check('从早期版本目录升级上来时旧行整段消失', () => {
  const merged = rewrite(oldBlock)
  assert.ok(!merged.includes('libv2'), '不应残留旧版本行')
  assert.equal(parsePatchLayer(merged, 'test').length, 1, '应只剩一个补丁条目')
})

check('本插件写出的每一种注释在重装后都只出现一份', () => {
  // 这些是 install.mjs 可能写出的全部注释形态；漏认一种就会在补丁层里留下孤立的说明
  const variants = [
    HEADER,
    '# 卸载：node tools/uninstall.mjs；或删掉下面这个 insert 块。',
    '# 实现：lib/index.js · 构建指纹 1a2b3c4d',
    '# 触发热重载：00:14:48',
  ]
  const messy = `${variants.join('\n')}\n- insert:\n    - id: pixel-dashboard\n      name: 'C:/x/lib/index.js'\n`
  const merged = rewrite(messy)
  assert.equal((merged.match(/用户插件/g) ?? []).length, 1, '块首说明只应有一份')
  assert.equal((merged.match(/卸载：/g) ?? []).length, 1, '卸载提示只应有一份')
  assert.equal((merged.match(/# 实现：/g) ?? []).length, 1, '实现说明只应有一份')
  assert.ok(!merged.includes('触发热重载'), '调试时戳不该被带进正式补丁层')
})

check('Windows 反斜杠路径的说明也能清掉', () => {
  const windowsBlock = blockOf('pixel-dashboard')
    .replace('tools/install.mjs', 'tools\\install.mjs')
    .replace('node tools/uninstall.mjs', 'node tools\\uninstall.mjs')
  assert.equal(collapseEmptyInserts(dropFamilyRows(windowsBlock)), '', '反斜杠写法也应整段清掉')
})

check('用户自己的其它条目不受影响', () => {
  const text = `${oldBlock}\n- id: system-prompt\n  config:\n    personaPrefix: hi\n`
  const cleaned = collapseEmptyInserts(dropFamilyRows(text))
  assert.ok(cleaned.includes('- id: system-prompt'), '不应动别人的行')
  assert.ok(!cleaned.includes('pixel-dashboard'), '应删掉本插件的行')
  assert.ok(!/^[ \t]*- insert:\s*$/m.test(cleaned), '不应留下空 insert')
})

console.log('patch-layer：校验')

check('拦住空 insert（历史事故的形态）', () => {
  assert.throws(() => assertPatchLayer('- insert:\n', 'test.yml'), /空 insert/)
})

check('拦住顶层不是数组', () => {
  assert.throws(() => assertPatchLayer('id: foo\n', 'test.yml'), /顶层必须是数组/)
})

check('拦住非法 YAML', () => {
  assert.throws(() => assertPatchLayer('- insert:\n    - id: x\n   name: bad-indent\n', 'test.yml'), /不是合法 YAML/)
})

check('拦住 insert 里缺少 name 的行', () => {
  assert.throws(() => assertPatchLayer('- insert:\n    - id: x\n', 'test.yml'), /缺少 name/)
})

check('接受正常的覆盖条目与 insert 条目', () => {
  const text = '- id: system-prompt\n  config:\n    personaPrefix: hi\n- insert:\n    - id: a\n      name: \'x\'\n'
  assert.doesNotThrow(() => assertPatchLayer(text, 'test.yml'))
})

check('接受带 !!js 标签的产品写法', () => {
  const text = '- id: tools\n  config:\n    mode: !!js process.env.DSH_TOOLS_MODE\n'
  assert.doesNotThrow(() => assertPatchLayer(text, 'test.yml'))
})

check('空文件视为空补丁层', () => {
  assert.deepEqual(parsePatchLayer('   \n', 'test.yml'), [])
})

console.log(`\n${passed} 项检查通过`)
