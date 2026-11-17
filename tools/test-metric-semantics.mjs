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
console.log(`\n${passed} metric semantic checks passed (${source})`)
