/** Regression: the actual open settings component must render, not crash its panel. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
const roots = [process.env.DSH_CHECKOUT, 'E:/deepseek-harness', 'D:/deepseek-harness'].filter(Boolean)
const root = roots.find((path) => existsSync(join(path, 'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')))
if (!root) throw new Error('Set DSH_CHECKOUT to the checkout providing React 18.3.1')
const modules = join(root, 'node_modules/.pnpm')
const react = pathToFileURL(join(modules, 'react@18.3.1/node_modules/react/index.js')).href
const dom = pathToFileURL(join(modules, 'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js')).href
register(`data:text/javascript,${encodeURIComponent(`
 const aliases = new Map(${JSON.stringify([['react', react], ['react-dom', dom]])})
 export async function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier)
  return url ? {url,shortCircuit:true} : nextResolve(specifier,context)
 }
`)}`, import.meta.url)
const React = (await import(react)).default
const { renderToStaticMarkup } = await import(pathToFileURL(join(modules, 'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js')).href)
const target = process.argv.includes('--built') ? 'lib/client/dashboard.js' : 'src/client/dashboard.js'
const { SettingsDialog } = await import(pathToFileURL(resolve(target)).href)
const liveUrl = process.argv.find((arg) => arg.startsWith('--live-url='))?.slice('--live-url='.length)
let data = { models: [], pricing: { rates: {} }, customRates: {} }
if (liveUrl) {
 const response = await fetch(liveUrl, { signal: AbortSignal.timeout(60_000) })
 if (!response.ok) throw new Error(`Live settings fixture failed: HTTP ${response.status}`)
 data = await response.json()
}
const props = { data, minTokens: 10_000_000, modelLimit: 5, trendDim: 'model', onClose: () => {} }
let passed = 0
function check(name, fn) {
 try { fn(); passed += 1; console.log(`  ✓ ${name}`) }
 catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
check('closed settings leaves no invisible modal or blocking mask', () => {
 assert.equal(renderToStaticMarkup(React.createElement(SettingsDialog, { ...props, open: false })), '')
})
check('opening settings renders its real default panel and all navigation without blank-screen exception', () => {
 const html = renderToStaticMarkup(React.createElement(SettingsDialog, { open: true }))
 assert.ok(html.includes('role="dialog"') && html.includes('aria-label="看板设置"'))
 assert.equal((html.match(/role="tab"/g) ?? []).length, 3)
 assert.ok(html.includes('关闭设置') && html.includes('px-modal-body'))
 assert.ok(html.includes('通知'), 'default notification controls must actually render')
})
for (const [initialTab, expected] of [['notify', '系统通知'], ['pricing', 'px-price'], ['display', '趋势默认维度']]) {
 check(`settings tab ${initialTab} renders its real content and selected state`, () => {
  const html = renderToStaticMarkup(React.createElement(SettingsDialog, { ...props, open: true, initialTab }))
  assert.ok(html.includes(expected), `missing ${initialTab} content`)
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.ok(html.includes('关闭设置'))
 })
}
check('invalid initial settings tab safely falls back to notifications', () => {
 const html = renderToStaticMarkup(React.createElement(SettingsDialog, { ...props, open: true, initialTab: 'missing' }))
 assert.ok(html.includes('系统通知'))
})
console.log(`\n${passed} settings checks passed (${target})`)
