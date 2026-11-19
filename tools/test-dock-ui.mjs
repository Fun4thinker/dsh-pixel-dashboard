/** Real React structural regressions, not a browser or visual preview. */
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
const {SessionCostView,CostDetailPanel,detailPanelPlacement}=await import(pathToFileURL(resolve(source,'SessionCost.js')).href)
const {accountDetailModel,timeDetailModel}=await import(pathToFileURL(resolve(source,'dockDetail.js')).href)
let passed=0
function check(name,fn){try{fn();passed++;console.log(`  ✓ ${name}`)}catch(error){process.exitCode=1;console.error(`  ✗ ${name}: ${error.message}`)}}
check('account beside the fee estimate is a real independent card trigger, not a bare native tooltip',()=>{
 const html=renderToStaticMarkup(React.createElement(SessionCostView,{cost:{standard:1,peak:1,idle:0},showTokens:false,account:{kind:'balance',label:'余额',text:'¥115.00',payload:{balances:[{currency:'CNY',total:115}]}}}))
 assert.ok(/<button[^>]*aria-label="余额 ¥115.00，展开账户详情"/.test(html))
 assert.match(html,/<span class="px-pill-label">余额<\/span><b class="px-pill-value">¥115\.00<\/b>/)
 assert.equal((html.match(/aria-expanded="false"/g)??[]).length,2)
 assert.ok(!html.includes('px-detail-anchor'),'closed cards must not occupy the dock layout')
})
check('composer quota badge keeps the remaining descriptor with the provider and the value numeric',()=>{
 const render=(window)=>renderToStaticMarkup(React.createElement(SessionCostView,{cost:{standard:1,peak:1,idle:0},showTokens:false,account:{kind:'plan',label:'CC',plan:{window}}}))
 const percent=render({usedPercent:28})
 assert.match(percent,/<button[^>]*aria-label="CC剩余 72%，展开账户详情"/)
 assert.match(percent,/<span class="px-pill-label">CC剩余<\/span><b class="px-pill-value">72%<\/b>/)
 assert.match(render({remaining:65.55,unit:'$'}),/<span class="px-pill-label">CC剩余<\/span><b class="px-pill-value">\$65\.55<\/b>/)
 const over=render({usedPercent:140})
 assert.match(over,/<span class="px-pill-label">CC<\/span><b class="px-pill-value">已超限<\/b>/)
 assert.match(over,/class="px-pill-dot px-tone-bg-red"/)
})
check('quota popover fills the meter by the remaining percentage, not the used percentage',()=>{
 const window={label:'5 小时',used:28,total:100,unit:'$'}
 const model=accountDetailModel({account:{kind:'plan',label:'CC',plan:{window}}})
 const html=renderToStaticMarkup(React.createElement(CostDetailPanel,{model}))
 assert.match(html,/class="px-detail-headline">剩余 72%</)
 assert.match(html,/class="px-detail-meter-fill[^"\n]*" style="width:72%"/)
 assert.ok(html.includes('剩余比例') && html.includes('剩余额度') && !html.includes('已用'))
})
check('fee card defaults to cost while its secondary time tab renders completed timing',()=>{
 const model={title:'本次会话',tone:'pink',headline:'¥9.00',sections:[{label:'分时计价',rows:[]}],notes:[],empty:false}
 const timeModel={title:'本会话时间',tone:'green',headline:'2s',sections:[{label:'已完成执行',rows:[{label:'等待用户（近似）',value:'1h'}]}],notes:[],empty:false}
 const cost=renderToStaticMarkup(React.createElement(CostDetailPanel,{model,timeModel}))
 assert.equal((cost.match(/role="tab"/g)??[]).length,2)
 assert.ok(cost.includes('分时计价') && !cost.includes('等待用户（近似）'))
 const time=renderToStaticMarkup(React.createElement(CostDetailPanel,{model,timeModel,initialTab:'time'}))
 assert.ok(time.includes('本会话时间') && time.includes('等待用户（近似）') && !time.includes('分时计价'))
 assert.ok(/aria-selected="true"[^>]*>时间</.test(time))
})
check('a tall account card does not flip below the anchor and clip beyond a short viewport',()=>{
 const style=detailPanelPlacement({rect:{top:180,bottom:204,left:100,width:100},panelHeight:400,viewportWidth:800,viewportHeight:500})
 assert.equal(style.top,'12px')
 const narrow=detailPanelPlacement({rect:{top:400,bottom:424,left:300,width:20},panelHeight:200,viewportWidth:320,viewportHeight:600})
 assert.equal(narrow.width,'296px')
 assert.equal(narrow.left,'12px')
})
const liveBase=process.argv.find((value)=>value.startsWith('--live-base='))?.slice('--live-base='.length)
if(liveBase){
 const load=async(path)=>{const response=await fetch(liveBase+path,{signal:AbortSignal.timeout(60_000)});if(!response.ok)throw new Error(`Live card fixture HTTP ${response.status}`);return response.json()}
 const [data,balance,plans]=await Promise.all(['/dsh-pixel/data','/dsh-pixel/balance','/dsh-pixel/plans'].map(load))
 const {resolveAccount}=await import(pathToFileURL(resolve(source,'account.js')).href)
 const {providerById}=await import(pathToFileURL(resolve(source,'plans.js')).href)
 check('cards render real current service data without missing-number text or exceptions',()=>{
  const account=resolveAccount({balance,plans})
  const accountModel=accountDetailModel({account,provider:providerById(plans,account.planId),timezone:data.timezone})
  const team=data.teams?.[0]
  const row=data.sessions?.find((session)=>session.id===team?.leadId) ?? data.sessions?.[0]
  for(const model of [accountModel,timeDetailModel({row,team,sessions:data.sessions})]){
   const html=renderToStaticMarkup(React.createElement(CostDetailPanel,{model}))
   assert.ok(!/NaN|Infinity|undefined/.test(html))
   if(!model.empty) assert.ok(html.includes('role="dialog"'))
  }
 })
}
console.log(`\n${passed} dock UI checks passed (${source})`)
