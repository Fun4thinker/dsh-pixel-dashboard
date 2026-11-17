/** Resource regressions against real React SSR; no browser/DOM or synthetic visual preview. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
const built = process.argv.includes('--built')
const { WorkspaceAccount, ResourceLedger, SessionAccount, rankReviewRows } = await import(built ? '../lib/client/review.js' : '../src/client/review.js')
const { REVIEW_CSS } = await import(built ? '../lib/client/styles/review.js' : '../src/client/styles/review.js')
let passed = 0
function check(name, fn) {
 try { fn(); passed += 1; console.log(`  ✓ ${name}`) }
 catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
const sessions = [
 { id:'old',title:'OLD_SESSION',activityAt:9,cost:100,tokens:300,requests:3,durationMs:2000 },
 { id:'new',title:'NEW_SESSION',activityAt:100,cost:1,tokens:200,requests:2,durationMs:5000 },
 { id:'missing',title:'MISSING_SESSION',activityAt:null,cost:1000,tokens:100,requests:1,durationMs:null },
].map((row) => ({ ...row, archived:false,turns:1,completedTurns:1,toolCalls:0,models:[],days:[] }))
const data = { scope:'recent',range:{days:7},timezone:'Asia/Shanghai',summary:{},coverage:{},sessions,tools:[],workspaces:[] }
const workspace = {id:'/repo',path:'/repo',sessionIds:sessions.map((row) => row.id)}
const render = (component, props) => renderToStaticMarkup(React.createElement(component,props))
function orderOf(html, expected) {
 const positions = expected.map((title) => html.indexOf(title))
 assert.ok(positions.every((position) => position >= 0), 'all expected sessions must render')
 assert.deepEqual([...positions].sort((a,b)=>a-b),positions,`expected session order ${expected.join(', ')}`)
}
check('workspace sessions default to numeric most-recent activity, never cost or display text', () => {
 const html = render(WorkspaceAccount,{row:workspace,data})
 orderOf(html,['NEW_SESSION','OLD_SESSION','MISSING_SESSION'])
 assert.ok(html.includes('工作区内会话排序') && html.includes('最近使用'))
})
check('workspace session ledger uses full available width and aligned metric column headings', () => {
 const html = render(WorkspaceAccount,{row:workspace,data})
 assert.ok(html.includes('px-review-child-head'), 'missing aligned column header')
 for (const label of ['会话','最近使用','费用','有效时长','Token']) assert.ok(html.includes(label))
 assert.ok(/\.px-review-child\s*\{[^}]*width:\s*100%/.test(REVIEW_CSS),'native button must not shrink to its content width')
 assert.ok(html.includes('data-label="Token"') && html.includes('data-label="最近使用"'),'mobile rows retain metric labels')
})
check('workspace column headings are native sort buttons with clear current and next direction', () => {
 const html=render(WorkspaceAccount,{row:workspace,data})
 const head=html.slice(html.indexOf('px-review-child-head'),html.indexOf('px-review-child-item'))
 assert.ok(head.includes('<button')&&head.includes('最近使用，当前降序，点击切换为升序'))
 assert.ok(head.includes('费用，点击按费用降序排列')&&head.includes('模型请求，点击按模型请求降序排列'))
 assert.ok(head.includes('↓')&&!html.includes('px-review-choices'),'workspace sorting belongs to column headings, not duplicate chips')
 const ascending=render(WorkspaceAccount,{row:workspace,data,initialDirection:'asc'})
 orderOf(ascending,['OLD_SESSION','NEW_SESSION','MISSING_SESSION'])
 assert.ok(ascending.includes('最近使用，当前升序，点击切换为降序')&&ascending.includes('↑'))
})
check('narrow session layouts keep sortable headings available instead of hiding the only sort controls', () => {
 assert.ok(REVIEW_CSS.includes('.px-review-sort-heading'))
 assert.ok(!/\.px-review-child-head\s*\{\s*display:\s*none/.test(REVIEW_CSS),'mobile must not hide clickable column headings')
 assert.ok(REVIEW_CSS.includes('@container px-review-workspace'))
 const html=render(WorkspaceAccount,{row:workspace,data})
 assert.ok(html.includes('data-label="模型请求"')&&html.includes('模型请求，点击按模型请求降序排列'))
})
check('top-level sessions default to recent activity and expose the same manual sorting choices', () => {
 const html = render(ResourceLedger,{data,rangeLabel:'7 日',initialEntity:'sessions'})
 orderOf(html,['NEW_SESSION','OLD_SESSION','MISSING_SESSION'])
 for (const label of ['最近使用','费用','有效时长','Token','模型请求']) assert.ok(html.includes(label))
 assert.ok(!html.includes('占当前列表'), 'timestamps are not resource shares')
})
check('top-level session sorting uses heading buttons with direction, while workspace and tools keep their controls', () => {
 const props={data,rangeLabel:'7 日',initialEntity:'sessions'}
 const html=render(ResourceLedger,props)
 assert.ok(html.includes('会话列头排序') && html.includes('最近使用，当前降序，点击切换为升序'))
 assert.ok(!html.includes('aria-label="资源排行排序"'),'session cards must not duplicate old sorting chips')
 const ascending=render(ResourceLedger,{...props,initialDirection:'asc'})
 orderOf(ascending,['OLD_SESSION','NEW_SESSION','MISSING_SESSION'])
 assert.ok(ascending.includes('最近使用，当前升序，点击切换为降序'))
 for(const initialEntity of ['workspaces','tools']) assert.ok(render(ResourceLedger,{...props,initialEntity}).includes('aria-label="资源排行排序"'))
})
check('numeric sorting keeps missing values last, legitimate zero and deterministic ties', () => {
 const rows = [{id:'zero',activityAt:0,cost:0},{id:'blank',activityAt:'',cost:900},{id:'missing',activityAt:null},{id:'nan',activityAt:NaN},{id:'older',activityAt:9},{id:'newer',activityAt:100},{id:'tie-b',activityAt:100},{id:'tie-a',activityAt:100}]
 const sorted = rankReviewRows(rows,'activityAt').map((row)=>row.id)
 assert.deepEqual(sorted.slice(0,5),['newer','tie-a','tie-b','older','zero'])
 assert.ok(sorted.indexOf('blank') > sorted.indexOf('zero'))
 assert.deepEqual(rankReviewRows([...rows].reverse(),'activityAt').map((row)=>row.id),sorted)
 assert.equal(rankReviewRows([{id:'missing',cost:null},{id:'credit',cost:-5}],'cost')[0].id,'credit')
})
check('ascending and descending sorts both leave unknown values last and keep stable ties', () => {
 const rows=[{id:'high',tokens:9,cost:1},{id:'zero',tokens:0,cost:2},{id:'low',tokens:-2,cost:1},{id:'missing',tokens:null,cost:100},{id:'blank',tokens:'',cost:90},{id:'tie-b',tokens:9,cost:1},{id:'tie-a',tokens:9,cost:1}]
 assert.deepEqual(rankReviewRows(rows,'tokens','asc').map((row)=>row.id),['low','zero','high','tie-a','tie-b','missing','blank'])
 assert.deepEqual(rankReviewRows(rows,'tokens','desc').map((row)=>row.id),['high','tie-a','tie-b','zero','low','missing','blank'])
 assert.deepEqual(rankReviewRows([...rows].reverse(),'tokens','asc').map((row)=>row.id),rankReviewRows(rows,'tokens','asc').map((row)=>row.id))
})
check('expanded session displays real Lead/member resource rows without replacing its own receipt', () => {
 const row={...sessions[1],teamId:'team-a'}
 const team={id:'team-a',leadId:'old',leadKnown:true,leadInScope:true,knownMemberCount:2,windowMemberCount:2,visibleMemberCount:2,hiddenMemberCount:0,outsideWindowMemberCount:0,cost:101,tokens:500,requests:5,durationMs:7000,wallMs:8000,awaitingUserMs:1000,timedMemberCount:2,members:[{...sessions[0],role:'lead',name:'OLD_LEAD',depth:0},{...sessions[1],role:'teammate',name:'worker-team',depth:2}]}
 const html=render(SessionAccount,{row,data:{...data,teams:[team]}})
 assert.ok(html.includes('团队成员消耗'),'team attribution is missing')
 assert.ok(html.includes('OLD_LEAD')&&html.includes('worker-team')&&html.includes('Lead')&&html.includes('第 2 层'))
 assert.ok(html.includes('当前范围有 2/2 位'))
 assert.ok(html.includes('继承历史')&&html.includes('不代表子会话新增支出'))
 const own=html.slice(html.indexOf('px-review-session-receipt'),html.indexOf('px-review-account-grid'))
 assert.ok(!own.includes('101'),'team total must not overwrite own receipt')
 assert.ok(!render(SessionAccount,{row:sessions[1],data:{...data,teams:[team]}}).includes('团队成员消耗'),'ordinary sessions must not inherit unrelated teams')
})
check('workspace manual sorts use the chosen numeric metric and expanded details stay inside their row', () => {
 const cases={activityAt:['NEW_SESSION','OLD_SESSION','MISSING_SESSION'],cost:['MISSING_SESSION','OLD_SESSION','NEW_SESSION'],durationMs:['NEW_SESSION','OLD_SESSION','MISSING_SESSION'],tokens:['OLD_SESSION','NEW_SESSION','MISSING_SESSION'],requests:['OLD_SESSION','NEW_SESSION','MISSING_SESSION']}
 for(const [initialSessionSort,expected] of Object.entries(cases)) orderOf(render(WorkspaceAccount,{row:workspace,data,initialSessionSort}),expected)
 const html=render(WorkspaceAccount,{row:workspace,data,initialSessionSort:'cost',initialExpanded:'old'})
 assert.ok(html.indexOf('OLD_SESSION')<html.indexOf('本会话估算')&&html.indexOf('本会话估算')<html.indexOf('NEW_SESSION'))
 assert.ok(html.includes('aria-controls="px-review-child-%2Frepo-old"')&&html.includes('id="px-review-child-%2Frepo-old"'))
})
check('sorted pagination never leaves an expanded session detached from its page', () => {
 const many=Array.from({length:17},(_,index)=>({...sessions[1],id:'item-'+index,title:'TITLE_'+String(index).padStart(2,'0'),activityAt:100+index,cost:index}))
 const props={data:{...data,sessions:many},rangeLabel:'7 日',initialEntity:'sessions',initialExpanded:'item-4'}
 const first=render(ResourceLedger,props)
 assert.equal((first.match(/class="px-review-row"/g)??[]).length,8)
 assert.ok(!first.includes('本会话估算')&&first.includes('1 / 3'))
 const second=render(ResourceLedger,{...props,initialPageIndex:1})
 assert.equal((second.match(/class="px-review-row"/g)??[]).length,8)
 assert.ok(second.includes('2 / 3')&&second.indexOf('TITLE_04')<second.indexOf('本会话估算')&&second.indexOf('本会话估算')<second.indexOf('TITLE_03'))
 assert.ok(!second.includes('TITLE_16'))
})
check('resources keep three useful heroes and omit standing waiting-user numbers from session and team details', () => {
 const waiting=34260000
 const row={...sessions[1],teamId:'team',awaitingUserMs:waiting,wallMs:waiting+5000}
 const team={id:'team',members:[{...row,name:'Lead',role:'lead'}],cost:1,tokens:200,requests:2,durationMs:5000,wallMs:waiting+5000,awaitingUserMs:waiting,timedMemberCount:1,leadKnown:true,leadInScope:true}
 const fixture={...data,sessions:[row],teams:[team],summary:{cost:1,sessionCount:1,turns:1,requests:2,durationMs:5000,awaitingUserMs:waiting,wallMs:waiting+5000}}
 const ledger=render(ResourceLedger,{data:fixture,rangeLabel:'7 日',initialEntity:'sessions'})
 assert.equal((ledger.match(/class="px-hero px-hero-/g)??[]).length,3)
 assert.ok(!ledger.includes('等待用户（估算）'))
 const details=render(SessionAccount,{row,data:fixture})
 assert.ok(!details.includes('已排除等待用户')&&!details.includes('已扣等待')&&!details.includes('9h31m'))
 assert.ok(details.includes('有效处理已排除问答区间（近似）'))
 assert.ok(details.includes('计时覆盖 1/1'))
})
check('partial team view discloses hidden Lead/archive members and leaves all-unknown timing unknown', () => {
 const member={...sessions[1],role:'teammate',name:'ONLY_VISIBLE_MEMBER',durationMs:null,wallMs:null,awaitingUserMs:null}
 const team={id:'a',members:[member],leadKnown:true,leadInScope:false,knownMemberCount:4,windowMemberCount:3,visibleMemberCount:1,hiddenMemberCount:2,outsideWindowMemberCount:1,cost:1,tokens:200,requests:2,durationMs:null,wallMs:null,awaitingUserMs:null,timedMemberCount:0}
 const html=render(SessionAccount,{row:{...member,teamId:'a'},data:{...data,teams:[team]}})
 const section=html.slice(html.indexOf('px-review-team-account'))
 assert.ok(section.includes('当前范围有 1/3 位')&&section.includes('窗口全部（含归档）'))
 assert.ok(section.includes('Lead 不在当前范围')&&section.includes('时间窗口外'))
 assert.ok(section.includes('计时覆盖 0/1')&&section.includes('—')&&!section.includes('0s'))
})
console.log(`\n${passed} resource UI checks passed`)
