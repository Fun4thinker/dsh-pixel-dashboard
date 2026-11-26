/** Semantic UI regressions with real React SSR; not browser/visual verification. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
const root=[process.env.DSH_CHECKOUT,'E:/deepseek-harness','D:/deepseek-harness'].filter(Boolean).find((path)=>existsSync(join(path,'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')))
if(!root) throw new Error('Set DSH_CHECKOUT to React 18.3.1 test dependencies')
const base=join(root,'node_modules/.pnpm')
const react=pathToFileURL(join(base,'react@18.3.1/node_modules/react/index.js')).href
const dom=pathToFileURL(join(base,'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js')).href
register(`data:text/javascript,${encodeURIComponent(`const aliases=new Map(${JSON.stringify([['react',react],['react-dom',dom]])});export async function resolve(s,c,n){const url=aliases.get(s);return url?{url,shortCircuit:true}:n(s,c)}`)}`,import.meta.url)
const React=(await import(react)).default
const {renderToStaticMarkup}=await import(pathToFileURL(join(base,'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js')).href)
const source=process.argv.includes('--built')?'lib/client':'src/client'
const {sessionCostModel,SessionCostPanel,SessionCostView}=await import(pathToFileURL(resolve(source,'sessionView.js')).href)
const {TimingBreakdownView}=await import(pathToFileURL(resolve(source,'sessionDetailView.js')).href)
let passed=0
function check(name,fn){try{fn();passed++;console.log(`  ✓ ${name}`)}catch(error){process.exitCode=1;console.error(`  ✗ ${name}: ${error.message}`)}}
check('a loaded session is not reported as executing without a real runtime status',()=>{
 const model=sessionCostModel({session:{id:'loaded-idle',title:'已加载会话',live:true,totals:{},cost:{standard:0}},entries:[],days:[]})
 const html=renderToStaticMarkup(React.createElement(SessionCostPanel,{model}))
 assert.ok(!html.includes('进行中'),'loaded presence was mislabeled as active execution')
})
check('legacy complete-message timestamps do not claim that token generation was measured as zero',()=>{
 const html=renderToStaticMarkup(React.createElement(TimingBreakdownView,{timing:{ttftMs:10000,genMs:1,toolsMs:1000,totalMs:11001,steps:1}}))
 assert.ok(!html.includes('模型回复'),'final message arrival is not first-token timing')
 assert.ok(html.includes('模型调用'),'unsegmented request time must be named honestly')
})
check('verified runtime states are distinct and unknown status remains unasserted',()=>{
 for(const [state,label] of [['running','运行中'],['idle','空闲'],['inactive','未运行']]){
  const model=sessionCostModel({session:{id:'a',live:true,runtimeStatus:state,running:state==='running',totals:{},cost:{standard:0}},entries:[],days:[]})
  const html=renderToStaticMarkup(React.createElement(SessionCostPanel,{model}))
  assert.ok(html.includes(label),`missing ${state} status`)
 }
 const model=sessionCostModel({session:{id:'a',live:true,runtimeStatus:'unknown',running:null,totals:{},cost:{standard:0}},entries:[],days:[]})
 assert.equal(model.runtimeBadge,undefined)
})
check('small nonzero processing is not rounded into 0 percent and stream coverage stays explicit',()=>{
 const html=renderToStaticMarkup(React.createElement(TimingBreakdownView,{timing:{modelMs:10000,otherMs:1,toolsMs:1000,steps:5,responseSteps:4,streamedSteps:2,firstOutputSteps:3,firstOutputWaitMs:6000,streamedMs:4000}}))
 assert.ok(html.includes('&lt;1%'))
 assert.ok(html.includes('2/4 步有接收区间') && html.includes('3/4 步有首输出时刻'))
 assert.ok(html.includes('缺测不补零'))
 const unknown=renderToStaticMarkup(React.createElement(TimingBreakdownView,{timing:{modelMs:10000,steps:1,responseSteps:1,streamedSteps:0,firstOutputSteps:0,firstOutputWaitMs:null,streamedMs:null}}))
 assert.ok(unknown.includes('0/1 步有接收区间') && unknown.includes('—'))
})
check('native session status overrides cached running and exposes pending interaction without polling finance',()=>{
 const data={session:{id:'a',title:'原会话',live:true,running:true,runtimeStatus:'running',totals:{},cost:{standard:0}},entries:[],days:[]}
 const render=(status)=>renderToStaticMarkup(React.createElement(SessionCostView,{sessionId:'a',data,useSessionStatus:(selector)=>selector(new Map([['a',status]]))}))
 const idle=render({running:false,pendingInteraction:undefined})
 assert.ok(idle.includes('空闲') && !idle.includes('运行中'))
 const pending=render({running:true,pendingInteraction:{key:'q',kind:'question',sessionId:'a'}})
 assert.ok(pending.includes('待你处理') && !pending.includes('运行中'))
})
check('an available but uninitialized native status never resurrects cached running',()=>{
 const data={session:{id:'a',live:true,running:true,runtimeStatus:'running',totals:{},cost:{standard:0}},entries:[],days:[]}
 for(const snapshot of [new Map(),new Map([['a',{running:undefined,pendingInteraction:undefined}]])]){
  const html=renderToStaticMarkup(React.createElement(SessionCostView,{sessionId:'a',data,useSessionStatus:(selector)=>selector(snapshot)}))
  assert.ok(!html.includes('运行中'),'unknown native status fell back to cached running')
 }
})
check('team fee tab headlines include lead and worker, not just the selected session',()=>{
 const lead={id:'a',name:'lead',role:'lead',cost:{standard:2},completedTurns:1,completedTurnMs:2000,toolCalls:2}
 const worker={id:'b',name:'researcher',role:'teammate',cost:{standard:3},completedTurns:1,completedTurnMs:3000,toolCalls:5}
 // 并行重叠：成员各自 2s/3s，但两人同时开工，团队只过了 3s。
 const team={leadId:'a',members:[lead,worker],cost:{standard:5},totals:{local:5000,requests:4},busyMs:3000,busyMembers:2}
 for(const session of [lead,worker]){
  const model=sessionCostModel({session,entries:[{cost:session.cost}],team})
  assert.equal(model.heroes.find(hero=>hero.key==='cost')?.value,'¥5.00')
  // 用时取并集（3s），不是 2s+3s=5s：并行重叠只算一次。
  assert.deepEqual(model.heroes.map(hero=>hero.value),['¥5.00','5.0K','3s','7 次'])
  const html=renderToStaticMarkup(React.createElement(SessionCostView,{sessionId:session.id,data:{session,entries:[{cost:session.cost}],team}}))
  const start=html.indexOf('成员费用明细'), end=html.indexOf('当前会话明细')
  assert.ok(start>0 && end>start && html.indexOf('¥5.00')<start)
  const rows=html.slice(start,end).match(/<tbody>(.*?)<\/tbody>/s)?.[1].match(/<tr>.*?<\/tr>/gs)
  assert.equal(rows?.length,2)
  for(const [i,m] of [lead,worker].entries()){
   assert.ok(rows[i].includes(m.name) && rows[i].includes(i?'¥3.00':'¥2.00') && rows[i].includes(i?'3s':'2s'))
   assert.equal(rows[i].includes('当前会话'),m.id===session.id)
  }
  assert.equal(model.modelsTotal,session.cost.standard,'model detail remains session scoped')
 }
})
check('partial or legacy timing is distinct from measured zero, including external-only delegation',()=>{
 const lead={id:'l',name:'lead',role:'lead',completedTurns:1,completedTurnMs:0,cost:{standard:0},toolCalls:0}
 const external={id:'e',name:'external-reviewer'}
 const team={members:[lead],unmeteredMembers:[external],cost:lead.cost,totals:{local:0},busyMs:0,busyMembers:1}
 const model=sessionCostModel({session:lead,team})
 assert.deepEqual(model.heroes.map(hero=>hero.value),['¥0','0','0s','0 次'])
 const html=renderToStaticMarkup(React.createElement(SessionCostPanel,{model}))
 assert.ok(html.includes('已计入 1/2') && html.includes('仅 1/2 位成员有计时'))
 assert.ok(html.includes('external-reviewer') && html.includes('未提供') && html.includes('本地费用占比'))
 const legacy=sessionCostModel({session:lead,team:{leadId:'l',cost:lead.cost,totals:{local:0},members:[{id:'l'},{id:'w'}]}})
 assert.equal(legacy.heroes.find(hero=>hero.key==='timing').value,'—')
 assert.equal(legacy.heroes.find(hero=>hero.key==='tools').value,'—')
 assert.equal(legacy.team.members[1].amountText,'—')
 const solo=sessionCostModel({session:lead,entries:[{cost:lead.cost}],team:{members:[lead]}})
 assert.equal(solo.team,undefined)
 assert.equal(solo.heroes[0].label,'估算金额')
})
console.log(`\n${passed} metric semantic checks passed (${source})`)
