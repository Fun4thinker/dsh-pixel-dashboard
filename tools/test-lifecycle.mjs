/**
 * 宿主路由生命周期的自检：**插件必须能在同一进程里被重新挂载**。
 *
 * ## 为什么单独一关
 *
 * `webServer.register()` 返回一个注销函数，注销时机由调用方负责。裸调 `register` 会把路由
 * 永久留在 webServer 上，而插件是**会被重新 apply 的**：
 *
 *   1) profile 开着 `patchReload: live`——插件行折叠时 Cordis 销毁 fiber 再重新 apply；
 *   2) 用户在插件管理器里启用/停用、切换设置，都会走同一条重建路径。
 *
 * 第二次 apply 时上一轮的 8 条路由仍在表里，register 于是在第一条上抛：
 *
 *   webserver: duplicate exact route "/dsh-pixel/version"
 *
 * 用户看到的是桌面端启动日志里「1 entry did not activate pixel-dashboard」——插件整块不激活，
 * 看板 / 费用条 / 时段指示灯一起消失。这个错**只在重新挂载时出现**，单跑一次 apply 的闸门
 * 永远绿，因此必须在这里显式跑「apply → 销毁 → 再 apply」。
 *
 * 用法: node tools/test-lifecycle.mjs
 */
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * 造一个 webServer 替身：行为与真实实现的关键约束一致——**重复路径必须抛错**。
 *
 * 少了这一条，漏注销的 bug 在测试里就看不见了（真实实现会抛，而宽松的替身不会）。
 * @returns {object} 替身。
 */
function makeWebServer() {
  const table = new Map()
  return {
    register(route) {
      if (table.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },
    size: () => table.size,
  }
}

const { default: plugin } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)

check('插件声明了 inject: [webServer]（否则 apply 时机不确定）', () => {
  assert.deepEqual(plugin.inject, ['webServer'])
})

check('注册 8 条路由，且全部随 fiber 销毁一起注销', () => {
  const webServer = makeWebServer()
  const disposers = []
  const ctx = {
    webServer,
    get: (name) => (name === 'webServer' ? webServer : undefined),
    on: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    // cordis 语义：effect 回调的返回值是 disposer，fiber 销毁时由框架调用。
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
  }
  plugin.apply(ctx)
  assert.equal(webServer.size(), 8, '应注册 8 条路由')
  assert.ok(disposers.length >= 8, `每条路由都应注册 disposer，实际 ${disposers.length}`)
  for (const dispose of disposers.splice(0)) dispose()
  assert.equal(webServer.size(), 0, 'fiber 销毁后路由必须清空——否则重新 apply 会撞重复路由')
})

check('同一进程里可以反复重新挂载（热重载 / 启用停用）', () => {
  const webServer = makeWebServer()
  const disposers = []
  const ctx = {
    webServer,
    get: (name) => (name === 'webServer' ? webServer : undefined),
    on: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
  }
  // 三轮：apply → 销毁。裸调 register 会在第二轮就抛 duplicate。
  for (let round = 1; round <= 3; round += 1) {
    assert.doesNotThrow(() => plugin.apply(ctx), `第 ${round} 轮 apply 不应抛错`)
    assert.equal(webServer.size(), 8, `第 ${round} 轮应有 8 条路由`)
    for (const dispose of disposers.splice(0)) dispose()
    assert.equal(webServer.size(), 0, `第 ${round} 轮销毁后应清空`)
  }
})

console.log(`\n${passed} 项检查通过`)