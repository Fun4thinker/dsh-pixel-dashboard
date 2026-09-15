/**
 * 一键校验：构建 + 全套闸门。
 *
 * 顺序很重要——先构建，再校验产物：所有断言都针对 `lib/` 里真正会被发布/部署的东西，
 * 而不是 `src/` 源码。针对源码的断言会让「构建漏了某个文件」这类问题溜过去。
 *
 * 用法: node tools/verify.mjs
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 依次执行各步骤，任一步失败即中止。 */
const STEPS = [
  ['构建可发布包（tools/build.mjs）', 'build.mjs'],
  ['时段 / 价目 / 账本逻辑（tools/test.mjs）', 'test.mjs'],
  ['补丁层清理与校验（tools/test-patch-layer.mjs）', 'test-patch-layer.mjs'],
  ['宿主预检 + 非空数据闸门（tools/preflight.mjs）', 'preflight.mjs'],
  ['客户端渲染闸门（tools/render-check.mjs）', 'render-check.mjs'],
  // 真实 DOM 闸门放在最后：它验的是「东西被放到哪里去了」。服务端渲染那一关拿不到
  // DOM，只能查源码字符串，而这块连续踩过两次「代码看着对、产出的 DOM 是错的」。
  // 因此单独用 jsdom 真的渲染一遍（依赖 jsdom；拿不到它会明确报错，不静默跳过）。
  ['真实 DOM 闸门 · jsdom（tools/dom-check.mjs）', 'dom-check.mjs'],
]

let failed = 0
for (const [label, script] of STEPS) {
  process.stdout.write(`\n▶ ${label}\n`)
  try {
    execFileSync(process.execPath, [join(here, script)], { stdio: 'inherit' })
  } catch {
    failed += 1
    console.error(`✗ 失败：${label}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个步骤失败。`)
  process.exit(1)
}
console.log(`\n全部 ${STEPS.length} 个步骤通过。`)
