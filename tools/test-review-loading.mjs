/** Source-level UI regressions: real React SSR, not a visual/browser preview. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'

const candidates = [process.env.DSH_CHECKOUT, 'E:/deepseek-harness', 'D:/deepseek-harness'].filter(Boolean)
const root = candidates.find((path) => existsSync(join(path, 'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')))
if (!root) throw new Error('Set DSH_CHECKOUT to the checkout providing React 18.3.1 for tests')
const base = join(root, 'node_modules/.pnpm')
const react = pathToFileURL(join(base, 'react@18.3.1/node_modules/react/index.js')).href
const reactDom = pathToFileURL(join(base, 'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js')).href
register(`data:text/javascript,${encodeURIComponent(`
 const aliases = new Map(${JSON.stringify([['react', react], ['react-dom', reactDom]])})
 export async function resolve(specifier, context, nextResolve) {
   const url = aliases.get(specifier)
   return url ? {url, shortCircuit:true} : nextResolve(specifier, context)
 }
`)}`, import.meta.url)
const React = (await import(react)).default
const { renderToStaticMarkup } = await import(pathToFileURL(join(base, 'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js')).href)
const { ReviewSection, UsageHabits, ReviewView, ResourceLedger } = await import('../src/client/review.js')
const { REVIEW_CSS } = await import('../src/client/styles/review.js')
const { ActivityCalendar } = await import('../src/client/graph.js')
const { recentDays } = await import('../src/client/usage.js')
let passed = 0
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
check('cold/range-switch loading reserves resource rows instead of a short text card', () => {
  const html = renderToStaticMarkup(React.createElement(ReviewSection, { rangeDays: 7, rangeLabel: '7 日', revision: 1, timezone: 'Asia/Shanghai', page: 'resources' }))
  assert.ok(html.includes('px-review-skeleton'), 'missing stable skeleton; current loading is just a short note')
  assert.ok(html.includes('data-layout="resources"'), 'loading must reserve the selected page geometry')
  assert.equal((html.match(/px-review-skeleton-row/g) ?? []).length, 8)
})
check('habit activity defaults to conversation turns, not machine requests', () => {
  const data = { hours: [], weekHours: [], coverage: { timedSessions: 0, sessionCount: 0 }, timezone: 'Asia/Shanghai' }
  const html = renderToStaticMarkup(React.createElement(UsageHabits, { data, rangeLabel: '7 日' }))
  assert.ok(/aria-pressed="true"[^>]*>对话轮次</.test(html), 'default activity must be conversation turns')
  assert.ok(html.includes('人机对话'))
})
check('calendar intensity follows human turns even when one agent round runs hundreds of requests', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityCalendar, { firstDay:'2026-11-15',days:3,turns:[1,0,2],maxTurns:2,requests:[1,999,4],maxRequests:999 }))
  const levels = [...html.matchAll(/class="px-heat px-heat-(\d)"/g)].slice(0,3).map((m) => Number(m[1]))
  assert.deepEqual(levels,[3,0,4])
  assert.ok(html.includes('最深一天 2 轮对话') && !html.includes('999 次请求'))
  const points = recentDays([{ key:'2026-11-17',turns:1,totals:{requests:999} }],7)
  assert.equal(points.at(-1).turns,1)
  assert.equal(points.at(-2).turns,null)
})
check('loading geometry is reserved in CSS, not supplied by fake zero-valued data', () => {
  assert.ok(REVIEW_CSS.includes('.px-review-content { min-block-size: 480px; }'))
  assert.ok(/\.px-review-skeleton-row\s*\{[^}]*min-height:\s*66px/.test(REVIEW_CSS))
})
check('habit/resource pages render separately and lists paginate rather than expand unbounded', () => {
  const sessions = Array.from({length:17}, (_, i) => ({id:'session-'+i,title:'会话'+i,workspace:'project',archived:false,cost:17-i,turns:1,requests:10,durationMs:1000,completedTurns:1,toolCalls:0,models:[],days:[]}))
  const data = { scope:'recent',range:{days:7},timezone:'Asia/Shanghai',summary:{turns:17,sessionCount:17,durationMs:17000},coverage:{timedSessions:17,sessionCount:17},sessions,workspaces:[],tools:[],hours:[],weekHours:[] }
  const habits = renderToStaticMarkup(React.createElement(ReviewView,{data,rangeLabel:'7 日',page:'habits'}))
  const resources = renderToStaticMarkup(React.createElement(ReviewView,{data,rangeLabel:'7 日',page:'resources'}))
  assert.ok(habits.includes('一天中的使用分布') && !habits.includes('资源列表分页'))
  assert.ok(resources.includes('资源列表分页') && !resources.includes('一天中的使用分布'))
  const list = renderToStaticMarkup(React.createElement(ResourceLedger,{data,rangeLabel:'7 日',initialEntity:'sessions'}))
  assert.equal((list.match(/class="px-review-row"/g) ?? []).length,8)
  assert.ok(list.includes('1 / 3') && list.includes('下一页') && !list.includes('查看全部'))
})
console.log(`\n${passed} review loading/activity checks passed`)
